import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { type Database as DatabaseInstance } from 'better-sqlite3';
import { LeanCheckCache } from '@lale/cache';
import {
  AcceptedRunResponse,
  AcceptedProvisionResponse,
  AuditRunStatus,
  CreateProjectRequest,
  ExtensionClaimStatus,
  FaithfulnessVerdict,
  HealthResponse,
  ProjectLookupRequest,
  ProjectLookupResponse,
  ProviderConfigsResponse,
  ProvisionRequest,
  RunPhase,
  RunResult,
  VerificationRequest,
  VerificationOutcome,
} from '@lale/protocol';
import type { ProviderConfigSummary } from '@lale/protocol';
import { parseLatexDocument } from '@lale/document-parser';
import { openDb } from './db.js';
import type { ProjectRow, AuditRunRow, ProviderConfigRow } from './db.js';
import {
  getOrCreateToken, checkAuth, isOriginAllowed, sendUnauthorized, sendForbidden,
  readPairedOrigins, recordPairedOrigin, normalizeOrigin, setServicePort, DEFAULT_PORT,
} from './auth.js';
import { Logger } from './logging.js';
import { PairingBroker, PairingAlreadyPendingError, approveFromTerminal } from './pairing.js';
import {
  acknowledgeInformalAudit,
  DEFAULT_TOKEN_BUDGET_CAP,
  DEFAULT_WALL_CLOCK_CAP_MS,
  InformalAuditNotFoundError,
  runPipeline,
  subscribeSse,
} from './pipeline/run.js';
import { clearMathlibImportIndexCache } from './pipeline/mathlib-index.js';
import {
  setProvisionLogSink,
  startProvision,
  subscribeProvisionSse,
  getProvisionState,
  getPastEvents,
  inspectProvisionedProject,
  initProjectDir,
  killActiveProvisionChildren,
  ProvisionAlreadyRunningError,
} from './provisioning.js';
import {
  DEFAULT_OPENROUTER_BASE_URL,
  OPENROUTER_KEY_REF,
  defaultProviderConfigSpecs,
} from './model-config.js';

// ---------------------------------------------------------------------------
// Provider registry — OpenRouter only, for all three roles, behind one stored key
// ---------------------------------------------------------------------------

// Effort and model come from the stored rows; nothing about the provider is
// worth hardcoding beyond its name — a fixed label goes stale the moment a
// default changes, as "Extra High" did when the formalizer dropped to high.
const PROVIDER_NAME = 'OpenRouter';

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// The extension reaches the service at a fixed address: `DEFAULT_PORT` is
// baked into the manifest's `host_permissions` and into the panel's base URL,
// neither of which can follow an override at runtime. `PORT` is therefore for
// running a second service alongside the first, and startup says so.
const PORT = Number.parseInt(process.env['PORT'] ?? String(DEFAULT_PORT), 10);
// Supplied by the app shell, which knows the bundle's version; a terminal run
// says so plainly rather than claiming a release number it does not have.
const VERSION = process.env['LALE_VERSION'] ?? '0.0.0-dev';
// Track a recent stable release rather than an old one: Mathlib's cache moved
// to trust-scoped storage containers, and the bare container that pre-4.2x
// clients read from is now labelled `legacy` and slated for retirement. Once
// its public reads are revoked, an old pin stops hitting the cache and every
// provision compiles Mathlib from source (spec §4 names the cache as
// load-bearing for the zero-cost claim). A recent pin also keeps Mathlib's API
// close to what the formalizer model writes.
const DEFAULT_LEAN_VERSION = '4.33.1';
// Mathlib revision must match the Lean toolchain exactly — tag vX.Y.Z carries
// `lean-toolchain` = leanprover/lean4:vX.Y.Z. The literal string "latest" is
// not a tag and cache-misses against the community CDN.
const DEFAULT_MATHLIB_REVISION = 'v4.33.1';

// Built before anything that might want to report: a line written during
// startup belongs in the file a tester is asked to send, not on a stdout the
// packaged app has nowhere to show.
const log = new Logger();

const db = openDb();
const cache = new LeanCheckCache(db);
// The token is never printed: a packaged app has no terminal to print it to,
// and the extension now asks to pair instead of being handed a secret to carry.
const bearerToken = getOrCreateToken(db);
const leanProjectDir = process.env['LALE_LEAN_PROJECT_DIR'] ?? join(homedir(), '.lale', 'lean-project');
initProjectDir(leanProjectDir);
markInterruptedRuns(db, log);
dropPinnedVersionsFromProjectSettings(db);

export const pairing = new PairingBroker();
let pairedOrigins = readPairedOrigins(db);

log.info('─'.repeat(60));
log.info(`lale desktop service ${VERSION} starting`);
log.info(`Port:         ${PORT}`);
log.info(`DB:           ${process.env['LALE_DATA_DIR'] ?? join(homedir(), '.lale')}/lale.db`);
log.info(`Lean project: ${leanProjectDir}`);
log.info(`Log file:     ${log.filePath}`);
log.info(`Paired:       ${pairedOrigins.size > 0 ? [...pairedOrigins].join(', ') : 'nothing yet — the extension will ask'}`);
if (PORT !== DEFAULT_PORT) {
  log.info(`Note:         the extension only ever looks at port ${DEFAULT_PORT}, so it will not find this one.`);
}
log.info('─'.repeat(60));
setServicePort(PORT);

// Without an app shell there is no window to prompt in, so a terminal session
// approves its own pairing requests. A packaged build registers a real approver
// over the top of this one.
if (process.stdout.isTTY) pairing.setApprover(approveFromTerminal((message) => log.info(message)));

// Provisioning is long, unattended, and the thing most likely to go wrong on a
// machine that is not this one; its events belong in the log file.
setProvisionLogSink((level, message) => {
  if (level === 'error') log.error(message);
  else log.info(message);
});

// When the service runs as a child of the macOS shell, approval travels over
// the IPC channel: the shell shows the prompt, a person answers, the decision
// comes back. Running the service in its own process also keeps a native-module
// fault away from the menu bar, and lets the shell restart it.
if (typeof process.send === 'function') {
  const waiting = new Map<string, (decision: 'approved' | 'denied') => void>();

  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null) return;
    const { type, requestId, decision } = message as Record<string, unknown>;
    if (type !== 'pairing-decision' || typeof requestId !== 'string') return;
    waiting.get(requestId)?.(decision === 'approved' ? 'approved' : 'denied');
    waiting.delete(requestId);
  });

  pairing.setApprover(async (request) => new Promise((resolve) => {
    waiting.set(request.requestId, (decision) => {
      log.info(`Pairing decision for ${request.origin}: ${decision}`);
      resolve(decision);
    });
    process.send?.({ type: 'pairing-request', ...request });
  }));
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  // CORS — only echo back the origin for allowed origins to prevent DNS-rebinding.
  const origin = req.headers['origin'] ?? '';
  if (isOriginAllowed(origin, pairedOrigins) || new URL(req.url ?? '/', 'http://127.0.0.1').pathname === '/v1/pair') {
    res.setHeader('access-control-allow-origin', origin || '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type,authorization');
    res.setHeader('vary', 'origin');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Auth check.
  const auth = checkAuth(req, bearerToken, pairedOrigins);
  if (!auth.ok) {
    const reason = auth.reason ?? 'Unauthorized';
    if (reason.includes('Origin')) {
      sendForbidden(res, reason);
    } else {
      sendUnauthorized(res, reason);
    }
    return;
  }

  try {
    await route(req, res);
  } catch (err) {
    log.error(`Unhandled error: ${String(err)}`);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`Port ${PORT} is already in use — another lale desktop is probably running. Quit it and try again.`);
    process.exit(2);
  }
  log.error(`Server error: ${err.message}`);
  process.exit(1);
});

/**
 * Brings the service up. Kept out of module scope so an embedding shell — the
 * macOS menu-bar app — can register a pairing approver *before* the port opens,
 * rather than racing a request that arrives first.
 */
export async function start(): Promise<void> {
  ensureDefaultProviderConfigs(db);
  await syncProviderConfigsToDefaults(db);

  await new Promise<void>((resolve) => {
    server.listen(PORT, '127.0.0.1', () => {
      const address = server.address();
      log.info(`Listening on http://127.0.0.1:${typeof address === 'object' && address ? address.port : PORT}`);
      process.send?.({ type: 'ready', port: PORT, token: bearerToken, logFile: log.filePath });
      resolve();
    });
  });
}

// Graceful shutdown — kill any in-flight provisioning children so they don't
// orphan and hold elan/lake locks past the next start. Only catches SIGTERM
// and SIGINT; SIGKILL still leaves orphans (kernel can't run handlers).
let shuttingDown = false;
function gracefulShutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal} — terminating spawned child processes…`);
  killActiveProvisionChildren(signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
  server.close(() => process.exit(0));
  // Hard backstop if server.close hangs on an open SSE connection.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

  if (req.method === 'POST' && pathname === '/v1/pair') {
    return handlePair(req, res);
  }

  if (req.method === 'GET' && pathname === '/v1/health') {
    return handleHealth(res);
  }

  if (req.method === 'POST' && pathname === '/v1/verify') {
    return handleVerify(req, res);
  }

  if (req.method === 'GET' && pathname.startsWith('/v1/runs/')) {
    const parts = pathname.split('/');
    const runId = parts[3];
    if (!runId) { sendJson(res, 404, { error: 'Not found' }); return; }

    if (parts[4] === 'events') {
      return handleRunEvents(res, runId);
    }
    return handleGetRun(res, runId);
  }

  if (req.method === 'POST' && pathname.match(/^\/v1\/runs\/[^/]+\/informal-audit\/(acknowledge|override)$/)) {
    const runId = pathname.split('/')[3];
    if (!runId) { sendJson(res, 404, { error: 'Not found' }); return; }
    return handleInformalAuditAcknowledgement(req, res, runId);
  }

  if (req.method === 'POST' && pathname === '/v1/projects/lookup') {
    return handleProjectLookup(req, res);
  }

  if (req.method === 'POST' && pathname === '/v1/projects') {
    return handleCreateProject(req, res);
  }

  if (req.method === 'GET' && pathname.startsWith('/v1/projects/')) {
    const projectId = pathname.split('/')[3];
    if (!projectId) { sendJson(res, 404, { error: 'Not found' }); return; }
    return handleGetProject(res, projectId);
  }

  if (req.method === 'POST' && pathname.match(/^\/v1\/projects\/[^/]+\/overrides$/)) {
    const projectId = pathname.split('/')[3];
    if (!projectId) { sendJson(res, 404, { error: 'Not found' }); return; }
    return handleCreateOverride(req, res, projectId);
  }

  if (req.method === 'GET' && pathname === '/v1/provider-configs') {
    return handleListProviderConfigs(res);
  }

  if (req.method === 'PUT' && pathname.match(/^\/v1\/provider-keys\/[^/]+$/)) {
    const provider = pathname.split('/')[3];
    if (!provider) { sendJson(res, 404, { error: 'Not found' }); return; }
    return handleSetNamedProviderKey(req, res, provider);
  }

  if (req.method === 'DELETE' && pathname.match(/^\/v1\/provider-keys\/[^/]+$/)) {
    const provider = pathname.split('/')[3];
    if (!provider) { sendJson(res, 404, { error: 'Not found' }); return; }
    return handleClearNamedProviderKey(res, provider);
  }

  if (req.method === 'POST' && pathname === '/v1/provision') {
    return handleStartProvision(req, res);
  }

  if (req.method === 'GET' && pathname === '/v1/provision') {
    return handleGetProvisionState(res);
  }

  if (req.method === 'GET' && pathname.match(/^\/v1\/provision\/[^/]+\/events$/)) {
    const provisionId = pathname.split('/')[3];
    if (!provisionId) { sendJson(res, 404, { error: 'Not found' }); return; }
    return handleProvisionEvents(res, provisionId);
  }

  sendJson(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------------------
// Lean availability detection (cached for 30 s to avoid spawning on every poll)
// ---------------------------------------------------------------------------

interface LeanStatusCache {
  result: HealthResponse['lean'];
  expiresAt: number;
}

let leanStatusCache: LeanStatusCache | null = null;

async function detectLeanStatus(projectDir: string): Promise<HealthResponse['lean']> {
  // Readiness comes from the provisioner rather than a second file check of its
  // own. The two used to disagree — this one never looked for `lakefile.lean` —
  // so `/v1/health` and `/v1/provision` could give the extension opposite
  // answers about the same directory.
  const { ready: projectReady } = await inspectProvisionedProject(projectDir);

  return new Promise((resolve) => {
    // Resolve PATH so an elan installed under ~/.elan/bin is visible even if the
    // user hasn't sourced its shell hook yet.
    const elanBin = join(homedir(), '.elan', 'bin');
    const pathParts = (process.env['PATH'] ?? '').split(':').filter(Boolean);
    if (!pathParts.includes(elanBin)) pathParts.unshift(elanBin);
    const env = { ...process.env, PATH: pathParts.join(':') };

    const cwd = existsSync(projectDir) ? projectDir : homedir();
    const child = spawn(
      'bash',
      ['-c', 'lake env lean --version 2>&1'],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ available: false, version: null, projectReady });
    }, 5000);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const match = /Lean \(version ([\d.]+)/.exec(output);
        resolve({
          available: true,
          version: match?.[1] ?? output.trim().slice(0, 40),
          projectReady,
        });
      } else {
        resolve({ available: false, version: null, projectReady });
      }
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve({ available: false, version: null, projectReady });
    });
  });
}

async function getLeanStatus(): Promise<HealthResponse['lean']> {
  if (leanStatusCache && Date.now() < leanStatusCache.expiresAt) {
    return leanStatusCache.result;
  }
  const result = await detectLeanStatus(leanProjectDir);
  leanStatusCache = { result, expiresAt: Date.now() + 30_000 };
  return result;
}

function invalidateLeanStatusCache(): void {
  leanStatusCache = null;
}

// ---------------------------------------------------------------------------
// Toolchain versions
//
// There is one provisioned Lean project per install, so what a run actually
// compiles against is whatever that project holds — not what was current when
// the Overleaf project was first linked. Runs and cache keys therefore read the
// provisioned toolchain, falling back to the defaults before the first
// provision. Recording a stale version here would let a cached result from an
// older toolchain be served for a goal the current one may no longer accept.
// ---------------------------------------------------------------------------

interface ToolchainVersions {
  leanVersion: string;
  mathlibRevision: string;
}

let toolchainCache: { result: ToolchainVersions; expiresAt: number } | null = null;

async function getToolchainVersions(): Promise<ToolchainVersions> {
  if (toolchainCache && Date.now() < toolchainCache.expiresAt) {
    return toolchainCache.result;
  }
  const provisioned = await inspectProvisionedProject(leanProjectDir);
  const result: ToolchainVersions = {
    leanVersion: normalizeLeanVersion(provisioned.leanVersion) ?? DEFAULT_LEAN_VERSION,
    mathlibRevision: provisioned.mathlibRevision ?? DEFAULT_MATHLIB_REVISION,
  };
  toolchainCache = { result, expiresAt: Date.now() + 30_000 };
  return result;
}

function invalidateToolchainCache(): void {
  toolchainCache = null;
}

// `lean-toolchain` holds a full toolchain name (`leanprover/lean4:v4.33.1`);
// reduce it to the bare version so a value read from disk and the default
// compare equal and produce the same cache key.
function normalizeLeanVersion(toolchain: string | null): string | null {
  const trimmed = toolchain?.trim();
  if (!trimmed) return null;
  return /(?:^|:)v?(\d[\w.-]*)$/.exec(trimmed)?.[1] ?? trimmed;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleHealth(res: ServerResponse): Promise<void> {
  const cacheEntries = (() => {
    try { return cache.count(); } catch { return null; }
  })();

  const lean = await getLeanStatus();

  sendJson(res, 200, {
    protocolVersion: 1,
    version: VERSION,
    status: lean.available ? 'ok' : 'degraded',
    lean,
    cache: { available: true, entries: cacheEntries },
  } satisfies HealthResponse);
}

async function handleVerify(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = VerificationRequest.safeParse(await readJson(req));
  if (!body.success) {
    sendJson(res, 400, { error: body.error.flatten() });
    return;
  }

  const { requestId, projectId, claimId, snapshot, parsedDocumentFingerprint, parserVersion } =
    body.data;

  // Resolve project.
  let resolvedProjectId = projectId;
  if (!resolvedProjectId && snapshot.projectId) {
    const row = db
      .prepare('SELECT projectId FROM projects WHERE overleafProjectId = ?')
      .get(snapshot.projectId) as { projectId: string } | undefined;
    resolvedProjectId = row?.projectId ?? null;
  }

  if (!resolvedProjectId) {
    sendJson(res, 422, {
      error: 'No project found. Create a project first via POST /v1/projects.',
    });
    return;
  }

  // Look up project settings for leanVersion/mathlibRevision.
  const project = db
    .prepare('SELECT * FROM projects WHERE projectId = ?')
    .get(resolvedProjectId) as ProjectRow | undefined;

  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return;
  }

  const parsedDocument = parseLatexDocument(snapshot.documentText);
  const requestedItem = parsedDocument.claims.find((item) => item.id === claimId);
  if (!requestedItem) {
    sendJson(res, 422, { error: `Document item not found: ${claimId}` });
    return;
  }

  const settings = parseSettings(project.settingsJson);
  const { leanVersion, mathlibRevision } = await getToolchainVersions();
  const tokenBudgetCap: number = (settings['tokenBudgetCap'] as number | undefined) ?? DEFAULT_TOKEN_BUDGET_CAP;
  const wallClockCapMs: number = (settings['wallClockCapMs'] as number | undefined) ?? DEFAULT_WALL_CLOCK_CAP_MS;

  // Resolve provider configs.
  syncProjectProviderConfigsFromGlobal(db);
  const configs = db
    .prepare('SELECT * FROM model_provider_configs WHERE projectId = ?')
    .all(resolvedProjectId) as ProviderConfigRow[];

  const formalizerConfig = configs.find((c) => c.role === 'formalizer');
  const auxiliaryConfig = configs.find((c) => c.role === 'auxiliary');
  // Installs from before the proposer had its own row fall back to the
  // formalizer's, which is what they were using anyway.
  const proposerConfig = configs.find((c) => c.role === 'proposer') ?? formalizerConfig;

  if (!formalizerConfig || !auxiliaryConfig || !proposerConfig) {
    sendJson(res, 422, { error: 'Provider configs not configured for this project.' });
    return;
  }

  const runId = await runPipeline(db, {
    requestId,
    projectId: resolvedProjectId,
    claimId,
    documentText: snapshot.documentText,
    parsedDocumentFingerprint,
    parserVersion,
    leanProjectDir,
    mode: body.data.mode,
  }, {
    leanVersion,
    mathlibRevision,
    proposerConfigId: proposerConfig.providerConfigId,
    formalizerConfigId: formalizerConfig.providerConfigId,
    auxiliaryConfigId: auxiliaryConfig.providerConfigId,
    tokenBudgetCap,
    wallClockCapMs,
  });

  sendJson(res, 202, {
    protocolVersion: 1,
    runId,
    requestId,
    claimId,
    status: 'accepted',
  } satisfies AcceptedRunResponse);
}

function handleRunEvents(res: ServerResponse, runId: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  // Send any past events immediately.
  const pastEvents = db
    .prepare(
      `SELECT eventId, auditRunId, timestamp, phase, level, message, payloadJson
       FROM run_events WHERE auditRunId = ? ORDER BY timestamp ASC`,
    )
    .all(runId) as Array<{
      eventId: string;
      auditRunId: string;
      timestamp: string;
      phase: string;
      level: string;
      message: string;
      payloadJson: string | null;
    }>;

  for (const row of pastEvents) {
    const payload = row.payloadJson ? JSON.parse(row.payloadJson) as unknown : undefined;
    res.write(`event: run_event\ndata: ${JSON.stringify({ ...row, payload })}\n\n`);
  }

  // Check if already finished.
  const run = db
    .prepare('SELECT status, outcome FROM audit_runs WHERE auditRunId = ?')
    .get(runId) as { status: string; outcome: string | null } | undefined;

  if (!run) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: 'Run not found' })}\n\n`);
    res.end();
    return;
  }

  if (run.status === 'finished' || run.status === 'cancelled') {
    res.write(
      `event: complete\ndata: ${JSON.stringify({
        auditRunId: runId,
        status: run.status,
        outcome: run.outcome ?? undefined,
      })}\n\n`,
    );
    res.end();
    return;
  }

  // Heartbeats keep long reasoning requests visible to the extension worker.
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
  const unsubscribe = subscribeSse(runId, chunk => {
    res.write(chunk);
    if (chunk.startsWith('event: complete')) { res.end(); cleanup(); }
  });
  const cleanup = (): void => { clearInterval(heartbeat); unsubscribe(); };
  res.on('close', cleanup);

}

function handleGetRun(res: ServerResponse, runId: string): void {
  const run = db
    .prepare('SELECT * FROM audit_runs WHERE auditRunId = ?')
    .get(runId) as AuditRunRow | undefined;

  if (!run) {
    sendJson(res, 404, { error: 'Run not found' });
    return;
  }

  // Resolve claimId: prefer the identity's current label, fall back to revision id.
  let claimId = '';
  if (run.targetClaimRevisionId) {
    const rev = db
      .prepare(
        `SELECT ci.currentLabel
         FROM claim_revisions cr
         JOIN claim_identities ci ON cr.claimIdentityId = ci.claimIdentityId
         WHERE cr.claimRevisionId = ?`,
      )
      .get(run.targetClaimRevisionId) as { currentLabel: string | null } | undefined;
    claimId = rev?.currentLabel ?? run.targetClaimRevisionId;
  }

  // Resolve faithfulness verdict from the roundtrip check.
  const faithfulnessRow = db
    .prepare(
      `SELECT verdict FROM faithfulness_checks
       WHERE auditRunId = ? AND kind = 'roundtrip'
       ORDER BY createdAt DESC LIMIT 1`,
    )
    .get(runId) as { verdict: string } | undefined;

  // Resolve accepted Lean source from the final proof artifact.
  const artifactRow = db
    .prepare(
      `SELECT leanSource FROM final_proof_artifacts
       WHERE auditRunId = ? ORDER BY createdAt DESC LIMIT 1`,
    )
    .get(runId) as { leanSource: string } | undefined;

  // Status, outcome and verdict are stored as bare text, so they are read back
  // through the same enums the client will parse them with. A row written by an
  // older build reports as absent rather than failing the client's parse.
  sendJson(res, 200, {
    protocolVersion: 1,
    runId: run.auditRunId,
    claimId,
    status: AuditRunStatus.catch('finished').parse(run.status),
    outcome: parseVerificationOutcome(run.outcome),
    faithfulnessVerdict: FaithfulnessVerdict.safeParse(faithfulnessRow?.verdict).data ?? null,
    leanSource: artifactRow?.leanSource ?? null,
    diagnostics: (db.prepare("SELECT message FROM run_events WHERE auditRunId = ? AND level IN ('warning', 'error') ORDER BY rowid").all(runId) as Array<{ message: string }>).map(row => row.message),
    durationMs: run.durationMs ?? null,
  } satisfies RunResult);
}

async function handleProjectLookup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = ProjectLookupRequest.safeParse(await readJson(req));
  if (!body.success) {
    sendJson(res, 400, { error: body.error.flatten() });
    return;
  }

  const { overleafProjectId, overleafUrl } = body.data;

  let project: ProjectRow | undefined;

  if (overleafProjectId) {
    project = db
      .prepare('SELECT * FROM projects WHERE overleafProjectId = ?')
      .get(overleafProjectId) as ProjectRow | undefined;
  } else if (overleafUrl) {
    project = db
      .prepare('SELECT * FROM projects WHERE overleafUrl = ?')
      .get(overleafUrl) as ProjectRow | undefined;
  }

  if (project) {
    const { leanVersion, mathlibRevision } = await getToolchainVersions();
    sendJson(res, 200, {
      protocolVersion: 1,
      status: 'linked',
      project: {
        id: project.projectId,
        name: project.name,
        sourceKind: 'overleaf',
        overleafProjectId: project.overleafProjectId,
        createdAt: project.createdAt,
        lastOpenedAt: project.lastOpenedAt,
        leanVersion,
        mathlibRevision,
      },
      claimStatuses: listProjectClaimStatuses(db, project.projectId, body.data.documentFingerprint),
    } satisfies ProjectLookupResponse);
    return;
  }

  sendJson(res, 200, {
    protocolVersion: 1,
    status: 'notFound',
    project: null,
    claimStatuses: [],
  } satisfies ProjectLookupResponse);
}

async function handleCreateProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = CreateProjectRequest.safeParse(await readJson(req));
  if (!body.success) {
    sendJson(res, 400, { error: body.error.flatten() });
    return;
  }

  const { overleafProjectId, overleafUrl, name } = body.data;
  // Versions are a property of the install's Lean project, not of this record.
  const { leanVersion, mathlibRevision } = await getToolchainVersions();

  const now = new Date().toISOString();
  const projectId = randomUUID();

  db.prepare(
    `INSERT INTO projects (projectId, sourceKind, overleafProjectId, overleafUrl, name, createdAt, lastOpenedAt, settingsJson)
     VALUES (?, 'overleaf', ?, ?, ?, ?, ?, ?)`,
  ).run(
    projectId,
    overleafProjectId ?? null,
    overleafUrl ?? null,
    name,
    now,
    now,
    JSON.stringify({}),
  );

  // Create default provider configs.
  createDefaultConfigs(db, projectId);

  sendJson(res, 201, {
    protocolVersion: 1,
    status: 'linked',
    project: {
      id: projectId,
      name,
      sourceKind: 'overleaf',
      overleafProjectId: overleafProjectId ?? null,
      createdAt: now,
      lastOpenedAt: now,
      leanVersion,
      mathlibRevision,
    },
    claimStatuses: [],
  } satisfies ProjectLookupResponse);
}

async function handleGetProject(res: ServerResponse, projectId: string): Promise<void> {
  const project = db
    .prepare('SELECT * FROM projects WHERE projectId = ?')
    .get(projectId) as ProjectRow | undefined;

  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return;
  }

  const { leanVersion, mathlibRevision } = await getToolchainVersions();
  sendJson(res, 200, {
    id: project.projectId,
    name: project.name,
    sourceKind: project.sourceKind,
    overleafProjectId: project.overleafProjectId,
    createdAt: project.createdAt,
    lastOpenedAt: project.lastOpenedAt,
    leanVersion,
    mathlibRevision,
  });
}

async function handleInformalAuditAcknowledgement(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  const body = await readJson(req) as { reason?: unknown } | null;
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    sendJson(res, 400, { error: 'reason is required' });
    return;
  }

  try {
    const result = await acknowledgeInformalAudit(db, runId, reason, leanProjectDir);
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    if (err instanceof InformalAuditNotFoundError) {
      sendJson(res, 404, { error: err.message });
      return;
    }
    throw err;
  }
}

async function handleCreateOverride(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  const body = await readJson(req) as Record<string, unknown> | null;
  if (!body) {
    sendJson(res, 400, { error: 'Invalid request body' });
    return;
  }

  const {
    claimIdentityId,
    previousClaimRevisionId = null,
    currentClaimRevisionId,
    previousAuditRunId = null,
    class: overrideClass = 'direct',
    reason,
  } = body as {
    claimIdentityId?: string;
    previousClaimRevisionId?: string | null;
    currentClaimRevisionId?: string;
    previousAuditRunId?: string | null;
    class?: string;
    reason?: string;
  };

  if (!claimIdentityId || !currentClaimRevisionId || !reason) {
    sendJson(res, 400, { error: 'claimIdentityId, currentClaimRevisionId, and reason are required' });
    return;
  }
  if (overrideClass !== 'direct' && overrideClass !== 'transitive') {
    sendJson(res, 400, { error: 'class must be "direct" or "transitive"' });
    return;
  }

  const identity = db
    .prepare('SELECT claimIdentityId FROM claim_identities WHERE claimIdentityId = ? AND projectId = ?')
    .get(claimIdentityId, projectId) as { claimIdentityId: string } | undefined;

  if (!identity) {
    sendJson(res, 404, { error: 'Claim identity not found in this project' });
    return;
  }

  const overrideId = randomUUID();
  db.prepare(
    `INSERT INTO content_change_overrides
       (overrideId, projectId, claimIdentityId, previousClaimRevisionId, currentClaimRevisionId,
        previousAuditRunId, class, reason, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrideId,
    projectId,
    claimIdentityId,
    previousClaimRevisionId ?? null,
    currentClaimRevisionId,
    previousAuditRunId ?? null,
    overrideClass,
    reason,
    new Date().toISOString(),
  );

  db.prepare(
    `UPDATE claim_identities SET statusCache = 'verifiedByOverride' WHERE claimIdentityId = ?`,
  ).run(claimIdentityId);

  sendJson(res, 201, { overrideId });
}

/**
 * Pairing: a client asks, a person approves in the app, and the token comes back
 * over this response. Reachable without a token by design — it is the only way
 * to obtain one — and rate-limited by the fact that a human must click.
 */
async function handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = normalizeOrigin(req.headers['origin'] ?? '');
  const body = await readJson(req) as { clientName?: unknown } | null;
  const clientName = typeof body?.clientName === 'string' ? body.clientName.slice(0, 80) : 'unknown client';

  if (!origin) {
    sendJson(res, 400, { error: 'Pairing requires an Origin header' });
    return;
  }

  if (!pairing.hasApprover) {
    log.error(`Pairing request from ${origin} refused: no approver registered`);
    sendJson(res, 503, { error: 'This service cannot ask for approval right now' });
    return;
  }

  log.info(`Pairing request from ${origin} (${clientName})`);
  let decision: 'approved' | 'denied';
  try {
    decision = await pairing.request(origin, clientName);
  } catch (err) {
    if (err instanceof PairingAlreadyPendingError) {
      sendJson(res, 409, { error: err.message });
      return;
    }
    throw err;
  }

  if (decision !== 'approved') {
    log.info(`Pairing request from ${origin} denied`);
    sendJson(res, 403, { error: 'Pairing was declined' });
    return;
  }

  pairedOrigins = recordPairedOrigin(db, origin);
  log.info(`Paired with ${origin}`);
  sendJson(res, 200, { token: bearerToken });
}

async function handleListProviderConfigs(res: ServerResponse): Promise<void> {
  const formalizer = db
    .prepare("SELECT * FROM model_provider_configs WHERE projectId IS NULL AND role = 'formalizer'")
    .get() as ProviderConfigRow | undefined;

  const proposer = db
    .prepare("SELECT * FROM model_provider_configs WHERE projectId IS NULL AND role = 'proposer'")
    .get() as ProviderConfigRow | undefined;

  const auxiliary = db
    .prepare("SELECT * FROM model_provider_configs WHERE projectId IS NULL AND role = 'auxiliary'")
    .get() as ProviderConfigRow | undefined;

  // One OpenRouter key backs every role, so key presence is a single flag.
  const hasKey = await hasStoredOpenRouterKey();

  sendJson(res, 200, {
    formalizerConfig: summarizeProviderConfig(formalizer),
    proposerConfig: summarizeProviderConfig(proposer),
    auxiliaryConfig: summarizeProviderConfig(auxiliary),
    hasKey,
  } satisfies ProviderConfigsResponse);
}

function summarizeProviderConfig(row: ProviderConfigRow | undefined): ProviderConfigSummary | null {
  return row
    ? {
        providerConfigId: row.providerConfigId,
        provider: PROVIDER_NAME,
        modelId: row.modelId,
        baseUrl: row.baseUrl,
        reasoningEffort: row.reasoningEffort,
      }
    : null;
}

async function hasStoredOpenRouterKey(): Promise<boolean> {
  try {
    const keytar = await import('keytar');
    const [service, account] = OPENROUTER_KEY_REF.split(':') as [string, string];
    return Boolean(await keytar.default.getPassword(service, account));
  } catch {
    // keytar unavailable — no key can be stored, so none is present.
    return false;
  }
}

async function handleSetNamedProviderKey(
  req: IncomingMessage,
  res: ServerResponse,
  provider: string,
): Promise<void> {
  if (provider !== 'openrouter') {
    sendJson(res, 404, { error: 'Unknown provider' });
    return;
  }

  const body = await readJson(req) as { key?: unknown } | null;
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  if (!key) {
    sendJson(res, 400, { error: 'key is required' });
    return;
  }

  const [service, account] = OPENROUTER_KEY_REF.split(':') as [string, string];
  try {
    const keytar = await import('keytar');
    await keytar.default.setPassword(service, account, key);
  } catch (err) {
    sendJson(res, 500, { error: `Failed to store key in keychain: ${String(err)}` });
    return;
  }

  // All three roles run on the same endpoint, so this points every config at the key.
  db.prepare(
    `UPDATE model_provider_configs SET apiKeyRef = ?, updatedAt = ? WHERE baseUrl = ?`,
  ).run(OPENROUTER_KEY_REF, new Date().toISOString(), DEFAULT_OPENROUTER_BASE_URL);

  sendJson(res, 200, { ok: true });
}

async function handleClearNamedProviderKey(res: ServerResponse, provider: string): Promise<void> {
  if (provider !== 'openrouter') {
    sendJson(res, 404, { error: 'Unknown provider' });
    return;
  }

  const [service, account] = OPENROUTER_KEY_REF.split(':') as [string, string];
  try {
    const keytar = await import('keytar');
    await keytar.default.deletePassword(service, account);
  } catch { /* best-effort */ }

  db.prepare(
    `UPDATE model_provider_configs SET apiKeyRef = NULL, updatedAt = ? WHERE apiKeyRef = ?`,
  ).run(new Date().toISOString(), OPENROUTER_KEY_REF);

  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Provisioning handlers
// ---------------------------------------------------------------------------

async function handleStartProvision(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = ProvisionRequest.safeParse(await readJson(req));
  if (!body.success) {
    sendJson(res, 400, { error: body.error.flatten() });
    return;
  }

  const leanVersion = body.data.leanVersion ?? DEFAULT_LEAN_VERSION;
  const mathlibRevision = body.data.mathlibRevision ?? DEFAULT_MATHLIB_REVISION;

  try {
    const result = await startProvision({
      leanVersion,
      mathlibRevision,
      projectDir: leanProjectDir,
      ...(body.data.force !== undefined ? { force: body.data.force } : {}),
    });

    // Once provisioning kicks off, the previous health snapshot is stale.
    invalidateLeanStatusCache();
    invalidateToolchainCache();
    clearMathlibImportIndexCache();

    if (result.alreadyReady) {
      sendJson(res, 200, {
        protocolVersion: 1,
        provisionId: result.provisionId,
        status: 'accepted',
        alreadyReady: true,
      });
      return;
    }

    sendJson(res, 202, {
      protocolVersion: 1,
      provisionId: result.provisionId,
      status: 'accepted',
    } satisfies AcceptedProvisionResponse);
  } catch (err) {
    if (err instanceof ProvisionAlreadyRunningError) {
      sendJson(res, 409, { error: err.message });
      return;
    }
    throw err;
  }
}

async function handleGetProvisionState(res: ServerResponse): Promise<void> {
  const provisionState = await getProvisionState();
  sendJson(res, 200, provisionState);
}

function handleProvisionEvents(
  res: ServerResponse,
  provisionId: string,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  // Replay past events for this provision id.
  for (const event of getPastEvents(provisionId)) {
    res.write(`event: provision_event\ndata: ${JSON.stringify(event)}\n\n`);
  }

  // A provision that finished before this request arrived is reported from
  // stored state; a live one is reported by the subscription. Both race to
  // close the stream, so completion happens exactly once either way.
  let finished = false;
  const complete = (payload: Record<string, unknown>, chunk?: string): void => {
    if (finished) return;
    finished = true;
    // The provisioning state has changed; force-refresh the health snapshot.
    invalidateLeanStatusCache();
    invalidateToolchainCache();
    clearMathlibImportIndexCache();
    res.write(chunk ?? `event: complete\ndata: ${JSON.stringify(payload)}\n\n`);
    res.end();
    unsubscribe();
  };

  const unsubscribe = subscribeProvisionSse(provisionId, (chunk) => {
    if (finished) return;
    if (chunk.startsWith('event: complete')) complete({}, chunk);
    else res.write(chunk);
  });

  void getProvisionState().then((state) => {
    if (state.provisionId === provisionId && state.status !== 'running') {
      complete({ provisionId, status: state.status, error: state.error });
    }
  });

  res.on('close', () => { finished = true; unsubscribe(); });
}

function markInterruptedRuns(db: DatabaseInstance, log: Logger): void {
  const interruptedRuns = db
    .prepare(
      `SELECT auditRunId, phase, startedAt
       FROM audit_runs
       WHERE status IN ('queued','running')`,
    )
    .all() as Array<{ auditRunId: string; phase: string | null; startedAt: string }>;

  if (interruptedRuns.length === 0) return;

  const now = new Date();
  const finishedAt = now.toISOString();
  const updateRun = db.prepare(
    `UPDATE audit_runs
     SET status = 'finished', outcome = 'verificationBlocked', finishedAt = ?, durationMs = ?
     WHERE auditRunId = ?`,
  );
  const updateClaim = db.prepare(
    `UPDATE claim_identities
     SET statusCache = 'blocked'
     WHERE claimIdentityId = (
       SELECT cr.claimIdentityId
       FROM audit_runs ar
       JOIN claim_revisions cr ON cr.claimRevisionId = ar.targetClaimRevisionId
       WHERE ar.auditRunId = ?
     )`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO run_events (eventId, auditRunId, timestamp, phase, level, message, payloadJson)
     VALUES (?, ?, ?, ?, 'warning', ?, ?)`,
  );

  for (const run of interruptedRuns) {
    const startedMs = Date.parse(run.startedAt);
    const durationMs = Number.isFinite(startedMs) ? Math.max(0, now.getTime() - startedMs) : null;
    const phase = RunPhase.safeParse(run.phase).success ? run.phase : 'complete';
    const message = 'Interrupted run marked verificationBlocked after desktop restart';

    updateRun.run(finishedAt, durationMs, run.auditRunId);
    updateClaim.run(run.auditRunId);
    insertEvent.run(
      randomUUID(),
      run.auditRunId,
      finishedAt,
      phase,
      message,
      JSON.stringify({ outcome: 'verificationBlocked', reason: 'desktopRestart' }),
    );
  }

  log.info(`Marked ${interruptedRuns.length} interrupted audit run(s) as verificationBlocked`);
}

function listProjectClaimStatuses(
  db: DatabaseInstance,
  projectId: string,
  currentDocumentFingerprint?: string | null,
): ProjectLookupResponse['claimStatuses'] {
  const identities = db
    .prepare(
      `SELECT claimIdentityId, currentLabel, currentKind, statusCache
       FROM claim_identities
       WHERE projectId = ?
       ORDER BY firstSeenAt ASC`,
    )
    .all(projectId) as Array<{
      claimIdentityId: string;
      currentLabel: string | null;
      currentKind: string;
      statusCache: string;
    }>;

  return identities.map((identity) => {
    const latestRun = db
      .prepare(
        `SELECT ar.auditRunId, ar.status, ar.phase, ar.outcome, ar.startedAt, ar.finishedAt, cr.claimFingerprint, ds.documentFingerprint
         FROM audit_runs ar
         JOIN document_snapshots ds ON ds.snapshotId = ar.snapshotId
         JOIN claim_revisions cr ON cr.claimRevisionId = ar.targetClaimRevisionId
         WHERE cr.claimIdentityId = ?
         ORDER BY ar.startedAt DESC
         LIMIT 1`,
      )
      .get(identity.claimIdentityId) as {
        auditRunId: string;
        claimFingerprint: string;
        documentFingerprint: string;
        status: string;
        phase: string | null;
        outcome: string | null;
        startedAt: string;
        finishedAt: string | null;
      } | undefined;

    const latestEvent = latestRun
      ? db
          .prepare(
            `SELECT message, timestamp
             FROM run_events
             WHERE auditRunId = ?
             ORDER BY timestamp DESC
             LIMIT 1`,
          )
          .get(latestRun.auditRunId) as { message: string; timestamp: string } | undefined
      : undefined;

    return {
      claimId: identity.currentLabel ?? identity.claimIdentityId,
      claimFingerprint: latestRun?.claimFingerprint ?? null,
      label: identity.currentLabel,
      kind: identity.currentKind,
      status: currentDocumentFingerprint && latestRun && currentDocumentFingerprint !== latestRun.documentFingerprint && ['verified', 'formalized'].includes(latestRun.outcome ?? '') ? 'stale' : normalizeClaimStatus(identity.statusCache, latestRun),
      runId: latestRun?.auditRunId ?? null,
      phase: parseRunPhase(latestRun?.phase),
      outcome: parseVerificationOutcome(latestRun?.outcome),
      message: latestEvent?.message ?? null,
      updatedAt: latestEvent?.timestamp ?? latestRun?.finishedAt ?? latestRun?.startedAt ?? null,
    };
  });
}

function normalizeClaimStatus(
  statusCache: string,
  latestRun: { status: string; outcome: string | null } | undefined,
): ExtensionClaimStatus {
  if (latestRun?.status === 'queued' || latestRun?.status === 'running' || latestRun?.status === 'paused') {
    return 'checking';
  }

  if (statusCache === 'stale' || statusCache === 'verifiedByOverride') return statusCache;

  if (latestRun?.status === 'finished') {
    const outcome = parseVerificationOutcome(latestRun.outcome);
    if (outcome === 'verified') return 'verified';
    if (outcome === 'formalized') return 'formalized';
    if (outcome === 'dependencyMissing' || outcome === 'verificationBlocked') return 'blocked';
    if (outcome) return 'failed';
  }

  const parsed = ExtensionClaimStatus.safeParse(statusCache);
  return parsed.success ? parsed.data : 'pending';
}

function parseRunPhase(value: string | null | undefined): RunPhase | null {
  const parsed = RunPhase.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseVerificationOutcome(value: string | null | undefined): VerificationOutcome | null {
  const parsed = VerificationOutcome.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Default provider config bootstrap (API keys live in the OS keychain)
// ---------------------------------------------------------------------------

function ensureDefaultProviderConfigs(db: DatabaseInstance): void {
  // Global defaults (projectId = NULL) created only if none exist.
  const existing = db
    .prepare('SELECT COUNT(*) as n FROM model_provider_configs WHERE projectId IS NULL')
    .get() as { n: number };
  if (existing.n > 0) return;

  createDefaultConfigs(db, null);
}

function createDefaultConfigs(db: DatabaseInstance, projectId: string | null): void {
  const now = new Date().toISOString();

  if (projectId) {
    const globalConfigs = db
      .prepare(
        `SELECT role, providerKind, baseUrl, modelId, apiKeyRef, reasoningEffort, maxTokens, temperature
         FROM model_provider_configs
         WHERE projectId IS NULL AND role IN ('proposer', 'formalizer', 'auxiliary')`,
      )
      .all() as Array<Pick<ProviderConfigRow, 'role' | 'providerKind' | 'baseUrl' | 'modelId' | 'apiKeyRef' | 'reasoningEffort' | 'maxTokens' | 'temperature'>>;

    if (globalConfigs.length > 0) {
      for (const { role, providerKind, baseUrl, modelId, apiKeyRef, reasoningEffort, maxTokens, temperature } of globalConfigs) {
        db.prepare(
          `INSERT INTO model_provider_configs
             (providerConfigId, projectId, role, providerKind, baseUrl, modelId, apiKeyRef, reasoningEffort, maxTokens, temperature, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(randomUUID(), projectId, role, providerKind, baseUrl, modelId, apiKeyRef, reasoningEffort, maxTokens, temperature, now, now);
      }
      return;
    }
  }

  // The apiKeyRef column stays null until the settings UI writes a keytar entry.
  const apiKeyRef: string | null = null;

  for (const { role, providerKind, baseUrl, modelId, reasoningEffort, maxTokens, temperature } of defaultProviderConfigSpecs()) {
    db.prepare(
      `INSERT INTO model_provider_configs
         (providerConfigId, projectId, role, providerKind, baseUrl, modelId, apiKeyRef, reasoningEffort, maxTokens, temperature, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), projectId, role, providerKind, baseUrl, modelId, apiKeyRef, reasoningEffort, maxTokens, temperature, now, now);
  }
}

// Pins every stored config back onto the built-in OpenRouter defaults. This
// also migrates installs from earlier builds whose formalizer row still points
// at a provider that is no longer supported.
async function syncProviderConfigsToDefaults(db: DatabaseInstance): Promise<void> {
  const apiKeyRef = (await hasStoredOpenRouterKey()) ? OPENROUTER_KEY_REF : null;
  const now = new Date().toISOString();

  for (const spec of defaultProviderConfigSpecs()) {
    const existing = db
      .prepare('SELECT * FROM model_provider_configs WHERE projectId IS NULL AND role = ?')
      .get(spec.role) as ProviderConfigRow | undefined;

    if (!existing) {
      db.prepare(
        `INSERT INTO model_provider_configs
           (providerConfigId, projectId, role, providerKind, baseUrl, modelId, apiKeyRef, reasoningEffort, maxTokens, temperature, createdAt, updatedAt)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(randomUUID(), spec.role, spec.providerKind, spec.baseUrl, spec.modelId, apiKeyRef, spec.reasoningEffort, spec.maxTokens, now, now);
      continue;
    }

    // Project-scoped rows are updated too — a stale one would otherwise keep
    // sending that project's runs to a removed provider.
    db.prepare(
      `UPDATE model_provider_configs
       SET providerKind = ?,
           baseUrl = ?,
           modelId = ?,
           apiKeyRef = ?,
           reasoningEffort = ?, maxTokens = ?, temperature = NULL,
           updatedAt = ?
       WHERE role = ?`,
    ).run(spec.providerKind, spec.baseUrl, spec.modelId, apiKeyRef, spec.reasoningEffort, spec.maxTokens, now, spec.role);
  }
}

function syncProjectProviderConfigsFromGlobal(db: DatabaseInstance): void {
  const globalConfigs = db
    .prepare(
      `SELECT role, providerKind, baseUrl, modelId, apiKeyRef, reasoningEffort, maxTokens, temperature
       FROM model_provider_configs
       WHERE projectId IS NULL AND role IN ('proposer', 'formalizer', 'auxiliary')`,
    )
    .all() as Array<Pick<ProviderConfigRow, 'role' | 'providerKind' | 'baseUrl' | 'modelId' | 'apiKeyRef' | 'reasoningEffort' | 'maxTokens' | 'temperature'>>;

  const now = new Date().toISOString();
  for (const { role, providerKind, baseUrl, modelId, apiKeyRef, reasoningEffort, maxTokens, temperature } of globalConfigs) {
    db.prepare(
      `UPDATE model_provider_configs
       SET providerKind = ?,
           baseUrl = ?,
           modelId = ?,
           apiKeyRef = ?,
           reasoningEffort = ?, maxTokens = ?, temperature = ?,
           updatedAt = ?
       WHERE projectId IS NOT NULL AND role = ?`,
    ).run(providerKind, baseUrl, modelId, apiKeyRef, reasoningEffort, maxTokens, temperature, now, role);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

// A whole LaTeX document arrives in a snapshot, so the ceiling is generous —
// but unbounded accumulation is how one malformed client takes the service's
// memory with it, and the loopback binding is not a reason to skip the check.
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > MAX_REQUEST_BYTES) {
        req.destroy();
        reject(new Error(`Request body exceeds ${MAX_REQUEST_BYTES} bytes`));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** Null for anything unreadable, so callers answer 400 rather than 500. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  try { return JSON.parse(await readBody(req)); } catch { return null; }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

// Projects created by earlier builds froze the then-current Lean and Mathlib
// versions into their settings. The provisioned toolchain is the source of
// truth now, so drop the copies rather than let them shadow it.
function dropPinnedVersionsFromProjectSettings(db: DatabaseInstance): void {
  const rows = db
    .prepare('SELECT projectId, settingsJson FROM projects')
    .all() as Array<{ projectId: string; settingsJson: string }>;

  for (const row of rows) {
    const settings = parseSettings(row.settingsJson);
    if (!('leanVersion' in settings) && !('mathlibRevision' in settings)) continue;
    delete settings['leanVersion'];
    delete settings['mathlibRevision'];
    db.prepare('UPDATE projects SET settingsJson = ? WHERE projectId = ?')
      .run(JSON.stringify(settings), row.projectId);
  }
}

function parseSettings(settingsJson: string): Record<string, unknown> {
  try { return JSON.parse(settingsJson) as Record<string, unknown>; } catch { return {}; }
}

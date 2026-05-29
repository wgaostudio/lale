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
  CreateProjectRequest,
  ExtensionClaimStatus,
  HealthResponse,
  ProjectLookupRequest,
  ProjectLookupResponse,
  ProvisionRequest,
  RunPhase,
  VerificationRequest,
  VerificationOutcome,
} from '@lale/protocol';
import { parseLatexDocument } from '@lale/document-parser';
import { openDb } from './db.js';
import type { ProjectRow, AuditRunRow, ProviderConfigRow } from './db.js';
import { getOrCreateToken, checkAuth, isOriginAllowed, sendUnauthorized, sendForbidden } from './auth.js';
import {
  acknowledgeInformalAudit,
  InformalAuditNotFoundError,
  runPipeline,
  subscribeSse,
} from './pipeline/run.js';
import { clearMathlibImportIndexCache } from './pipeline/mathlib-index.js';
import {
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
  DEFAULT_NOVITA_BASE_URL,
  DEFAULT_FEATHERLESS_BASE_URL,
  DEFAULT_FORMALIZER_MODEL,
  DEFAULT_AUXILIARY_MODEL,
  defaultProviderConfigSpecs,
  hasApiKeyEnv,
  deriveKeyRef,
} from './model-config.js';

// ---------------------------------------------------------------------------
// Named provider registry — the two supported formalizer backends + auxiliary
// ---------------------------------------------------------------------------

const NAMED_FORMALIZER_PROVIDERS = {
  novita: {
    label: 'DeepSeek Prover V2 671B',
    provider: 'Novita',
    baseUrl: DEFAULT_NOVITA_BASE_URL,
    modelId: DEFAULT_FORMALIZER_MODEL,
    keyRef: 'lale:novita.ai',
    envKey: 'LALE_NOVITA_API_KEY',
  },
  featherless: {
    label: 'Goedel Prover V2 32B',
    provider: 'Featherless',
    baseUrl: DEFAULT_FEATHERLESS_BASE_URL,
    modelId: 'Goedel-LM/Goedel-Prover-V2-32B',
    keyRef: 'lale:featherless.ai',
    envKey: 'LALE_FEATHERLESS_API_KEY',
  },
} as const;

const NAMED_AUXILIARY_PROVIDER = {
  baseUrl: DEFAULT_OPENROUTER_BASE_URL,
  modelId: DEFAULT_AUXILIARY_MODEL,
  keyRef: 'lale:openrouter.ai',
  envKey: 'LALE_OPENROUTER_API_KEY',
} as const;

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const PORT = Number.parseInt(process.env['PORT'] ?? '8765', 10);
// Lean 4.15.0 binaries fail to load on macOS 15 (Sequoia) with
// `__DATA_CONST segment missing SG_READ_ONLY flag` — the fix landed in the
// 4.16/4.17 timeframe. Pinning past that. v4.20.0 has community-cache
// coverage and is comfortably past the dyld fix.
const DEFAULT_LEAN_VERSION = '4.20.0';
// Mathlib revision must match the Lean toolchain; the literal string "latest"
// is not a tag and cache-misses against the community CDN (spec §4 names the
// cache as load-bearing for the zero-cost claim).
const DEFAULT_MATHLIB_REVISION = 'v4.20.0';
const DEFAULT_TOKEN_BUDGET = 100_000;
const DEFAULT_WALL_CLOCK_CAP_MS = 60_000;

const db = openDb();
const cache = new LeanCheckCache(db);
const bearerToken = getOrCreateToken(db);
const leanProjectDir = process.env['LALE_LEAN_PROJECT_DIR'] ?? join(homedir(), '.lale', 'lean-project');
initProjectDir(leanProjectDir);
markInterruptedRuns(db);

console.log('─'.repeat(60));
console.log('lale desktop service starting');
console.log(`Port:        ${PORT}`);
console.log(`DB:          ${join(homedir(), '.lale', 'lale.db')}`);
console.log(`Lean project: ${leanProjectDir}`);
console.log('');
console.log('Extension connection token (paste into extension settings):');
console.log(`  ${bearerToken}`);
console.log('─'.repeat(60));

// ---------------------------------------------------------------------------
// Default provider configs (from env vars, for v0 bootstrapping)
// ---------------------------------------------------------------------------

ensureDefaultProviderConfigs(db);
syncDefaultAuxiliaryConfig(db);
syncProjectProviderConfigsFromGlobal(db);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  // CORS — only echo back the origin for allowed origins to prevent DNS-rebinding.
  const origin = req.headers['origin'] ?? '';
  if (isOriginAllowed(origin)) {
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
  const auth = checkAuth(req, bearerToken);
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
    console.error('Unhandled error:', err);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Listening on http://127.0.0.1:${PORT}`);
});

// Graceful shutdown — kill any in-flight provisioning children so they don't
// orphan and hold elan/lake locks past the next start. Only catches SIGTERM
// and SIGINT; SIGKILL still leaves orphans (kernel can't run handlers).
let shuttingDown = false;
function gracefulShutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal} — terminating spawned child processes…`);
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
      return handleRunEvents(req, res, runId);
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

  if (req.method === 'PATCH' && pathname.match(/^\/v1\/provider-configs\/[^/]+$/)) {
    const configId = pathname.split('/')[3];
    if (!configId) { sendJson(res, 404, { error: 'Not found' }); return; }
    return handleSwitchFormalizer(req, res, configId);
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

  if (req.method === 'PUT' && pathname.match(/^\/v1\/provider-configs\/[^/]+\/key$/)) {
    const configId = pathname.split('/')[3];
    if (!configId) { sendJson(res, 404, { error: 'Not found' }); return; }
    return handleSetProviderKey(req, res, configId);
  }

  if (req.method === 'DELETE' && pathname.match(/^\/v1\/provider-configs\/[^/]+\/key$/)) {
    const configId = pathname.split('/')[3];
    if (!configId) { sendJson(res, 404, { error: 'Not found' }); return; }
    return handleClearProviderKey(res, configId);
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
    return handleProvisionEvents(req, res, provisionId);
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

function detectLeanStatus(projectDir: string): Promise<HealthResponse['lean']> {
  return new Promise((resolve) => {
    // Resolve PATH so an elan installed under ~/.elan/bin is visible even if the
    // user hasn't sourced its shell hook yet.
    const elanBin = join(homedir(), '.elan', 'bin');
    const pathParts = (process.env['PATH'] ?? '').split(':').filter(Boolean);
    if (!pathParts.includes(elanBin)) pathParts.unshift(elanBin);
    const env = { ...process.env, PATH: pathParts.join(':') };

    const projectReady = existsSync(join(projectDir, 'lean-toolchain'))
      && existsSync(join(projectDir, '.lake'));
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
// Handlers
// ---------------------------------------------------------------------------

async function handleHealth(res: ServerResponse): Promise<void> {
  const cacheEntries = (() => {
    try { return cache.count(); } catch { return null; }
  })();

  const lean = await getLeanStatus();

  sendJson(res, 200, {
    protocolVersion: 1,
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
  const leanVersion: string = (settings['leanVersion'] as string | undefined) ?? DEFAULT_LEAN_VERSION;
  const mathlibRevision: string = (settings['mathlibRevision'] as string | undefined) ?? DEFAULT_MATHLIB_REVISION;
  const tokenBudgetCap: number = (settings['tokenBudgetCap'] as number | undefined) ?? DEFAULT_TOKEN_BUDGET;
  const wallClockCapMs: number = (settings['wallClockCapMs'] as number | undefined) ?? DEFAULT_WALL_CLOCK_CAP_MS;

  // Resolve provider configs.
  const configs = db
    .prepare('SELECT * FROM model_provider_configs WHERE projectId = ?')
    .all(resolvedProjectId) as ProviderConfigRow[];

  const formalizerConfig = configs.find((c) => c.role === 'formalizer');
  const auxiliaryConfig = configs.find((c) => c.role === 'auxiliary');

  if (!formalizerConfig || !auxiliaryConfig) {
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
  }, {
    leanVersion,
    mathlibRevision,
    // The formalizer model handles both formalization and proving.
    proverConfigId: formalizerConfig.providerConfigId,
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

function handleRunEvents(req: IncomingMessage, res: ServerResponse, runId: string): void {
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

  // Subscribe to live events.
  const unsubscribe = subscribeSse(runId, (chunk) => {
    res.write(chunk);
    if (chunk.startsWith('event: complete')) {
      res.end();
      unsubscribe();
    }
  });

  req.on('close', unsubscribe);
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

  sendJson(res, 200, {
    protocolVersion: 1,
    runId: run.auditRunId,
    claimId,
    status: run.status,
    outcome: run.outcome ?? null,
    faithfulnessVerdict: faithfulnessRow?.verdict ?? null,
    leanSource: artifactRow?.leanSource ?? null,
    diagnostics: [],
    durationMs: run.durationMs ?? null,
  });
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
    const settings = parseSettings(project.settingsJson);
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
        leanVersion: (settings['leanVersion'] as string | undefined) ?? DEFAULT_LEAN_VERSION,
        mathlibRevision: (settings['mathlibRevision'] as string | undefined) ?? DEFAULT_MATHLIB_REVISION,
      },
      claimStatuses: listProjectClaimStatuses(db, project.projectId),
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

  const {
    overleafProjectId,
    overleafUrl,
    name,
    leanVersion = DEFAULT_LEAN_VERSION,
    mathlibRevision = DEFAULT_MATHLIB_REVISION,
  } = body.data;

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
    JSON.stringify({ leanVersion, mathlibRevision }),
  );

  // Create default provider configs using env-var defaults.
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

function handleGetProject(res: ServerResponse, projectId: string): void {
  const project = db
    .prepare('SELECT * FROM projects WHERE projectId = ?')
    .get(projectId) as ProjectRow | undefined;

  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return;
  }

  const settings = parseSettings(project.settingsJson);
  sendJson(res, 200, {
    id: project.projectId,
    name: project.name,
    sourceKind: project.sourceKind,
    overleafProjectId: project.overleafProjectId,
    createdAt: project.createdAt,
    lastOpenedAt: project.lastOpenedAt,
    leanVersion: settings.leanVersion ?? DEFAULT_LEAN_VERSION,
    mathlibRevision: settings.mathlibRevision ?? DEFAULT_MATHLIB_REVISION,
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

async function handleListProviderConfigs(res: ServerResponse): Promise<void> {
  const formalizer = db
    .prepare("SELECT * FROM model_provider_configs WHERE projectId IS NULL AND role = 'formalizer'")
    .get() as ProviderConfigRow | undefined;

  const auxiliary = db
    .prepare("SELECT * FROM model_provider_configs WHERE projectId IS NULL AND role = 'auxiliary'")
    .get() as ProviderConfigRow | undefined;

  const keyPresence = await checkNamedKeyPresence();

  const formalizerBaseUrl = formalizer?.baseUrl ?? '';
  const featherlessActive = formalizerBaseUrl.includes('featherless.ai');
  const configId = formalizer?.providerConfigId ?? '';

  sendJson(res, 200, {
    formalizerOptions: [
      {
        optionKey: 'novita',
        label: NAMED_FORMALIZER_PROVIDERS.novita.label,
        provider: NAMED_FORMALIZER_PROVIDERS.novita.provider,
        baseUrl: NAMED_FORMALIZER_PROVIDERS.novita.baseUrl,
        modelId: NAMED_FORMALIZER_PROVIDERS.novita.modelId,
        active: !featherlessActive,
        hasKey: keyPresence.novita,
        configId,
      },
      {
        optionKey: 'featherless',
        label: NAMED_FORMALIZER_PROVIDERS.featherless.label,
        provider: NAMED_FORMALIZER_PROVIDERS.featherless.provider,
        baseUrl: NAMED_FORMALIZER_PROVIDERS.featherless.baseUrl,
        modelId: NAMED_FORMALIZER_PROVIDERS.featherless.modelId,
        active: featherlessActive,
        hasKey: keyPresence.featherless,
        configId,
      },
    ],
    auxiliaryConfig: auxiliary
      ? {
          providerConfigId: auxiliary.providerConfigId,
          modelId: auxiliary.modelId,
          baseUrl: auxiliary.baseUrl,
          hasKey: keyPresence.openrouter || hasApiKeyEnv(auxiliary, process.env),
        }
      : null,
  });
}

async function checkNamedKeyPresence(): Promise<{ novita: boolean; featherless: boolean; openrouter: boolean }> {
  const result = {
    novita: Boolean(process.env[NAMED_FORMALIZER_PROVIDERS.novita.envKey]?.trim()),
    featherless: Boolean(process.env[NAMED_FORMALIZER_PROVIDERS.featherless.envKey]?.trim()),
    openrouter: Boolean(process.env[NAMED_AUXILIARY_PROVIDER.envKey]?.trim()),
  };

  try {
    const keytar = await import('keytar');
    const [novita, featherless, openrouter] = await Promise.all([
      keytar.default.getPassword('lale', 'novita.ai'),
      keytar.default.getPassword('lale', 'featherless.ai'),
      keytar.default.getPassword('lale', 'openrouter.ai'),
    ]);
    if (novita) result.novita = true;
    if (featherless) result.featherless = true;
    if (openrouter) result.openrouter = true;
  } catch { /* keytar unavailable — env-var results stand */ }

  return result;
}

async function handleSwitchFormalizer(
  req: IncomingMessage,
  res: ServerResponse,
  configId: string,
): Promise<void> {
  const body = await readJson(req) as { optionKey?: unknown } | null;
  const optionKey = body?.optionKey;
  if (optionKey !== 'novita' && optionKey !== 'featherless') {
    sendJson(res, 400, { error: 'optionKey must be "novita" or "featherless"' });
    return;
  }

  const spec = NAMED_FORMALIZER_PROVIDERS[optionKey];

  const globalConfig = db
    .prepare("SELECT providerConfigId FROM model_provider_configs WHERE providerConfigId = ? AND projectId IS NULL AND role = 'formalizer'")
    .get(configId) as { providerConfigId: string } | undefined;
  if (!globalConfig) {
    sendJson(res, 404, { error: 'Formalizer config not found' });
    return;
  }

  // Carry over a keytar key for the new provider if it already exists.
  let apiKeyRef: string | null = null;
  try {
    const keytar = await import('keytar');
    const [service, account] = spec.keyRef.split(':') as [string, string];
    const key = await keytar.default.getPassword(service, account);
    if (key) apiKeyRef = spec.keyRef;
  } catch { /* ignore */ }
  if (!apiKeyRef && process.env[spec.envKey]?.trim()) apiKeyRef = spec.keyRef;

  const result = db
    .prepare(
      `UPDATE model_provider_configs
       SET providerKind = 'openaiCompatible', baseUrl = ?, modelId = ?, apiKeyRef = ?, updatedAt = ?
       WHERE role = 'formalizer'`,
    )
    .run(spec.baseUrl, spec.modelId, apiKeyRef, new Date().toISOString());

  if (result.changes === 0) {
    sendJson(res, 404, { error: 'Formalizer config not found' });
    return;
  }

  sendJson(res, 200, { ok: true });
}

async function handleSetNamedProviderKey(
  req: IncomingMessage,
  res: ServerResponse,
  provider: string,
): Promise<void> {
  const isKnown = provider in NAMED_FORMALIZER_PROVIDERS || provider === 'openrouter';
  if (!isKnown) {
    sendJson(res, 404, { error: 'Unknown provider' });
    return;
  }

  const spec = provider === 'openrouter'
    ? NAMED_AUXILIARY_PROVIDER
    : NAMED_FORMALIZER_PROVIDERS[provider as 'novita' | 'featherless'];

  const body = await readJson(req) as { key?: unknown } | null;
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  if (!key) {
    sendJson(res, 400, { error: 'key is required' });
    return;
  }

  const [service, account] = spec.keyRef.split(':') as [string, string];
  try {
    const keytar = await import('keytar');
    await keytar.default.setPassword(service, account, key);
  } catch (err) {
    sendJson(res, 500, { error: `Failed to store key in keychain: ${String(err)}` });
    return;
  }

  db.prepare(
    `UPDATE model_provider_configs SET apiKeyRef = ?, updatedAt = ? WHERE baseUrl = ?`,
  ).run(spec.keyRef, new Date().toISOString(), spec.baseUrl);

  sendJson(res, 200, { ok: true });
}

async function handleClearNamedProviderKey(res: ServerResponse, provider: string): Promise<void> {
  const isKnown = provider in NAMED_FORMALIZER_PROVIDERS || provider === 'openrouter';
  if (!isKnown) {
    sendJson(res, 404, { error: 'Unknown provider' });
    return;
  }

  const spec = provider === 'openrouter'
    ? NAMED_AUXILIARY_PROVIDER
    : NAMED_FORMALIZER_PROVIDERS[provider as 'novita' | 'featherless'];

  const [service, account] = spec.keyRef.split(':') as [string, string];
  try {
    const keytar = await import('keytar');
    await keytar.default.deletePassword(service, account);
  } catch { /* best-effort */ }

  db.prepare(
    `UPDATE model_provider_configs SET apiKeyRef = NULL, updatedAt = ? WHERE apiKeyRef = ?`,
  ).run(new Date().toISOString(), spec.keyRef);

  sendJson(res, 200, { ok: true });
}

async function handleSetProviderKey(
  req: IncomingMessage,
  res: ServerResponse,
  configId: string,
): Promise<void> {
  const body = await readJson(req) as { key?: unknown } | null;
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  if (!key) {
    sendJson(res, 400, { error: 'key is required' });
    return;
  }

  const config = db
    .prepare('SELECT * FROM model_provider_configs WHERE providerConfigId = ? AND projectId IS NULL')
    .get(configId) as ProviderConfigRow | undefined;
  if (!config) {
    sendJson(res, 404, { error: 'Provider config not found' });
    return;
  }

  const keyRef = deriveKeyRef(config);
  const [service, account] = keyRef.split(':') as [string, string];

  try {
    const keytar = await import('keytar');
    await keytar.default.setPassword(service, account, key);
  } catch (err) {
    sendJson(res, 500, { error: `Failed to store key in keychain: ${String(err)}` });
    return;
  }

  // Update every config that hits the same provider endpoint so projects share the ref.
  db.prepare(
    `UPDATE model_provider_configs SET apiKeyRef = ?, updatedAt = ?
     WHERE (baseUrl = ? AND baseUrl IS NOT NULL)
       OR providerConfigId = ?
     `,
  ).run(keyRef, new Date().toISOString(), config.baseUrl, configId);

  sendJson(res, 200, { ok: true });
}

async function handleClearProviderKey(res: ServerResponse, configId: string): Promise<void> {
  const config = db
    .prepare('SELECT * FROM model_provider_configs WHERE providerConfigId = ? AND projectId IS NULL')
    .get(configId) as ProviderConfigRow | undefined;
  if (!config) {
    sendJson(res, 404, { error: 'Provider config not found' });
    return;
  }

  const keyRef = config.apiKeyRef;
  if (!keyRef) {
    sendJson(res, 200, { ok: true });
    return;
  }

  const [service, account] = keyRef.split(':') as [string, string];
  try {
    const keytar = await import('keytar');
    await keytar.default.deletePassword(service, account);
  } catch {
    // Best-effort — proceed to clear the DB ref even if keychain removal fails.
  }

  db.prepare(
    `UPDATE model_provider_configs SET apiKeyRef = NULL, updatedAt = ? WHERE apiKeyRef = ?`,
  ).run(new Date().toISOString(), keyRef);

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
  req: IncomingMessage,
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

  void inspectProvisionedProject(leanProjectDir).then(async () => {
    const state = await getProvisionState();
    if (state.provisionId === provisionId && state.status !== 'running') {
      res.write(
        `event: complete\ndata: ${JSON.stringify({ provisionId, status: state.status, error: state.error })}\n\n`,
      );
      res.end();
    }
  });

  const unsubscribe = subscribeProvisionSse(provisionId, (chunk) => {
    res.write(chunk);
    if (chunk.startsWith('event: complete')) {
      // The provisioning state has changed; force-refresh the health snapshot.
      invalidateLeanStatusCache();
      clearMathlibImportIndexCache();
      res.end();
      unsubscribe();
    }
  });

  req.on('close', unsubscribe);
}

function markInterruptedRuns(db: DatabaseInstance): void {
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

  console.log(`Marked ${interruptedRuns.length} interrupted audit run(s) as verificationBlocked`);
}

function listProjectClaimStatuses(
  db: DatabaseInstance,
  projectId: string,
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
        `SELECT ar.auditRunId, ar.status, ar.phase, ar.outcome, ar.startedAt, ar.finishedAt
         FROM audit_runs ar
         JOIN claim_revisions cr ON cr.claimRevisionId = ar.targetClaimRevisionId
         WHERE cr.claimIdentityId = ?
         ORDER BY ar.startedAt DESC
         LIMIT 1`,
      )
      .get(identity.claimIdentityId) as {
        auditRunId: string;
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
      label: identity.currentLabel,
      kind: identity.currentKind,
      status: normalizeClaimStatus(identity.statusCache, latestRun),
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
// Default provider config bootstrap (env-var based, for v0)
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
        `SELECT role, providerKind, baseUrl, modelId, apiKeyRef
         FROM model_provider_configs
         WHERE projectId IS NULL AND role IN ('formalizer', 'auxiliary')`,
      )
      .all() as Array<Pick<ProviderConfigRow, 'role' | 'providerKind' | 'baseUrl' | 'modelId' | 'apiKeyRef'>>;

    if (globalConfigs.length > 0) {
      for (const { role, providerKind, baseUrl, modelId, apiKeyRef } of globalConfigs) {
        db.prepare(
          `INSERT INTO model_provider_configs
             (providerConfigId, projectId, role, providerKind, baseUrl, modelId, apiKeyRef, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(randomUUID(), projectId, role, providerKind, baseUrl, modelId, apiKeyRef, now, now);
      }
      return;
    }
  }

  // v0: API keys are resolved at call time from role/provider-specific env vars
  // (or later keytar). The apiKeyRef column stays null until a settings UI
  // writes a keytar entry.
  const apiKeyRef: string | null = null;

  for (const { role, providerKind, baseUrl, modelId } of defaultProviderConfigSpecs(process.env)) {
    db.prepare(
      `INSERT INTO model_provider_configs
         (providerConfigId, projectId, role, providerKind, baseUrl, modelId, apiKeyRef, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), projectId, role, providerKind, baseUrl, modelId, apiKeyRef, now, now);
  }
}

function syncDefaultAuxiliaryConfig(db: DatabaseInstance): void {
  const auxiliary = defaultProviderConfigSpecs(process.env).find((config) => config.role === 'auxiliary');
  if (!auxiliary) return;

  const existing = db
    .prepare("SELECT * FROM model_provider_configs WHERE projectId IS NULL AND role = 'auxiliary'")
    .get() as ProviderConfigRow | undefined;
  const now = new Date().toISOString();

  if (!existing) {
    db.prepare(
      `INSERT INTO model_provider_configs
         (providerConfigId, projectId, role, providerKind, baseUrl, modelId, apiKeyRef, createdAt, updatedAt)
       VALUES (?, NULL, 'auxiliary', ?, ?, ?, NULL, ?, ?)`,
    ).run(randomUUID(), auxiliary.providerKind, auxiliary.baseUrl, auxiliary.modelId, now, now);
    return;
  }

  db.prepare(
    `UPDATE model_provider_configs
     SET providerKind = ?,
         baseUrl = ?,
         modelId = ?,
         updatedAt = ?
     WHERE providerConfigId = ?`,
  ).run(auxiliary.providerKind, auxiliary.baseUrl, auxiliary.modelId, now, existing.providerConfigId);
}

function syncProjectProviderConfigsFromGlobal(db: DatabaseInstance): void {
  const globalConfigs = db
    .prepare(
      `SELECT role, providerKind, baseUrl, modelId, apiKeyRef
       FROM model_provider_configs
       WHERE projectId IS NULL AND role IN ('formalizer', 'auxiliary')`,
    )
    .all() as Array<Pick<ProviderConfigRow, 'role' | 'providerKind' | 'baseUrl' | 'modelId' | 'apiKeyRef'>>;

  const now = new Date().toISOString();
  for (const { role, providerKind, baseUrl, modelId, apiKeyRef } of globalConfigs) {
    db.prepare(
      `UPDATE model_provider_configs
       SET providerKind = ?,
           baseUrl = ?,
           modelId = ?,
           apiKeyRef = ?,
           updatedAt = ?
       WHERE projectId IS NOT NULL AND role = ?`,
    ).run(providerKind, baseUrl, modelId, apiKeyRef, now, role);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  try { return JSON.parse(body); } catch { return null; }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function parseSettings(settingsJson: string): Record<string, unknown> {
  try { return JSON.parse(settingsJson) as Record<string, unknown>; } catch { return {}; }
}

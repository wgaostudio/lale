import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import {
  isVerifiableClaimKind,
  PARSER_VERSION,
  parseLatexDocument,
  type ParsedDocument,
} from '@lale/document-parser';
import { LeanCheckCache, deriveCacheKey, type CacheKey } from '@lale/cache';
import { LeanRunner } from '@lale/lean-runner';
import { RunBudget, ModelClient, informalAudit as runInformalAudit } from '@lale/translator';
import type { VerificationOutcome, RunPhase } from '@lale/protocol';
import type { AuditRunRow, ProviderConfigRow } from '../db.js';
import {
  buildAuditGraph,
  selectReachableContext,
  buildEnvironmentFingerprint,
  formatDependencyDeclarations,
  type NormalizedClaimContext,
  type ResolvedDependency,
} from './context.js';
import {
  composeLeanFile,
  formalizeAndCheck,
  formalizeDefinitionAndCheck,
  type FormalizeProgressEvent,
  type StatementAttempt,
} from './formalize.js';
import { checkDefinitionFaithfulness, checkFaithfulness } from './faithfulness.js';
import { runProposer, type ProposerResult } from './proposer.js';
import { ACCEPTABLE_FAITHFULNESS, runFinalGate } from './gate.js';
import { checkProofSkeleton } from './proof-steps.js';
import { validateCachedProof } from './cache-proof.js';
import { extractLeanImports, getMathlibImportIndex } from './mathlib-index.js';
import type { VerificationMode } from '@lale/protocol';
import { getAccountBalance, getModelPricing, formatUsd } from '../pricing.js';
import { withHeartbeat } from './heartbeat.js';
import { sha256 } from './hash.js';

// ---------------------------------------------------------------------------
// Key storage (keytar only — keys are entered in the extension settings UI)
// ---------------------------------------------------------------------------

async function resolveApiKey(config: ProviderConfigRow): Promise<string> {
  if (!config.apiKeyRef) {
    throw new Error(
      `No API key configured for ${config.role} model ${config.modelId}. ` +
        `Add your OpenRouter API key in the lale extension settings.`,
    );
  }

  // Try keytar (OS secure storage).
  try {
    const keytar = await import('keytar');
    const [service, account] = config.apiKeyRef.split(':');
    if (!service || !account) throw new Error(`Invalid keyRef format: ${config.apiKeyRef}`);
    const key = await keytar.default.getPassword(service, account);
    if (!key) throw new Error(`Key not found in keychain for ref: ${config.apiKeyRef}`);
    return key;
  } catch (err) {
    throw new Error(`Failed to retrieve API key: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Budget tracking
// ---------------------------------------------------------------------------

function checkBudget(budget: RunBudget): void {
  if (budget.inputTokens + budget.outputTokens >= budget.cap) throw new Error('Run token budget exhausted');
}

// ---------------------------------------------------------------------------
// Run event helpers
// ---------------------------------------------------------------------------

type EventEmitter = (
  phase: RunPhase,
  level: 'info' | 'warning' | 'error',
  message: string,
  payload?: unknown,
) => void;

function makeEventEmitter(db: Database, auditRunId: string): EventEmitter {
  return (phase, level, message, payload) => {
    const event = {
      eventId: randomUUID(),
      auditRunId,
      timestamp: new Date().toISOString(),
      phase,
      level,
      message,
      payload,
    };

    db.prepare(
      `INSERT INTO run_events (eventId, auditRunId, timestamp, phase, level, message, payloadJson)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.eventId,
      event.auditRunId,
      event.timestamp,
      event.phase,
      event.level,
      event.message,
      payload !== undefined ? JSON.stringify(payload) : null,
    );

    emitSse(auditRunId, 'run_event', event);
    logRunEvent(event);
  };
}

function logRunEvent(event: {
  auditRunId: string;
  phase: RunPhase;
  level: 'info' | 'warning' | 'error';
  message: string;
  payload?: unknown;
}): void {
  const log = event.level === 'error' ? console.error : event.level === 'warning' ? console.warn : console.info;
  const runPrefix = event.auditRunId.slice(0, 8);
  const payload = summarizePayload(event.payload);
  log(`[lale run ${runPrefix}] [${event.phase}] ${event.message}${payload ? ` ${payload}` : ''}`);
}

function summarizePayload(payload: unknown): string {
  if (payload === undefined) return '';
  try {
    const serialized = JSON.stringify(payload);
    return serialized.length > 1400 ? `${serialized.slice(0, 1400)}…` : serialized;
  } catch {
    return String(payload);
  }
}

function updateRunStatus(
  db: Database,
  auditRunId: string,
  status: string,
  phase?: string,
  outcome?: string,
  finishedAt?: string,
  durationMs?: number,
): void {
  db.prepare(
    `UPDATE audit_runs SET status = ?, phase = ?, outcome = ?, finishedAt = ?, durationMs = ?
     WHERE auditRunId = ?`,
  ).run(status, phase ?? null, outcome ?? null, finishedAt ?? null, durationMs ?? null, auditRunId);
}

function updateClaimStatusCacheForOutcome(
  db: Database,
  auditRunId: string,
  outcome: VerificationOutcome,
): void {
  const statusCache = claimStatusForOutcome(outcome);
  db.prepare(
    `UPDATE claim_identities
     SET statusCache = ?
     WHERE claimIdentityId = (
       SELECT cr.claimIdentityId
       FROM audit_runs ar
       JOIN claim_revisions cr ON cr.claimRevisionId = ar.targetClaimRevisionId
       WHERE ar.auditRunId = ?
     )`,
  ).run(statusCache, auditRunId);
}

function claimStatusForOutcome(outcome: VerificationOutcome): string {
  switch (outcome) {
    case 'verified':
      return 'verified';
    case 'formalized':
      return 'formalized';
    case 'dependencyMissing':
    case 'verificationBlocked':
      return 'blocked';
    default:
      return 'failed';
  }
}

export class InformalAuditNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InformalAuditNotFoundError';
  }
}

export interface InformalAuditAcknowledgementResult {
  acknowledgedAt: string;
  resumed: boolean;
  wasPaused: boolean;
}

// ---------------------------------------------------------------------------
// SSE subscriber registry (keyed by runId)
// ---------------------------------------------------------------------------

type SseCallback = (event: string) => void;

const sseSubscribers = new Map<string, Set<SseCallback>>();

export function subscribeSse(runId: string, callback: SseCallback): () => void {
  let set = sseSubscribers.get(runId);
  if (!set) {
    set = new Set();
    sseSubscribers.set(runId, set);
  }
  set.add(callback);
  return () => {
    set!.delete(callback);
    if (set!.size === 0) sseSubscribers.delete(runId);
  };
}

function emitSse(runId: string, eventName: string, data: unknown): void {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const cb of sseSubscribers.get(runId) ?? []) cb(payload);
}

// ---------------------------------------------------------------------------
// Build model clients from DB config rows
// ---------------------------------------------------------------------------

function heartbeatTick(emit: EventEmitter, phase: RunPhase, label: string): (elapsedMs: number) => void {
  return (elapsedMs) =>
    emit(phase, 'info', `${label}: still working (${Math.round(elapsedMs / 1000)}s)`, { elapsedMs });
}

function formatSpend(budget: RunBudget): string {
  const spent = budget.spentUsd;
  return spent === null ? '' : ` (${formatUsd(spent)})`;
}

/**
 * Prices the run and checks the account can pay for it. Returns false only when
 * the balance cannot cover a single worst-case request — the condition that
 * otherwise surfaces as a 402 partway through, after earlier calls have already
 * been billed. A balance that merely looks tight is reported, not blocked.
 */
async function preflightCost(
  db: Database,
  config: PipelineConfig,
  budget: RunBudget,
  emit: EventEmitter,
): Promise<boolean> {
  const proposerRow = db
    .prepare('SELECT * FROM model_provider_configs WHERE providerConfigId = ?')
    .get(config.proposerConfigId) as ProviderConfigRow | undefined;
  if (!proposerRow) return true;

  const pricing = await getModelPricing(proposerRow.baseUrl, proposerRow.modelId);
  if (!pricing) {
    emit('selectContext', 'info', 'Model prices unavailable; tracking tokens only');
    return true;
  }
  budget.pricing = pricing;

  const worstCaseUsd = budget.remainingWorstCaseUsd ?? 0;
  // The provider holds credit against `max_tokens` for the whole request, so a
  // single request needs the ceiling covered up front, not the average.
  const singleRequestUsd = (proposerRow.maxTokens ?? 32_768) * pricing.completion;

  let balanceNote = '';
  try {
    const balance = await getAccountBalance(proposerRow.baseUrl, await resolveApiKey(proposerRow));
    if (balance) {
      balanceNote = `, balance ${formatUsd(balance.remainingUsd)}`;
      if (balance.remainingUsd < singleRequestUsd) {
        emit(
          'selectContext',
          'error',
          `Insufficient credit: one request reserves up to ${formatUsd(singleRequestUsd)} but the balance is ${formatUsd(balance.remainingUsd)}. Add credits at https://openrouter.ai/credits.`,
        );
        return false;
      }
    }
  } catch {
    // No key, no keychain, or the endpoint is down: let the run proceed and let
    // the provider be the authority on whether it can be paid for.
  }

  emit(
    'selectContext',
    'info',
    `Cost ceiling for this run: ${formatUsd(worstCaseUsd)} (${budget.cap} tokens at ${formatUsd(pricing.completion * 1_000_000)}/M output)${balanceNote}`,
  );
  return true;
}

async function buildModelClient(
  db: Database,
  configId: string,
  budget: RunBudget,
  emit: EventEmitter,
  auditRunId: string,
): Promise<ModelClient> {
  const row = db
    .prepare('SELECT * FROM model_provider_configs WHERE providerConfigId = ?')
    .get(configId) as ProviderConfigRow | undefined;

  if (!row) throw new Error(`Provider config not found: ${configId}`);

  const apiKey = await resolveApiKey(row);

  // Events are attributed to whatever phase the run is in when the model
  // answers, which can be several stages after the client was built.
  const currentPhase = (): RunPhase => {
    const row = db
      .prepare('SELECT phase FROM audit_runs WHERE auditRunId = ?')
      .get(auditRunId) as { phase: RunPhase | null } | undefined;
    return row?.phase ?? 'complete';
  };

  const clientConfig: import('@lale/translator').ModelClientConfig = {
    apiKey, budget,
    onNotice: message => emit(currentPhase(), 'warning', message, { model: row.modelId, role: row.role }),
    onUsage: usage => emit(currentPhase(), 'info', 'Model request completed', { model: row.modelId, role: row.role, reasoningEffort: row.reasoningEffort, usage, totalTokens: budget.inputTokens + budget.outputTokens }),
    modelId: row.modelId,
    ...(row.reasoningEffort ? { reasoningEffort: row.reasoningEffort } : {}),
    ...(row.baseUrl != null ? { baseURL: row.baseUrl } : {}),
    ...(row.maxTokens != null ? { maxTokens: row.maxTokens } : {}),
    ...(row.temperature != null ? { temperature: row.temperature } : {}),
    timeoutMs: modelTimeoutMs(),
  };
  return new ModelClient(clientConfig);
}

function modelTimeoutMs(): number {
  const raw = process.env['LALE_MODEL_TIMEOUT_MS'];
  if (!raw) return 600_000;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
}

// ---------------------------------------------------------------------------
// Save snapshot to DB and resolve claim revision
// ---------------------------------------------------------------------------

function upsertSnapshot(
  db: Database,
  projectId: string,
  doc: ParsedDocument,
  documentText: string,
  parserVersion: string,
): string {
  const existing = db
    .prepare(
      `SELECT snapshotId FROM document_snapshots
       WHERE projectId = ? AND documentFingerprint = ? AND parserVersion = ?`,
    )
    .get(projectId, doc.fingerprint, parserVersion) as { snapshotId: string } | undefined;

  if (existing) return existing.snapshotId;

  const snapshotId = randomUUID();
  db.prepare(
    `INSERT INTO document_snapshots
       (snapshotId, projectId, documentFingerprint, parserVersion, capturedAt, documentText, parsedDocumentJson, issuesJson)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    snapshotId,
    projectId,
    doc.fingerprint,
    parserVersion,
    new Date().toISOString(),
    documentText,
    JSON.stringify(doc),
    JSON.stringify(doc.issues),
  );

  return snapshotId;
}

// ---------------------------------------------------------------------------
// Staleness propagation (§12)
// ---------------------------------------------------------------------------

/**
 * Marks the changed claim stale, along with everything that transitively
 * depends on it — editing a lemma invalidates the theorems that cite it.
 *
 * The graph comes from the parse the run is already holding. The `§10.6`
 * `dependency_edges` table was designed for this, but an edge row keys both
 * endpoints to `claim_revisions` and a run materializes a revision only for its
 * own target, so filling it would mean persisting a revision for every claim in
 * the document. The parser has already resolved these edges, and reading them
 * needs no new rows at all.
 */
export function propagateStaleness(
  db: Database,
  projectId: string,
  doc: ParsedDocument,
  changedClaimId: string,
): void {
  // `edge.from` depends on `edge.to`, so dependents are found by walking back.
  const dependents = new Map<string, string[]>();
  for (const edge of doc.edges) {
    const existing = dependents.get(edge.to);
    if (existing) existing.push(edge.from);
    else dependents.set(edge.to, [edge.from]);
  }

  // Only a claim that had been established loses something by going stale;
  // pending and failed ones are already not verified.
  const markStale = db.prepare(
    `UPDATE claim_identities SET statusCache = 'stale'
     WHERE claimIdentityId = ? AND statusCache IN ('verified','verifiedByOverride','formalized')`,
  );
  const findIdentity = db.prepare(
    'SELECT claimIdentityId FROM claim_identities WHERE projectId = ? AND currentLabel = ?',
  );
  const claimsById = new Map(doc.claims.map((claim) => [claim.id, claim]));

  const visited = new Set<string>();
  const queue = [changedClaimId];

  while (queue.length > 0) {
    const claimId = queue.shift()!;
    if (visited.has(claimId)) continue;
    visited.add(claimId);

    // Identities exist only for claims that have been run before; the rest have
    // nothing cached to invalidate, but their dependents still might.
    const identityKey = claimsById.get(claimId)?.label ?? claimId;
    const identity = findIdentity.get(projectId, identityKey) as
      | { claimIdentityId: string }
      | undefined;
    if (identity) markStale.run(identity.claimIdentityId);

    queue.push(...(dependents.get(claimId) ?? []));
  }
}

function upsertClaimRevision(
  db: Database,
  projectId: string,
  snapshotId: string,
  claimId: string,
  doc: ParsedDocument,
): string {
  const claim = doc.claims.find((c) => c.id === claimId);
  if (!claim) throw new Error(`Claim not found in parsed document: ${claimId}`);

  // Find or create claim identity.
  let identity = db
    .prepare(
      `SELECT claimIdentityId FROM claim_identities WHERE projectId = ? AND currentLabel = ?`,
    )
    .get(projectId, claim.label ?? claimId) as { claimIdentityId: string } | undefined;

  const identityWasNew = !identity;

  if (!identity) {
    const identityId = randomUUID();
    db.prepare(
      `INSERT INTO claim_identities (claimIdentityId, projectId, currentLabel, currentKind, firstSeenAt, lastSeenAt, statusCache)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      identityId,
      projectId,
      claim.label ?? null,
      claim.kind,
      new Date().toISOString(),
      new Date().toISOString(),
      'pending',
    );
    identity = { claimIdentityId: identityId };
  } else {
    db.prepare(
      `UPDATE claim_identities SET lastSeenAt = ?, currentKind = ? WHERE claimIdentityId = ?`,
    ).run(new Date().toISOString(), claim.kind, identity.claimIdentityId);
  }

  // Upsert claim revision.
  const existing = db
    .prepare(
      `SELECT claimRevisionId FROM claim_revisions
       WHERE claimIdentityId = ? AND claimFingerprint = ?`,
    )
    .get(identity.claimIdentityId, claim.fingerprint) as { claimRevisionId: string } | undefined;

  if (existing) return existing.claimRevisionId;

  // New revision for an existing identity — propagate staleness to verified dependents.
  if (!identityWasNew) {
    propagateStaleness(db, projectId, doc, claimId);
  }

  const revisionId = randomUUID();
  const proofFingerprint = claim.proof ? sha256(claim.proof.text) : null;

  db.prepare(
    `INSERT INTO claim_revisions
       (claimRevisionId, claimIdentityId, snapshotId, label, kind, title, statement, body, proofText,
        startLine, endLine, startOffset, endOffset, claimFingerprint, proofFingerprint, dependenciesJson)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    revisionId,
    identity.claimIdentityId,
    snapshotId,
    claim.label ?? null,
    claim.kind,
    claim.title ?? null,
    claim.statement,
    claim.body,
    claim.proof?.text ?? null,
    claim.startLine,
    claim.endLine,
    claim.startOffset,
    claim.endOffset,
    claim.fingerprint,
    proofFingerprint,
    JSON.stringify(claim.dependencies),
  );

  return revisionId;
}

// ---------------------------------------------------------------------------
// Main pipeline entry point
// ---------------------------------------------------------------------------

export interface PipelineInput {
  requestId: string;
  projectId: string;
  claimId: string;
  documentText: string;
  parsedDocumentFingerprint: string;
  parserVersion: string;
  leanProjectDir: string;
  mode?: VerificationMode;
}

/** Per-run caps, used both to start a run and to rehydrate a paused one. */
export const DEFAULT_TOKEN_BUDGET_CAP = 250_000;
export const DEFAULT_WALL_CLOCK_CAP_MS = 60_000;

export interface PipelineConfig {
  leanVersion: string;
  mathlibRevision: string;
  proposerConfigId: string;
  formalizerConfigId: string;
  auxiliaryConfigId: string;
  tokenBudgetCap: number;
  wallClockCapMs: number;
}

interface ExecutePipelineOptions {
  initialTokenUsage?: {
    inputTokens: number;
    outputTokens: number;
  };
  skipInformalAudit?: boolean;
}

export async function runPipeline(
  db: Database,
  input: PipelineInput,
  config: PipelineConfig,
): Promise<string> {
  // Create the audit run record immediately.
  const auditRunId = randomUUID();
  const startedAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO audit_runs
       (auditRunId, projectId, requestId, mode, status, phase, startedAt,
        leanVersion, mathlibRevision, proposerConfigId, formalizerConfigId, auxiliaryConfigId)
     VALUES (?, ?, ?, ?, 'queued', 'parseSnapshot', ?, ?, ?, ?, ?, ?)`,
  ).run(
    auditRunId,
    input.projectId,
    input.requestId,
    input.mode ?? 'full',
    startedAt,
    config.leanVersion,
    config.mathlibRevision,
    config.proposerConfigId,
    config.formalizerConfigId,
    config.auxiliaryConfigId,
  );

  // Run asynchronously without blocking the caller.
  void executePipeline(db, auditRunId, input, config, startedAt);

  return auditRunId;
}

export async function acknowledgeInformalAudit(
  db: Database,
  auditRunId: string,
  reason: string,
  leanProjectDir: string,
): Promise<InformalAuditAcknowledgementResult> {
  const trimmedReason = reason.trim();
  if (!trimmedReason) throw new Error('Acknowledgement reason is required.');

  const audit = db
    .prepare(
      `SELECT informalAuditId, paused
       FROM informal_audits
       WHERE auditRunId = ?
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(auditRunId) as { informalAuditId: string; paused: number } | undefined;

  if (!audit) {
    throw new InformalAuditNotFoundError('No informal audit found for this run');
  }

  const run = db
    .prepare('SELECT * FROM audit_runs WHERE auditRunId = ?')
    .get(auditRunId) as AuditRunRow | undefined;

  if (!run) {
    throw new InformalAuditNotFoundError('Run not found');
  }

  const acknowledgedAt = new Date().toISOString();
  const wasPaused = run.status === 'paused' && audit.paused === 1;

  db.prepare(
    `UPDATE informal_audits
     SET paused = 0, overriddenAt = ?, overrideReason = ?
     WHERE informalAuditId = ?`,
  ).run(acknowledgedAt, trimmedReason, audit.informalAuditId);

  const emit = makeEventEmitter(db, auditRunId);
  emit(
    'informalAudit',
    'info',
    wasPaused
      ? 'Advisory acknowledged; resuming formal verification'
      : 'Advisory acknowledged',
    {
      paused: false,
      overridden: true,
      overrideReason: trimmedReason,
      overriddenAt: acknowledgedAt,
    },
  );

  if (wasPaused) {
    void resumePipelineAfterInformalAcknowledgement(db, auditRunId, leanProjectDir);
  }

  return { acknowledgedAt, resumed: wasPaused, wasPaused };
}

async function executePipeline(
  db: Database,
  auditRunId: string,
  input: PipelineInput,
  config: PipelineConfig,
  startedAt: string,
  options: ExecutePipelineOptions = {},
): Promise<void> {
  const emit = makeEventEmitter(db, auditRunId);
  const budget = new RunBudget(config.tokenBudgetCap,
    options.initialTokenUsage?.inputTokens ?? 0, options.initialTokenUsage?.outputTokens ?? 0);

  const finish = (outcome: VerificationOutcome, phase: RunPhase = 'complete'): void => {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - new Date(startedAt).getTime();
    updateRunStatus(db, auditRunId, 'finished', phase, outcome, finishedAt, durationMs);
    updateClaimStatusCacheForOutcome(db, auditRunId, outcome);
    emit(phase, 'info', `Run finished: ${outcome}`, { outcome });
    emitSse(auditRunId, 'complete', { auditRunId, outcome });
  };

  try {
    updateRunStatus(db, auditRunId, 'running', 'parseSnapshot');

    // ── §3.1-3.2 Parse snapshot ──────────────────────────────────────────
    emit('parseSnapshot', 'info', 'Parsing document snapshot');
    const doc: ParsedDocument = parseLatexDocument(input.documentText);

    if (doc.fingerprint !== input.parsedDocumentFingerprint) {
      emit('parseSnapshot', 'warning', 'Document fingerprint mismatch — using desktop parse');
    }

    const targetClaim = doc.claims.find((claim) => claim.id === input.claimId);
    if (!targetClaim) {
      emit('parseSnapshot', 'error', `Document item not found: ${input.claimId}`);
      finish('verificationBlocked', 'parseSnapshot');
      return;
    }
    // Definitions never carry a proof; `formalizeOnly` opts a provable claim
    // out of proof generation for this run.
    const targetIsTheorem = isVerifiableClaimKind(targetClaim.kind);
    const targetNeedsProof = targetIsTheorem && input.mode !== 'formalizeOnly';
    const artifactLabel = targetIsTheorem ? 'Statement' : 'Definition';
    if (input.mode === 'formalizeOnly' && targetIsTheorem) {
      emit('selectContext', 'info', 'Formalize-only run: statement and faithfulness checks, no proof attempt');
    }
    if (doc.issues.some(issue => issue.severity === 'error')) {
      emit('parseSnapshot', 'error', 'Resolve document parser errors before verification');
      finish('verificationBlocked', 'parseSnapshot');
      return;
    }

    const snapshotId = upsertSnapshot(
      db,
      input.projectId,
      doc,
      input.documentText,
      PARSER_VERSION,
    );
    const claimRevisionId = upsertClaimRevision(
      db,
      input.projectId,
      snapshotId,
      input.claimId,
      doc,
    );

    db.prepare('UPDATE audit_runs SET snapshotId = ?, targetClaimRevisionId = ? WHERE auditRunId = ?')
      .run(snapshotId, claimRevisionId, auditRunId);

    // ── §3.3-3.4 Build graph and select context ──────────────────────────
    emit('buildGraph', 'info', 'Building audit graph');
    updateRunStatus(db, auditRunId, 'running', 'buildGraph');
    const graph = buildAuditGraph(doc);

    emit('selectContext', 'info', 'Selecting reachable context');
    updateRunStatus(db, auditRunId, 'running', 'selectContext');
    const context = hydrateDependencyDeclarations(
      db,
      input.projectId,
      selectReachableContext(graph, input.claimId, doc),
    );

    if (context.unresolvedDependencyLabels.length > 0) {
      emit('selectContext', 'warning', `Unresolved dependencies: ${context.unresolvedDependencyLabels.join(', ')}`);
      finish('dependencyMissing', 'selectContext');
      return;
    }

    const missingFormalizedDependencies = context.resolvedDependencies
      .filter((dependency) => !dependency.leanDeclaration)
      .map((dependency) => dependency.label);
    if (missingFormalizedDependencies.length > 0) {
      emit(
        'selectContext',
        'warning',
        `Referenced items need current accepted formalizations first: ${missingFormalizedDependencies.join(', ')}`,
      );
      finish('dependencyMissing', 'selectContext');
      return;
    }

    // ── Cost preflight ───────────────────────────────────────────────────
    // Priced before the first request, so an underfunded account is told now
    // rather than after three quarters of a run has been paid for.
    if (!(await preflightCost(db, config, budget, emit))) {
      finish('verificationBlocked', 'selectContext');
      return;
    }

    // Build all model clients once, used across all pipeline stages.
    checkBudget(budget);
    const formalizerClient = await buildModelClient(db, config.formalizerConfigId, budget, emit, auditRunId);
    const auxiliaryClient = await buildModelClient(db, config.auxiliaryConfigId, budget, emit, auditRunId);
    const proposerClient = await buildModelClient(db, config.proposerConfigId, budget, emit, auditRunId);

    const runner = new LeanRunner({
      projectDir: input.leanProjectDir,
      wallClockCapMs: config.wallClockCapMs,
    });

    // Both widen if a proof-skeleton run establishes the author's steps: from
    // that point the steps are part of the claim's environment.
    let proposerContext = context;
    let depDecls = formatDependencyDeclarations(context.resolvedDependencies);

    // ── §3.5 Informal advisory audit ─────────────────────────────────────
    if (targetNeedsProof && !options.skipInformalAudit) {
      emit('informalAudit', 'info', 'Running informal advisory audit');
      updateRunStatus(db, auditRunId, 'running', 'informalAudit');

      let informalVerdict = 'uncertain';
      let informalConfidence = 'low';
      let informalFindings: string[] = [];

      try {
        const informalResult = await withHeartbeat(
          () => runInformalAudit(
            auxiliaryClient,
            context.statementText,
            context.proofText ?? '',
            depDecls,
          ),
          heartbeatTick(emit, 'informalAudit', 'Informal advisory'),
        );
        informalVerdict = informalResult.verdict;
        informalConfidence = informalResult.confidence;
        informalFindings = informalResult.findings;
      } catch (err) {
        emit('informalAudit', 'warning', `Informal audit failed (non-blocking): ${String(err)}`);
      }

      const shouldPause = shouldPauseForInformalAudit(informalVerdict, informalConfidence);
      const informalPolicy = 'pauseOnHighConfidenceIssue';

      db.prepare(
        `INSERT INTO informal_audits
           (informalAuditId, auditRunId, verdict, confidence, findingsJson, policy, paused)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        auditRunId,
        informalVerdict,
        informalConfidence,
        JSON.stringify(informalFindings),
        informalPolicy,
        shouldPause ? 1 : 0,
      );

      if (informalVerdict !== 'noObviousIssue') {
        const payload = {
          verdict: informalVerdict,
          confidence: informalConfidence,
          findings: informalFindings,
          policy: informalPolicy,
          paused: shouldPause,
          tokenUsage: {
            inputTokens: budget.inputTokens,
            outputTokens: budget.outputTokens,
          },
        };

        if (shouldPause) {
          updateRunStatus(db, auditRunId, 'paused', 'informalAudit');
          emit(
            'informalAudit',
            'warning',
            `High-confidence advisory requires acknowledgement before formal verification: ${informalVerdict}`,
            payload,
          );
          return;
        }

        emit('informalAudit', 'warning', `Advisory: ${informalVerdict} (${informalConfidence} confidence)`, payload);
      } else {
        emit('informalAudit', 'info', 'No obvious issues found');
      }
    }

    // ── §3.7 Formalize statement ─────────────────────────────────────────
    emit('formalizeStatement', 'info', targetIsTheorem ? 'Formalizing statement' : 'Formalizing definition');
    updateRunStatus(db, auditRunId, 'running', 'formalizeStatement');
    checkBudget(budget);

    const onFormalizationAttempt = (attempt: StatementAttempt): void => {
      const diagnostics = attempt.diagnostics.slice(0, 5);
      emit(
        'formalizeStatement',
        attempt.status === 'ok' ? 'info' : 'warning',
        `${artifactLabel} formalization attempt ${attempt.attemptIndex + 1}: ${attempt.status}`,
        {
          attemptIndex: attempt.attemptIndex,
          status: attempt.status,
          leanStatus: attempt.leanResult?.status ?? null,
          elapsedMs: attempt.leanResult?.elapsedMs ?? null,
          diagnosticCount: attempt.diagnostics.length,
          diagnostics,
          leanSourcePreview: attempt.leanSource.slice(0, 2000),
        },
      );
    };

    const onFormalizationProgress = (event: FormalizeProgressEvent): void => {
      emit(
        'formalizeStatement',
        'info',
        event.message,
        {
          attemptIndex: event.attemptIndex,
          stage: event.stage,
          ...(event.payload ?? {}),
        },
      );
    };

    emit('formalizeStatement', 'info', 'Building local Mathlib import index');
    const mathlibImportIndex = await getMathlibImportIndex(input.leanProjectDir, config.mathlibRevision);
    emit(
      'formalizeStatement',
      mathlibImportIndex ? 'info' : 'warning',
      mathlibImportIndex
        ? `Local Mathlib import index ready (${mathlibImportIndex.moduleCount} modules)`
        : 'Local Mathlib import index unavailable; relying on Lean diagnostics',
      mathlibImportIndex
        ? { moduleCount: mathlibImportIndex.moduleCount, oleanCount: mathlibImportIndex.oleanCount }
        : undefined,
    );

    const formalized = targetIsTheorem
      ? await formalizeAndCheck(
          formalizerClient,
          runner,
          context,
          config.leanVersion,
          config.mathlibRevision,
          { onAttempt: onFormalizationAttempt, onProgress: onFormalizationProgress, mathlibImportIndex },
        )
      : await formalizeDefinitionAndCheck(
          formalizerClient,
          runner,
          context,
          config.leanVersion,
          config.mathlibRevision,
          { onAttempt: onFormalizationAttempt, onProgress: onFormalizationProgress, mathlibImportIndex },
        );

    if (!formalized.ok) {

      if (formalized.attempts.length === 0) {
        db.prepare(
          `INSERT INTO statement_attempts (statementAttemptId, auditRunId, attemptIndex, status, artifactsJson)
           VALUES (?, ?, 0, 'failed', '{}')`,
        ).run(randomUUID(), auditRunId);
      }

      for (const attempt of formalized.attempts) {
        db.prepare(
          `INSERT INTO statement_attempts (statementAttemptId, auditRunId, attemptIndex, status, artifactsJson)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          auditRunId,
          attempt.attemptIndex,
          attempt.status,
          JSON.stringify({ leanSource: attempt.leanSource, diagnostics: attempt.diagnostics }),
        );
      }

      finish(formalized.outcome, 'formalizeStatement');
      return;
    }


    // Persist statement attempt + frozen header.
    for (const attempt of formalized.attempts) {
      db.prepare(
        `INSERT INTO statement_attempts (statementAttemptId, auditRunId, attemptIndex, status, artifactsJson)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        auditRunId,
        attempt.attemptIndex,
        attempt.status,
        JSON.stringify({ leanSource: attempt.leanSource, diagnostics: attempt.diagnostics }),
      );
    }

    const frozenHeaderId = randomUUID();
    db.prepare(
      `INSERT INTO frozen_headers (frozenHeaderId, auditRunId, theoremName, sourceHash, artifactsJson)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      frozenHeaderId,
      auditRunId,
      formalized.theoremName,
      formalized.sourceHash,
      JSON.stringify({
        normalizedGoalTerm: formalized.normalizedGoalTerm,
        artifactKind: formalized.artifactKind,
        leanSource: formalized.leanSource,
        termMap: formalized.termMap,
      }),
    );

    emit(
      'formalizeStatement',
      'info',
      `${artifactLabel} formalized: ${formalized.theoremName}`,
    );

    // ── §3.8 Faithfulness check ──────────────────────────────────────────
    emit('faithfulness', 'info', 'Running faithfulness checks');
    updateRunStatus(db, auditRunId, 'running', 'faithfulness');
    checkBudget(budget);

    const faithfulness = await withHeartbeat(
      () => targetIsTheorem
      ? checkFaithfulness(
          auxiliaryClient,
          formalizerClient,
          proposerClient,
          runner,
          formalized,
          context.statementText,
          context.ambientContext,
          context.resolvedDependencies,
          config.leanVersion,
          config.mathlibRevision,
        )
      : checkDefinitionFaithfulness(
          auxiliaryClient,
          formalizerClient,
          runner,
          formalized,
          context.statementText,
          context.ambientContext,
          context.resolvedDependencies,
          config.leanVersion,
          config.mathlibRevision,
        ),
      heartbeatTick(emit, 'faithfulness', 'Faithfulness checks'),
    );

    // Persist faithfulness checks.
    db.prepare(
      `INSERT INTO faithfulness_checks (faithfulnessCheckId, auditRunId, kind, verdict, createdAt, artifactsJson)
       VALUES (?, ?, 'backtranslation', ?, ?, ?)`,
    ).run(
      randomUUID(),
      auditRunId,
      faithfulness.backtranslationAgreement === 'disagree' ? 'unfaithful' : 'likelyFaithful',
      new Date().toISOString(),
      JSON.stringify({
        backtranslatedNL: faithfulness.backtranslatedNL,
        agreement: faithfulness.backtranslationAgreement,
      }),
    );

    db.prepare(
      `INSERT INTO faithfulness_checks (faithfulnessCheckId, auditRunId, kind, verdict, createdAt, artifactsJson)
       VALUES (?, ?, 'roundtrip', ?, ?, ?)`,
    ).run(
      randomUUID(),
      auditRunId,
      faithfulness.verdict,
      new Date().toISOString(),
      JSON.stringify({
        tier: faithfulness.roundtripTier,
        evidence: faithfulness.roundtripEvidence,
        s2Source: faithfulness.s2Source,
      }),
    );

    if (faithfulness.verdict === 'unfaithful') {
      emit(
        'faithfulness',
        'warning',
        `Formalization rejected as unfaithful: ${faithfulness.roundtripEvidence ?? 'no explanation recorded'}`,
        { backtranslatedNL: faithfulness.backtranslatedNL },
      );
      // What failed here is the formalization, not a proof — no proof has been
      // attempted at this point, and for a `formalizeOnly` run none ever will.
      // `proofDoesNotSupportClaim` named the wrong artifact and contradicted the
      // outcome table in docs/tester-quickstart.md.
      finish('formalizationUnfaithful', 'faithfulness');
      return;
    }

    // The final gate accepts only `faithful` and `likelyFaithful`, so any other
    // verdict has already decided the run — proving cannot rescue it. Stop here
    // rather than paying for a proof that could never be accepted.
    if (!ACCEPTABLE_FAITHFULNESS.has(faithfulness.verdict)) {
      const reason = faithfulness.roundtripEvidence ?? faithfulness.verdict;
      emit(
        'faithfulness',
        'warning',
        targetNeedsProof
          ? `Faithfulness verdict ${faithfulness.verdict} cannot pass the final gate, so no proof is attempted: ${reason}`
          : `${artifactLabel} formalization needs human review: ${reason}`,
        { verdict: faithfulness.verdict },
      );
      finish('verificationBlocked', 'faithfulness');
      return;
    }

    emit(
      'faithfulness',
      'info',
      `Faithfulness verdict: ${faithfulness.verdict} (roundtrip: `
      + `${faithfulness.roundtripTier ? `closed at tier ${faithfulness.roundtripTier}` : 'not established'})`,
      { verdict: faithfulness.verdict, roundtripTier: faithfulness.roundtripTier },
    );

    // ── §3.9 Header is now frozen (already recorded above) ───────────────
    emit('freezeHeader', 'info', `Header frozen: ${formalized.theoremName}`);

    // ── Proof skeleton: check the author's argument, not just the theorem ──
    if (targetNeedsProof && input.mode === 'proofSkeleton') {
      emit('proofSteps', 'info', "Formalizing the author's proof, step by step");
      updateRunStatus(db, auditRunId, 'running', 'proofSteps');

      const skeleton = await withHeartbeat(
        () => checkProofSkeleton(
          auxiliaryClient,
          formalizerClient,
          proposerClient,
          runner,
          formalized.leanSource,
          context,
          config.leanVersion,
          config.mathlibRevision,
          {
            onProgress: (message: string, payload?: Record<string, unknown>) =>
              emit('proofSteps', 'info', message, payload),
            // The frozen statement's imports are already known to exist and to
            // be compiled, and every step has to elaborate in that same
            // environment. Step formalization was the one path getting no
            // import hints at all.
            mathlibImportHints: extractLeanImports(formalized.leanSource),
          },
        ),
        heartbeatTick(emit, 'proofSteps', 'Proof steps'),
      );

      for (const step of skeleton.steps) {
        db.prepare(
          `INSERT INTO proof_steps (proofStepId, auditRunId, idx, sourceText, status, artifactsJson)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          auditRunId,
          step.idx,
          step.sourceText || step.claim,
          step.status,
          JSON.stringify({
            claim: step.claim,
            uses: step.uses,
            leanSource: step.leanSource,
            theoremName: step.theoremName,
            diagnostics: step.diagnostics,
            proof: step.proof,
          }),
        );

        const ok = step.status === 'checked' && step.proof.status === 'proved';
        emit(
          'proofSteps',
          ok ? 'info' : 'warning',
          ok
            ? `Step ${step.idx} proved (${step.proof.closedBy}): ${step.claim}`
            : step.status !== 'checked'
              ? `Step ${step.idx} could not be stated in Lean (${step.status}): ${step.claim} — ${step.diagnostics.join('; ').slice(0, 400)}`
              : `Step ${step.idx} stated but not proved: ${step.claim} — ${step.proof.diagnostics.join('; ').slice(0, 400)}`,
          { idx: step.idx, status: step.status, proof: step.proof.status, closedBy: step.proof.closedBy },
        );
      }

      const unstated = skeleton.steps.filter((step) => step.status !== 'checked');
      const unproved = skeleton.steps.filter((step) => step.proof.status !== 'proved');
      emit(
        'proofSteps',
        'info',
        `Proof skeleton: ${skeleton.steps.length - unstated.length}/${skeleton.steps.length} steps stated, `
        + `${skeleton.steps.length - unproved.length}/${skeleton.steps.length} proved`,
      );

      if (skeleton.steps.length === 0 || unstated.length > 0 || unproved.length > 0) {
        emit(
          'finalGate',
          'info',
          `Budget used: ${budget.inputTokens + budget.outputTokens} / ${budget.cap} tokens${formatSpend(budget)}`,
        );
        // The argument did not survive in full, so the claim is not established
        // by it — whatever the theorem's truth may be.
        finish('proofIncomplete');
        return;
      }

      // Every step of the author's argument holds. What remains is whether they
      // compose to the theorem, which the ordinary proposer stage now answers with
      // the steps in scope as lemmas.
      const stepDependencies: ResolvedDependency[] = skeleton.provedSources.map((leanSource, index) => ({
        fingerprint: sha256(leanSource),
        label: `proof-step-${index + 1}`,
        kind: 'proof',
        statementText: skeleton.steps[index]?.claim ?? '',
        leanDeclaration: leanSource,
        verified: true,
      }));
      proposerContext = {
        ...context,
        resolvedDependencies: [...context.resolvedDependencies, ...stepDependencies],
      };
      depDecls = formatDependencyDeclarations(proposerContext.resolvedDependencies);
      emit('proofSteps', 'info', 'Every step holds — attempting to compose them into the claim');
    }

    if (!targetNeedsProof) {
      emit('finalGate', 'info', `Budget used: ${budget.inputTokens + budget.outputTokens} / ${budget.cap} tokens${formatSpend(budget)}`);
      finish('formalized');
      return;
    }

    // ── §3.10-3.11 Proposer end-to-end (cache-first) ─────────────────────
    emit('proposerAttempt', 'info', 'Proposing a proof');
    updateRunStatus(db, auditRunId, 'running', 'proposerAttempt');
    checkBudget(budget);

    // Check cache before invoking the model (§7). Only a positive hit skips the
    // proposer — cached failures must NOT short-circuit the intra-run retry loop.
    const cacheInstance = new LeanCheckCache(db);
    const cacheKeyObj = buildCacheKey(proposerContext, formalized, config);
    const cacheHit = cacheInstance.lookup(cacheKeyObj);

    let proposerResult: ProposerResult;

    const cachedSource = cacheHit?.status === 'ok'
      ? await validateCachedProof(cacheHit.provenByJson, formalized, depDecls, runner) : null;
    if (cachedSource) {
      emit('proposerAttempt', 'info', 'Cached proof passed fresh kernel validation — skipping model', { cacheKey: cacheHit?.cacheKey });
      proposerResult = {
        outcome: 'verified',
        acceptedLeanSource: cachedSource,
        attempts: [],
        totalUsage: { inputTokens: 0, outputTokens: 0 },
      };
    } else {
      if (cacheHit) {
        emit('proposerAttempt', 'info', `Cache entry found (status: ${cacheHit.status}) — proceeding with fresh attempt`);
      }
      proposerResult = await withHeartbeat(
        () => runProposer(proposerClient, runner, formalized, proposerContext),
        heartbeatTick(emit, 'proposerAttempt', 'Proposing a proof'),
      );
    }

    // Persist proof attempts, and say why each one failed — a run that stops
    // here otherwise shows nothing between "Proposing a proof" and "blocked".
    for (const attempt of proposerResult.attempts) {
      if (attempt.status !== 'ok' && attempt.diagnostics.length > 0) {
        emit(
          'proposerAttempt',
          'warning',
          `Proof attempt ${attempt.attemptIndex + 1} ${attempt.status}: ${attempt.diagnostics.join('; ').slice(0, 600)}`,
          { attemptIndex: attempt.attemptIndex, status: attempt.status, failureClass: attempt.failureClass },
        );
      }
      db.prepare(
        `INSERT INTO statement_attempts (statementAttemptId, auditRunId, attemptIndex, status, artifactsJson)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        auditRunId,
        100 + attempt.attemptIndex, // Offset from formalization attempts.
        attempt.status,
        JSON.stringify({
          leanSource: attempt.leanSource,
          diagnostics: attempt.diagnostics,
          failureClass: attempt.failureClass,
        }),
      );
    }

    // ── §3.13 Final gate ──────────────────────────────────────────────────
    emit('finalGate', 'info', 'Running final gate checks');
    updateRunStatus(db, auditRunId, 'running', 'finalGate');

    // Cache entries are hints, never authorities: always recheck the exact goal.
    if (proposerResult.acceptedLeanSource) {
      const recheck = await runner.check(composeLeanFile(depDecls, proposerResult.acceptedLeanSource), { declarationName: formalized.theoremName });
      if (recheck.status !== 'ok' || recheck.certificate?.normalizedGoalTerm !== formalized.normalizedGoalTerm) {
        emit('finalGate', 'error', 'Final kernel recheck failed', { diagnostics: recheck.diagnostics });
        proposerResult = { ...proposerResult, outcome: 'verificationBlocked', acceptedLeanSource: null };
      }
    }
    const gate = runFinalGate(formalized, faithfulness, proposerResult);

    // Persist final proof artifact.
    if (proposerResult.acceptedLeanSource) {
      const cacheKey = deriveCacheKey(cacheKeyObj);
      db.prepare(
        `INSERT INTO final_proof_artifacts
           (finalProofId, auditRunId, leanSource, leanSourceHash, cacheKey,
            trustPolicyViolationsJson, finalDiagnosticsJson, acceptedByLean, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        auditRunId,
        proposerResult.acceptedLeanSource,
        sha256(proposerResult.acceptedLeanSource),
        cacheKey,
        JSON.stringify(gate.violations),
        JSON.stringify([]),
        gate.passed ? 1 : 0,
        new Date().toISOString(),
      );

      // Store in Lean check cache.
      cacheInstance.store(cacheKeyObj, {
        status: gate.passed ? 'ok' : 'failed',
        provenByJson: gate.passed ? JSON.stringify(proposerResult.acceptedLeanSource) : null,
        diagnosticsJson: JSON.stringify(gate.violations),
        elapsedMs: 0,
      });
    }

    if (gate.violations.length > 0) {
      emit('finalGate', 'warning', `Gate violations: ${gate.violations.join('; ')}`);
    }

    emit('finalGate', 'info', `Budget used: ${budget.inputTokens + budget.outputTokens} / ${budget.cap} tokens${formatSpend(budget)}`);

    finish(gate.outcome);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const outcome: VerificationOutcome = 'verificationBlocked';
    emit('complete', 'error', `Pipeline error: ${message}`, { error: message });
    finish(outcome);
  }
}

// ---------------------------------------------------------------------------
// Resume helpers
// ---------------------------------------------------------------------------

interface RehydratedPipelineRun {
  config: PipelineConfig;
  initialTokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
  input: PipelineInput;
  startedAt: string;
}



async function resumePipelineAfterInformalAcknowledgement(
  db: Database,
  auditRunId: string,
  leanProjectDir: string,
): Promise<void> {
  const emit = makeEventEmitter(db, auditRunId);

  try {
    const rehydrated = rehydratePipelineRun(db, auditRunId, leanProjectDir);
    await executePipeline(
      db,
      auditRunId,
      rehydrated.input,
      rehydrated.config,
      rehydrated.startedAt,
      {
        initialTokenUsage: rehydrated.initialTokenUsage,
        skipInformalAudit: true,
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const outcome: VerificationOutcome = 'verificationBlocked';
    const finishedAt = new Date().toISOString();
    const run = db
      .prepare('SELECT startedAt FROM audit_runs WHERE auditRunId = ?')
      .get(auditRunId) as { startedAt: string } | undefined;
    const startedAt = run?.startedAt ?? finishedAt;
    const durationMs = Date.now() - new Date(startedAt).getTime();

    emit('complete', 'error', `Pipeline resume error: ${message}`, { error: message });
    updateRunStatus(db, auditRunId, 'finished', 'complete', outcome, finishedAt, durationMs);
    // `finish()` always pairs the run update with the claim's cached status;
    // this path has to as well, or the claim stays `checking` forever while its
    // run reads `verificationBlocked`.
    updateClaimStatusCacheForOutcome(db, auditRunId, outcome);
    emitSse(auditRunId, 'complete', { auditRunId, outcome });
  }
}

function rehydratePipelineRun(
  db: Database,
  auditRunId: string,
  leanProjectDir: string,
): RehydratedPipelineRun {
  const run = db
    .prepare('SELECT * FROM audit_runs WHERE auditRunId = ?')
    .get(auditRunId) as AuditRunRow | undefined;

  if (!run) throw new Error(`Run not found: ${auditRunId}`);
  if (!run.snapshotId) throw new Error(`Run has no snapshot: ${auditRunId}`);
  if (!run.targetClaimRevisionId) throw new Error(`Run has no target claim revision: ${auditRunId}`);
  if (!run.leanVersion || !run.mathlibRevision) {
    throw new Error(`Run is missing Lean or Mathlib pin: ${auditRunId}`);
  }
  if (!run.proposerConfigId || !run.formalizerConfigId || !run.auxiliaryConfigId) {
    throw new Error(`Run is missing provider configuration: ${auditRunId}`);
  }

  const snapshot = db
    .prepare(
      `SELECT documentText, documentFingerprint, parserVersion
       FROM document_snapshots
       WHERE snapshotId = ?`,
    )
    .get(run.snapshotId) as {
      documentText: string;
      documentFingerprint: string;
      parserVersion: string;
    } | undefined;

  if (!snapshot) throw new Error(`Snapshot not found: ${run.snapshotId}`);

  const revision = db
    .prepare(
      `SELECT label, kind, startOffset, endOffset, claimFingerprint
       FROM claim_revisions
       WHERE claimRevisionId = ?`,
    )
    .get(run.targetClaimRevisionId) as {
      label: string | null;
      kind: string;
      startOffset: number;
      endOffset: number;
      claimFingerprint: string;
    } | undefined;

  if (!revision) throw new Error(`Claim revision not found: ${run.targetClaimRevisionId}`);

  const doc = parseLatexDocument(snapshot.documentText);
  const targetClaim = doc.claims.find((claim) => claim.fingerprint === revision.claimFingerprint)
    ?? doc.claims.find((claim) => (
      revision.label != null &&
      claim.label === revision.label &&
      claim.kind === revision.kind
    ))
    ?? doc.claims.find((claim) => (
      claim.startOffset === revision.startOffset &&
      claim.endOffset === revision.endOffset
    ));

  if (!targetClaim) {
    throw new Error(`Target claim not found in stored snapshot: ${run.targetClaimRevisionId}`);
  }

  const runtimeSettings = readPipelineRuntimeSettings(db, run.projectId);

  return {
    startedAt: run.startedAt,
    initialTokenUsage: readPausedInformalTokenUsage(db, auditRunId),
    input: {
      requestId: run.requestId,
      projectId: run.projectId,
      claimId: targetClaim.id,
      documentText: snapshot.documentText,
      parsedDocumentFingerprint: snapshot.documentFingerprint,
      parserVersion: snapshot.parserVersion,
      leanProjectDir,
      mode: run.mode,
    },
    config: {
      leanVersion: run.leanVersion,
      mathlibRevision: run.mathlibRevision,
      proposerConfigId: run.proposerConfigId,
      formalizerConfigId: run.formalizerConfigId,
      auxiliaryConfigId: run.auxiliaryConfigId,
      tokenBudgetCap: runtimeSettings.tokenBudgetCap,
      wallClockCapMs: runtimeSettings.wallClockCapMs,
    },
  };
}

function readPipelineRuntimeSettings(
  db: Database,
  projectId: string,
): { tokenBudgetCap: number; wallClockCapMs: number } {
  const row = db
    .prepare('SELECT settingsJson FROM projects WHERE projectId = ?')
    .get(projectId) as { settingsJson: string } | undefined;

  if (!row) {
    return {
      tokenBudgetCap: DEFAULT_TOKEN_BUDGET_CAP,
      wallClockCapMs: DEFAULT_WALL_CLOCK_CAP_MS,
    };
  }

  try {
    const settings = JSON.parse(row.settingsJson) as Record<string, unknown>;
    return {
      tokenBudgetCap: typeof settings['tokenBudgetCap'] === 'number'
        ? settings['tokenBudgetCap']
        : DEFAULT_TOKEN_BUDGET_CAP,
      wallClockCapMs: typeof settings['wallClockCapMs'] === 'number'
        ? settings['wallClockCapMs']
        : DEFAULT_WALL_CLOCK_CAP_MS,
    };
  } catch {
    return {
      tokenBudgetCap: DEFAULT_TOKEN_BUDGET_CAP,
      wallClockCapMs: DEFAULT_WALL_CLOCK_CAP_MS,
    };
  }
}

function readPausedInformalTokenUsage(
  db: Database,
  auditRunId: string,
): { inputTokens: number; outputTokens: number } {
  const rows = db
    .prepare(
      `SELECT payloadJson
       FROM run_events
       WHERE auditRunId = ? AND phase = 'informalAudit'
       ORDER BY timestamp DESC`,
    )
    .all(auditRunId) as Array<{ payloadJson: string | null }>;

  for (const row of rows) {
    if (!row.payloadJson) continue;
    try {
      const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
      const tokenUsage = payload['tokenUsage'] as Record<string, unknown> | undefined;
      const inputTokens = tokenUsage?.['inputTokens'];
      const outputTokens = tokenUsage?.['outputTokens'];
      if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
        return { inputTokens, outputTokens };
      }
    } catch {
      // Ignore malformed historic payloads; resume can still enforce the cap for
      // stages after the acknowledgement.
    }
  }

  return { inputTokens: 0, outputTokens: 0 };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shouldPauseForInformalAudit(verdict: string, confidence: string): boolean {
  return (
    confidence === 'high' &&
    verdict !== 'noObviousIssue' &&
    verdict !== 'uncertain'
  );
}

function hydrateDependencyDeclarations(
  db: Database,
  projectId: string,
  context: NormalizedClaimContext,
): NormalizedClaimContext {
  return {
    ...context,
    resolvedDependencies: context.resolvedDependencies.map((dependency) => {
      const leanDeclaration = latestAcceptedLeanDeclaration(db, projectId, dependency.label, dependency.fingerprint);
      return leanDeclaration
        ? { ...dependency, leanDeclaration, verified: true }
        : dependency;
    }),
  };
}

function latestAcceptedLeanDeclaration(
  db: Database,
  projectId: string,
  label: string,
  fingerprint: string,
): string | null {
  const row = db
    .prepare(
      `SELECT fh.artifactsJson, fpa.leanSource AS provenSource
       FROM frozen_headers fh
       JOIN audit_runs ar ON ar.auditRunId = fh.auditRunId
       LEFT JOIN final_proof_artifacts fpa ON fpa.auditRunId = ar.auditRunId AND fpa.acceptedByLean = 1
       JOIN claim_revisions cr ON cr.claimRevisionId = ar.targetClaimRevisionId
       JOIN claim_identities ci ON ci.claimIdentityId = cr.claimIdentityId
       WHERE ci.projectId = ?
         AND cr.label = ?
         AND cr.claimFingerprint = ?
         AND ci.statusCache IN ('verified', 'formalized')
         AND ar.status = 'finished'
         AND ar.outcome IN ('verified', 'formalized')
       ORDER BY ar.finishedAt DESC
       LIMIT 1`,
    )
    .get(projectId, label, fingerprint) as { artifactsJson: string; provenSource: string | null } | undefined;

  if (!row) return null;

  if (row.provenSource) return row.provenSource;
  try {
    const artifacts = JSON.parse(row.artifactsJson) as { artifactKind?: unknown; leanSource?: unknown };
    // A formalized theorem still contains sorry. Only accepted definitions can
    // be reused without a kernel-accepted proof artifact.
    return artifacts.artifactKind === 'definition' && typeof artifacts.leanSource === 'string' && artifacts.leanSource.trim()
      ? artifacts.leanSource
      : null;
  } catch {
    return null;
  }
}

function buildCacheKey(
  context: ReturnType<typeof selectReachableContext>,
  formalized: { theoremName: string; leanSource: string; normalizedGoalTerm: string },
  config: PipelineConfig,
): CacheKey {
  const envFingerprint = buildEnvironmentFingerprint(
    context,
    config.leanVersion,
    config.mathlibRevision,
  );
  return {
    normalizedGoalTerm: formalized.normalizedGoalTerm,
    environmentFingerprint: JSON.stringify({
      policy: 'astra-kernel-v1',
      context: envFingerprint,
      preamble: leanPreamble(formalized.leanSource),
    }),
    leanVersion: config.leanVersion,
    mathlibRevision: config.mathlibRevision,
  };
}

/**
 * Everything before the declaration — the imports and `open` commands the goal
 * is elaborated under, which are part of what the cached result is true of.
 *
 * A bare `indexOf` returning -1 here used to make `slice(0, -1)` the whole
 * source minus its last character, so a source without the needle produced a
 * plausible-looking key over the wrong text instead of failing.
 */
function leanPreamble(leanSource: string): string {
  const declaration = /^[ \t]*(?:theorem|lemma|def|abbrev|structure|class)\b/m.exec(leanSource);
  return declaration ? leanSource.slice(0, declaration.index) : leanSource;
}

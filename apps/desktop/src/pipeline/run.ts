import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import {
  isVerifiableClaimKind,
  parseLatexDocument,
  type ParsedDocument,
} from '@lale/document-parser';
import { LeanCheckCache, deriveCacheKey, type CacheKey } from '@lale/cache';
import { LeanRunner } from '@lale/lean-runner';
import { ModelClient, informalAudit as runInformalAudit, type TokenUsage } from '@lale/translator';
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
  formalizeAndCheck,
  formalizeDefinitionAndCheck,
  type FormalizeProgressEvent,
  type StatementAttempt,
} from './formalize.js';
import { checkDefinitionFaithfulness, checkFaithfulness } from './faithfulness.js';
import { runProver, type ProverResult } from './prover.js';
import { runFinalGate } from './gate.js';
import { getMathlibImportIndex } from './mathlib-index.js';
import { apiKeyEnvNames, resolveApiKeyFromEnv } from '../model-config.js';

// ---------------------------------------------------------------------------
// Key storage (env-var or keytar)
// ---------------------------------------------------------------------------

async function resolveApiKey(config: ProviderConfigRow): Promise<string> {
  // Env-var shortcut (for dev/testing).
  const envKey = resolveApiKeyFromEnv(config, process.env);
  if (envKey) return envKey.value;

  if (!config.apiKeyRef) {
    throw new Error(
      `No API key configured for ${config.role} model ${config.modelId}. ` +
        `Set one of: ${apiKeyEnvNames(config).join(', ')}; or configure a provider key.`,
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

interface TokenBudget {
  capTokens: number;
  usedInputTokens: number;
  usedOutputTokens: number;
}

function checkBudget(budget: TokenBudget): void {
  const used = budget.usedInputTokens + budget.usedOutputTokens;
  if (used >= budget.capTokens) {
    throw new BudgetExceededError(
      `Per-run token budget exceeded (used ${used} / cap ${budget.capTokens})`,
    );
  }
}

class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
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

async function buildModelClient(
  db: Database,
  configId: string,
): Promise<ModelClient> {
  const row = db
    .prepare('SELECT * FROM model_provider_configs WHERE providerConfigId = ?')
    .get(configId) as ProviderConfigRow | undefined;

  if (!row) throw new Error(`Provider config not found: ${configId}`);

  const apiKey = await resolveApiKey(row);

  const clientConfig: import('@lale/translator').ModelClientConfig = {
    apiKey,
    modelId: row.modelId,
    ...(row.baseUrl != null ? { baseURL: row.baseUrl } : {}),
    ...(row.maxTokens != null ? { maxTokens: row.maxTokens } : {}),
    ...(row.temperature != null ? { temperature: row.temperature } : {}),
    timeoutMs: modelTimeoutMs(),
    maxRetries: 0,
  };
  return new ModelClient(clientConfig);
}

function modelTimeoutMs(): number {
  const raw = process.env['LALE_MODEL_TIMEOUT_MS'];
  if (!raw) return 90_000;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90_000;
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

function propagateStaleness(db: Database, projectId: string, changedIdentityId: string): void {
  const visited = new Set<string>();
  const queue = [changedIdentityId];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    // Mark verified claims as stale; pending/failed stay as-is (they're already not verified).
    db.prepare(
      `UPDATE claim_identities SET statusCache = 'stale'
       WHERE claimIdentityId = ? AND statusCache IN ('verified','verifiedByOverride')`,
    ).run(id);

    // Downstream: claims whose revisions reference a revision of this identity.
    const downstreams = db
      .prepare(
        `SELECT DISTINCT ci.claimIdentityId
         FROM dependency_edges de
         JOIN claim_revisions cr_to  ON de.toClaimRevisionId   = cr_to.claimRevisionId
         JOIN claim_revisions cr_from ON de.fromClaimRevisionId = cr_from.claimRevisionId
         JOIN claim_identities ci    ON cr_from.claimIdentityId = ci.claimIdentityId
         WHERE cr_to.claimIdentityId = ? AND ci.projectId = ?`,
      )
      .all(id, projectId) as { claimIdentityId: string }[];

    for (const d of downstreams) {
      if (!visited.has(d.claimIdentityId)) queue.push(d.claimIdentityId);
    }
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
    propagateStaleness(db, projectId, identity.claimIdentityId);
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
}

export interface PipelineConfig {
  leanVersion: string;
  mathlibRevision: string;
  proverConfigId: string;
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
       (auditRunId, projectId, requestId, status, phase, startedAt,
        leanVersion, mathlibRevision, proverConfigId, formalizerConfigId, auxiliaryConfigId)
     VALUES (?, ?, ?, 'queued', 'parseSnapshot', ?, ?, ?, ?, ?, ?)`,
  ).run(
    auditRunId,
    input.projectId,
    input.requestId,
    startedAt,
    config.leanVersion,
    config.mathlibRevision,
    config.proverConfigId,
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
  const budget: TokenBudget = {
    capTokens: config.tokenBudgetCap,
    usedInputTokens: options.initialTokenUsage?.inputTokens ?? 0,
    usedOutputTokens: options.initialTokenUsage?.outputTokens ?? 0,
  };

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
    const targetNeedsProof = isVerifiableClaimKind(targetClaim.kind);

    const snapshotId = upsertSnapshot(
      db,
      input.projectId,
      doc,
      input.documentText,
      input.parserVersion,
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
    }

    const missingFormalizedDependencies = context.resolvedDependencies
      .filter((dependency) => isFormalizationDependency(dependency) && !dependency.leanDeclaration)
      .map((dependency) => dependency.label);
    if (missingFormalizedDependencies.length > 0) {
      emit(
        'selectContext',
        'warning',
        `Referenced definitions need formalization first: ${missingFormalizedDependencies.join(', ')}`,
      );
      finish('dependencyMissing', 'selectContext');
      return;
    }

    // Build all model clients once, used across all pipeline stages.
    checkBudget(budget);
    const formalizerClient = await buildModelClient(db, config.formalizerConfigId);
    const auxiliaryClient = await buildModelClient(db, config.auxiliaryConfigId);
    const proverClient = await buildModelClient(db, config.proverConfigId);

    const runner = new LeanRunner({
      projectDir: input.leanProjectDir,
      wallClockCapMs: config.wallClockCapMs,
    });

    const depDecls = formatDependencyDeclarations(context.resolvedDependencies);

    // ── §3.5 Informal advisory audit ─────────────────────────────────────
    if (targetNeedsProof && !options.skipInformalAudit) {
      emit('informalAudit', 'info', 'Running informal advisory audit');
      updateRunStatus(db, auditRunId, 'running', 'informalAudit');

      let informalVerdict = 'uncertain';
      let informalConfidence = 'low';
      let informalFindings: string[] = [];

      try {
        const informalResult = await runInformalAudit(
          auxiliaryClient,
          context.statementText,
          context.proofText ?? '',
          depDecls,
        );
        informalVerdict = informalResult.verdict;
        informalConfidence = informalResult.confidence;
        informalFindings = informalResult.findings;
        budget.usedInputTokens += informalResult.usage.inputTokens;
        budget.usedOutputTokens += informalResult.usage.outputTokens;
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
            inputTokens: budget.usedInputTokens,
            outputTokens: budget.usedOutputTokens,
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
    emit('formalizeStatement', 'info', targetNeedsProof ? 'Formalizing statement' : 'Formalizing definition');
    updateRunStatus(db, auditRunId, 'running', 'formalizeStatement');
    checkBudget(budget);

    const onFormalizationAttempt = (attempt: StatementAttempt): void => {
      const diagnostics = attempt.diagnostics.slice(0, 5);
      emit(
        'formalizeStatement',
        attempt.status === 'ok' ? 'info' : 'warning',
        `${targetNeedsProof ? 'Statement' : 'Definition'} formalization attempt ${attempt.attemptIndex + 1}: ${attempt.status}`,
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

    const formalized = targetNeedsProof
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
      budget.usedInputTokens += formalized.totalUsage.inputTokens;
      budget.usedOutputTokens += formalized.totalUsage.outputTokens;

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

    budget.usedInputTokens += formalized.totalUsage.inputTokens;
    budget.usedOutputTokens += formalized.totalUsage.outputTokens;

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
        artifactKind: formalized.artifactKind,
        leanSource: formalized.leanSource,
        termMap: formalized.termMap,
      }),
    );

    emit(
      'formalizeStatement',
      'info',
      `${targetNeedsProof ? 'Statement' : 'Definition'} formalized: ${formalized.theoremName}`,
    );

    // ── §3.8 Faithfulness check ──────────────────────────────────────────
    emit('faithfulness', 'info', 'Running faithfulness checks');
    updateRunStatus(db, auditRunId, 'running', 'faithfulness');
    checkBudget(budget);

    const faithfulness = targetNeedsProof
      ? await checkFaithfulness(
          auxiliaryClient,
          formalizerClient,
          proverClient,
          runner,
          formalized,
          context.statementText,
          context.resolvedDependencies,
          config.leanVersion,
          config.mathlibRevision,
        )
      : await checkDefinitionFaithfulness(
          auxiliaryClient,
          formalizerClient,
          runner,
          formalized,
          context.statementText,
          context.resolvedDependencies,
          config.leanVersion,
          config.mathlibRevision,
        );

    budget.usedInputTokens += faithfulness.totalUsage.inputTokens;
    budget.usedOutputTokens += faithfulness.totalUsage.outputTokens;

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
      finish(targetNeedsProof ? 'proofDoesNotSupportClaim' : 'formalizationUnfaithful', 'faithfulness');
      return;
    }

    if (!targetNeedsProof && faithfulness.verdict !== 'faithful') {
      emit(
        'faithfulness',
        'warning',
        `Definition formalization needs human review: ${faithfulness.roundtripEvidence ?? faithfulness.verdict}`,
      );
      finish('verificationBlocked', 'faithfulness');
      return;
    }

    emit('faithfulness', 'info', `Faithfulness verdict: ${faithfulness.verdict}`);

    // ── §3.9 Header is now frozen (already recorded above) ───────────────
    emit('freezeHeader', 'info', `Header frozen: ${formalized.theoremName}`);

    if (!targetNeedsProof) {
      emit('finalGate', 'info', `Budget used: ${budget.usedInputTokens + budget.usedOutputTokens} / ${budget.capTokens} tokens`);
      finish('formalized');
      return;
    }

    // ── §3.10-3.11 Prover end-to-end (cache-first) ───────────────────────
    emit('proverAttempt', 'info', 'Running prover');
    updateRunStatus(db, auditRunId, 'running', 'proverAttempt');
    checkBudget(budget);

    // Check cache before invoking the model (§7). Only a positive hit skips the
    // prover — cached failures must NOT short-circuit the intra-run retry loop.
    const cacheInstance = new LeanCheckCache(db);
    const cacheKeyObj = buildCacheKey(context, formalized, config);
    const cacheHit = cacheInstance.lookup(cacheKeyObj);

    let proverResult: ProverResult;

    if (cacheHit?.status === 'ok' && cacheHit.provenByJson) {
      const cachedSource = JSON.parse(cacheHit.provenByJson) as string;
      emit('proverAttempt', 'info', 'Cache hit — skipping prover', { cacheKey: cacheHit.cacheKey });
      proverResult = {
        outcome: 'verified',
        acceptedLeanSource: cachedSource,
        attempts: [],
        totalUsage: { inputTokens: 0, outputTokens: 0 },
      };
    } else {
      if (cacheHit) {
        emit('proverAttempt', 'info', `Cache entry found (status: ${cacheHit.status}) — proceeding with fresh attempt`);
      }
      proverResult = await runProver(proverClient, runner, formalized, context);
      budget.usedInputTokens += proverResult.totalUsage.inputTokens;
      budget.usedOutputTokens += proverResult.totalUsage.outputTokens;
    }

    // Persist proof attempts.
    for (const attempt of proverResult.attempts) {
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

    const gate = runFinalGate(formalized, faithfulness, proverResult);

    // Persist final proof artifact.
    if (proverResult.acceptedLeanSource) {
      const cacheKey = deriveCacheKey(cacheKeyObj);
      db.prepare(
        `INSERT INTO final_proof_artifacts
           (finalProofId, auditRunId, leanSource, leanSourceHash, cacheKey,
            trustPolicyViolationsJson, finalDiagnosticsJson, acceptedByLean, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        auditRunId,
        proverResult.acceptedLeanSource,
        sha256(proverResult.acceptedLeanSource),
        cacheKey,
        JSON.stringify(gate.violations),
        JSON.stringify([]),
        gate.passed ? 1 : 0,
        new Date().toISOString(),
      );

      // Store in Lean check cache.
      cacheInstance.store(cacheKeyObj, {
        status: gate.passed ? 'ok' : 'failed',
        provenByJson: gate.passed ? JSON.stringify(proverResult.acceptedLeanSource) : null,
        diagnosticsJson: JSON.stringify(gate.violations),
        elapsedMs: 0,
      });
    }

    if (gate.violations.length > 0) {
      emit('finalGate', 'warning', `Gate violations: ${gate.violations.join('; ')}`);
    }

    emit('finalGate', 'info', `Budget used: ${budget.usedInputTokens + budget.usedOutputTokens} / ${budget.capTokens} tokens`);

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

const DEFAULT_TOKEN_BUDGET_CAP = 100_000;
const DEFAULT_WALL_CLOCK_CAP_MS = 60_000;

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
  if (!run.proverConfigId || !run.formalizerConfigId || !run.auxiliaryConfigId) {
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
    },
    config: {
      leanVersion: run.leanVersion,
      mathlibRevision: run.mathlibRevision,
      proverConfigId: run.proverConfigId,
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
      if (!isFormalizationDependency(dependency)) return dependency;
      const leanDeclaration = latestAcceptedLeanDeclaration(db, projectId, dependency.label);
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
): string | null {
  const row = db
    .prepare(
      `SELECT fh.artifactsJson
       FROM frozen_headers fh
       JOIN audit_runs ar ON ar.auditRunId = fh.auditRunId
       JOIN claim_revisions cr ON cr.claimRevisionId = ar.targetClaimRevisionId
       JOIN claim_identities ci ON ci.claimIdentityId = cr.claimIdentityId
       WHERE ci.projectId = ?
         AND cr.label = ?
         AND ar.status = 'finished'
         AND ar.outcome IN ('verified', 'formalized')
       ORDER BY ar.finishedAt DESC
       LIMIT 1`,
    )
    .get(projectId, label) as { artifactsJson: string } | undefined;

  if (!row) return null;

  try {
    const artifacts = JSON.parse(row.artifactsJson) as { leanSource?: unknown };
    return typeof artifacts.leanSource === 'string' && artifacts.leanSource.trim()
      ? artifacts.leanSource
      : null;
  } catch {
    return null;
  }
}

function isFormalizationDependency(dependency: ResolvedDependency): boolean {
  return (
    dependency.kind === 'definition' ||
    dependency.kind === 'axiom' ||
    dependency.kind === 'postulate'
  );
}

function buildCacheKey(
  context: ReturnType<typeof selectReachableContext>,
  formalized: { theoremName: string; leanSource: string },
  config: PipelineConfig,
): CacheKey {
  const envFingerprint = buildEnvironmentFingerprint(
    context,
    config.leanVersion,
    config.mathlibRevision,
  );
  return {
    normalizedGoalTerm: formalized.leanSource,
    environmentFingerprint: envFingerprint,
    leanVersion: config.leanVersion,
    mathlibRevision: config.mathlibRevision,
  };
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { ModelRole, VerificationMode } from '@lale/protocol';

// ---------------------------------------------------------------------------
// DB path
// ---------------------------------------------------------------------------

export function defaultDbPath(): string {
  const dir = process.env['LALE_DATA_DIR'] ?? join(homedir(), '.lale');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'lale.db');
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- §10.1
CREATE TABLE IF NOT EXISTS projects (
  projectId         TEXT PRIMARY KEY,
  sourceKind        TEXT NOT NULL,
  overleafProjectId TEXT,
  overleafUrl       TEXT,
  name              TEXT NOT NULL,
  createdAt         TEXT NOT NULL,
  lastOpenedAt      TEXT NOT NULL,
  settingsJson      TEXT NOT NULL DEFAULT '{}'
);

-- §10.2  (three rows per project: proposer, formalizer, auxiliary)
CREATE TABLE IF NOT EXISTS model_provider_configs (
  providerConfigId TEXT PRIMARY KEY,
  projectId        TEXT REFERENCES projects(projectId),
  role             TEXT NOT NULL CHECK (role IN ('proposer','formalizer','auxiliary')),
  providerKind     TEXT NOT NULL CHECK (providerKind IN ('openrouter','openaiCompatible','local','manual')),
  baseUrl          TEXT,
  modelId          TEXT NOT NULL,
  reasoningEffort  TEXT,
  temperature      REAL,
  maxTokens        INTEGER,
  apiKeyRef        TEXT,
  createdAt        TEXT NOT NULL,
  updatedAt        TEXT NOT NULL
);

-- §10.3
CREATE TABLE IF NOT EXISTS document_snapshots (
  snapshotId          TEXT PRIMARY KEY,
  projectId           TEXT REFERENCES projects(projectId),
  documentFingerprint TEXT NOT NULL,
  parserVersion       TEXT NOT NULL,
  capturedAt          TEXT NOT NULL,
  documentText        TEXT NOT NULL,
  parsedDocumentJson  TEXT NOT NULL,
  issuesJson          TEXT NOT NULL DEFAULT '[]'
);

-- §10.4
CREATE TABLE IF NOT EXISTS claim_identities (
  claimIdentityId TEXT PRIMARY KEY,
  projectId       TEXT NOT NULL REFERENCES projects(projectId),
  currentLabel    TEXT,
  currentKind     TEXT NOT NULL,
  firstSeenAt     TEXT NOT NULL,
  lastSeenAt      TEXT NOT NULL,
  statusCache     TEXT NOT NULL DEFAULT 'pending'
);

-- §10.5
CREATE TABLE IF NOT EXISTS claim_revisions (
  claimRevisionId  TEXT PRIMARY KEY,
  claimIdentityId  TEXT NOT NULL REFERENCES claim_identities(claimIdentityId),
  snapshotId       TEXT NOT NULL REFERENCES document_snapshots(snapshotId),
  label            TEXT,
  kind             TEXT NOT NULL,
  title            TEXT,
  statement        TEXT NOT NULL,
  body             TEXT NOT NULL,
  proofText        TEXT,
  startLine        INTEGER NOT NULL,
  endLine          INTEGER NOT NULL,
  startOffset      INTEGER NOT NULL,
  endOffset        INTEGER NOT NULL,
  claimFingerprint TEXT NOT NULL,
  proofFingerprint TEXT,
  dependenciesJson TEXT NOT NULL DEFAULT '[]'
);

-- §10.6 dependency_edges is deliberately absent. Staleness propagation reads
-- the parser's resolved edges out of document_snapshots.parsedDocumentJson,
-- which needs no rows of its own; see propagateStaleness. Databases from
-- earlier builds keep an empty copy of the table, which nothing reads and
-- which is left in place rather than dropped.

-- §10.7 — three nullable config ID columns (updated from single modelProviderConfigId)
CREATE TABLE IF NOT EXISTS audit_runs (
  auditRunId            TEXT PRIMARY KEY,
  projectId             TEXT NOT NULL REFERENCES projects(projectId),
  snapshotId            TEXT REFERENCES document_snapshots(snapshotId),
  targetClaimRevisionId TEXT REFERENCES claim_revisions(claimRevisionId),
  requestId             TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('queued','running','paused','cancelled','finished')),
  mode                  TEXT NOT NULL DEFAULT 'full' CHECK (mode IN ('full','formalizeOnly','proofSkeleton')),
  phase                 TEXT,
  startedAt             TEXT NOT NULL,
  finishedAt            TEXT,
  outcome               TEXT,
  durationMs            INTEGER,
  leanVersion           TEXT,
  mathlibRevision       TEXT,
  proposerConfigId      TEXT REFERENCES model_provider_configs(providerConfigId),
  formalizerConfigId    TEXT REFERENCES model_provider_configs(providerConfigId),
  auxiliaryConfigId     TEXT REFERENCES model_provider_configs(providerConfigId)
);

-- §10.8
CREATE TABLE IF NOT EXISTS informal_audits (
  informalAuditId TEXT PRIMARY KEY,
  auditRunId      TEXT NOT NULL REFERENCES audit_runs(auditRunId),
  verdict         TEXT NOT NULL,
  confidence      TEXT NOT NULL,
  findingsJson    TEXT NOT NULL DEFAULT '[]',
  policy          TEXT NOT NULL CHECK (policy IN ('warnAndContinue','pauseOnHighConfidenceIssue')),
  paused          INTEGER NOT NULL DEFAULT 0,
  overriddenAt    TEXT,
  overrideReason  TEXT
);

-- §10.9
CREATE TABLE IF NOT EXISTS statement_attempts (
  statementAttemptId TEXT PRIMARY KEY,
  auditRunId         TEXT NOT NULL REFERENCES audit_runs(auditRunId),
  attemptIndex       INTEGER NOT NULL,
  status             TEXT NOT NULL,
  artifactsJson      TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS frozen_headers (
  frozenHeaderId TEXT PRIMARY KEY,
  auditRunId     TEXT NOT NULL REFERENCES audit_runs(auditRunId),
  theoremName    TEXT NOT NULL,
  sourceHash     TEXT NOT NULL,
  artifactsJson  TEXT NOT NULL DEFAULT '{}'
);

-- §10.10
CREATE TABLE IF NOT EXISTS faithfulness_checks (
  faithfulnessCheckId TEXT PRIMARY KEY,
  auditRunId          TEXT NOT NULL REFERENCES audit_runs(auditRunId),
  kind                TEXT NOT NULL CHECK (kind IN ('backtranslation','roundtrip')),
  verdict             TEXT NOT NULL,
  createdAt           TEXT NOT NULL,
  artifactsJson       TEXT NOT NULL DEFAULT '{}'
);

-- §10.11 (post-v0, table exists for schema completeness)
CREATE TABLE IF NOT EXISTS proof_steps (
  proofStepId  TEXT PRIMARY KEY,
  auditRunId   TEXT NOT NULL REFERENCES audit_runs(auditRunId),
  idx          INTEGER NOT NULL,
  sourceText   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending','checked','failed','blocked')),
  artifactsJson TEXT NOT NULL DEFAULT '{}'
);

-- §10.12 (post-v0)
CREATE TABLE IF NOT EXISTS retrieval_queries (
  retrievalQueryId TEXT PRIMARY KEY,
  auditRunId       TEXT NOT NULL REFERENCES audit_runs(auditRunId),
  proofStepId      TEXT REFERENCES proof_steps(proofStepId),
  queryKind        TEXT NOT NULL,
  queryText        TEXT NOT NULL,
  source           TEXT NOT NULL,
  createdAt        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retrieval_hits (
  retrievalHitId   TEXT PRIMARY KEY,
  retrievalQueryId TEXT NOT NULL REFERENCES retrieval_queries(retrievalQueryId),
  name             TEXT NOT NULL,
  signature        TEXT NOT NULL,
  sourceKind       TEXT NOT NULL CHECK (sourceKind IN ('reachableDependency','mathlibLocal','externalHint')),
  rank             INTEGER NOT NULL,
  accepted         INTEGER NOT NULL DEFAULT 0
);

-- §10.13
CREATE TABLE IF NOT EXISTS lean_check_cache (
  cacheKey                  TEXT PRIMARY KEY,
  normalizedGoalHash        TEXT NOT NULL,
  environmentFingerprintHash TEXT NOT NULL,
  leanVersion               TEXT NOT NULL,
  mathlibRevision           TEXT NOT NULL,
  status                    TEXT NOT NULL CHECK (status IN ('ok','failed','timeout')),
  provenByJson              TEXT,
  diagnosticsJson           TEXT NOT NULL DEFAULT '[]',
  elapsedMs                 INTEGER NOT NULL,
  createdAt                 TEXT NOT NULL,
  lastUsedAt                TEXT NOT NULL,
  ttlExpiresAt              TEXT
);

-- §10.14
CREATE TABLE IF NOT EXISTS final_proof_artifacts (
  finalProofId           TEXT PRIMARY KEY,
  auditRunId             TEXT NOT NULL REFERENCES audit_runs(auditRunId),
  leanSource             TEXT NOT NULL,
  leanSourceHash         TEXT NOT NULL,
  cacheKey               TEXT,
  trustPolicyViolationsJson TEXT NOT NULL DEFAULT '[]',
  finalDiagnosticsJson   TEXT NOT NULL DEFAULT '[]',
  acceptedByLean         INTEGER NOT NULL DEFAULT 0,
  createdAt              TEXT NOT NULL
);

-- §10.15 content-change overrides
CREATE TABLE IF NOT EXISTS content_change_overrides (
  overrideId              TEXT PRIMARY KEY,
  projectId               TEXT NOT NULL REFERENCES projects(projectId),
  claimIdentityId         TEXT NOT NULL REFERENCES claim_identities(claimIdentityId),
  previousClaimRevisionId TEXT REFERENCES claim_revisions(claimRevisionId),
  currentClaimRevisionId  TEXT NOT NULL REFERENCES claim_revisions(claimRevisionId),
  previousAuditRunId      TEXT REFERENCES audit_runs(auditRunId),
  class                   TEXT NOT NULL CHECK (class IN ('direct','transitive')),
  reason                  TEXT NOT NULL,
  createdAt               TEXT NOT NULL
);

-- §10.16
CREATE TABLE IF NOT EXISTS run_events (
  eventId     TEXT PRIMARY KEY,
  auditRunId  TEXT NOT NULL REFERENCES audit_runs(auditRunId),
  timestamp   TEXT NOT NULL,
  phase       TEXT NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('info','warning','error')),
  message     TEXT NOT NULL,
  payloadJson TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(auditRunId, timestamp);

-- Installer token (single-row table)
CREATE TABLE IF NOT EXISTS install_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Open / migrate
// ---------------------------------------------------------------------------

export function openDb(dbPath?: string): Database.Database {
  const path = dbPath ?? defaultDbPath();
  const db = new Database(path);
  try {
    db.exec(SCHEMA);
    // Order matters. The paused-status rebuild copies audit_runs column by
    // column, so every column it must preserve has to exist first: the legacy
    // rename supplies proposerConfigId, and the mode migration supplies mode.
    // Rebuilding before either one silently drops that column's data.
    migrateProverToProposer(db);
    migrateAuditRunMode(db);
    migrateAuditRunPausedStatus(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrateAuditRunMode(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(audit_runs)').all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'mode')) return;
  db.exec(`ALTER TABLE audit_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'full'
    CHECK (mode IN ('full','formalizeOnly','proofSkeleton'))`);
}

/**
 * Renames the `prover` role to `proposer`. The model does not prove anything —
 * it proposes a candidate proof and Lean's kernel decides — and the old name put
 * that authority in the wrong place. Installs predating the rename carry rows, a
 * column and stored phase values under the old spelling.
 */
// The pre-rename spellings, written once and only here. A blanket rename across
// the tree would otherwise rewrite this migration's "from" side into the new
// spelling and silently turn it into a no-op. (That happened.)
const LEGACY_ROLE = 'prover';
const LEGACY_PHASE = 'proverAttempt';
const LEGACY_CONFIG_COLUMN = 'proverConfigId';

function migrateProverToProposer(db: Database.Database): void {
  const configSchema = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_provider_configs'")
    .get() as { sql: string } | undefined;
  const needsRoleRebuild = configSchema?.sql.includes(`'${LEGACY_ROLE}'`) ?? false;
  const columns = db.prepare('PRAGMA table_info(audit_runs)').all() as Array<{ name: string }>;
  const needsColumnRename = columns.some((column) => column.name === LEGACY_CONFIG_COLUMN);

  if (!needsRoleRebuild && !needsColumnRename) return;

  const foreignKeys = (db.pragma('foreign_keys', { simple: true }) as number) === 1;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      if (needsColumnRename) {
        db.exec(`ALTER TABLE audit_runs RENAME COLUMN ${LEGACY_CONFIG_COLUMN} TO proposerConfigId;`);
      }
      if (needsRoleRebuild) {
        db.exec(`
          DROP TABLE IF EXISTS model_provider_configs_new;
          CREATE TABLE model_provider_configs_new (
            providerConfigId TEXT PRIMARY KEY,
            projectId        TEXT REFERENCES projects(projectId),
            role             TEXT NOT NULL CHECK (role IN ('proposer','formalizer','auxiliary')),
            providerKind     TEXT NOT NULL CHECK (providerKind IN ('openrouter','openaiCompatible','local','manual')),
            baseUrl          TEXT,
            modelId          TEXT NOT NULL,
            reasoningEffort  TEXT,
            temperature      REAL,
            maxTokens        INTEGER,
            apiKeyRef        TEXT,
            createdAt        TEXT NOT NULL,
            updatedAt        TEXT NOT NULL
          );
          INSERT INTO model_provider_configs_new
            (providerConfigId, projectId, role, providerKind, baseUrl, modelId,
             reasoningEffort, temperature, maxTokens, apiKeyRef, createdAt, updatedAt)
          SELECT providerConfigId, projectId,
                 CASE role WHEN '${LEGACY_ROLE}' THEN 'proposer' ELSE role END,
                 providerKind, baseUrl, modelId,
                 reasoningEffort, temperature, maxTokens, apiKeyRef, createdAt, updatedAt
          FROM model_provider_configs;
          DROP TABLE model_provider_configs;
          ALTER TABLE model_provider_configs_new RENAME TO model_provider_configs;
        `);
      }
      // Stored phase values are read back by the extension's phase labels.
      for (const table of ['audit_runs', 'run_events']) {
        db.prepare(`UPDATE ${table} SET phase = ? WHERE phase = ?`).run('proposerAttempt', LEGACY_PHASE);
      }
    })();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

function migrateAuditRunPausedStatus(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'audit_runs'")
    .get() as { sql: string } | undefined;

  if (!row?.sql || row.sql.includes("'paused'")) return;

  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');

  try {
    db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS audit_runs_new;
        CREATE TABLE audit_runs_new (
          auditRunId            TEXT PRIMARY KEY,
          projectId             TEXT NOT NULL REFERENCES projects(projectId),
          snapshotId            TEXT REFERENCES document_snapshots(snapshotId),
          targetClaimRevisionId TEXT REFERENCES claim_revisions(claimRevisionId),
          requestId             TEXT NOT NULL,
          status                TEXT NOT NULL CHECK (status IN ('queued','running','paused','cancelled','finished')),
          mode                  TEXT NOT NULL DEFAULT 'full' CHECK (mode IN ('full','formalizeOnly','proofSkeleton')),
          phase                 TEXT,
          startedAt             TEXT NOT NULL,
          finishedAt            TEXT,
          outcome               TEXT,
          durationMs            INTEGER,
          leanVersion           TEXT,
          mathlibRevision       TEXT,
          proposerConfigId      TEXT REFERENCES model_provider_configs(providerConfigId),
          formalizerConfigId    TEXT REFERENCES model_provider_configs(providerConfigId),
          auxiliaryConfigId     TEXT REFERENCES model_provider_configs(providerConfigId)
        );
        INSERT INTO audit_runs_new
          (auditRunId, projectId, snapshotId, targetClaimRevisionId, requestId, status, mode, phase,
           startedAt, finishedAt, outcome, durationMs, leanVersion, mathlibRevision,
           proposerConfigId, formalizerConfigId, auxiliaryConfigId)
        SELECT
          auditRunId, projectId, snapshotId, targetClaimRevisionId, requestId, status, mode, phase,
          startedAt, finishedAt, outcome, durationMs, leanVersion, mathlibRevision,
          proposerConfigId, formalizerConfigId, auxiliaryConfigId
        FROM audit_runs;
        DROP TABLE audit_runs;
        ALTER TABLE audit_runs_new RENAME TO audit_runs;
      `);
    })();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

// ---------------------------------------------------------------------------
// Row types for the tables we query directly from pipeline code
// ---------------------------------------------------------------------------

export interface ProjectRow {
  projectId: string;
  sourceKind: string;
  overleafProjectId: string | null;
  overleafUrl: string | null;
  name: string;
  createdAt: string;
  lastOpenedAt: string;
  settingsJson: string;
}

export interface ProviderConfigRow {
  providerConfigId: string;
  projectId: string | null;
  // Same list as the CHECK constraint above, and as the protocol's enum.
  role: ModelRole;
  providerKind: string;
  baseUrl: string | null;
  modelId: string;
  reasoningEffort: string | null;
  temperature: number | null;
  maxTokens: number | null;
  apiKeyRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditRunRow {
  auditRunId: string;
  projectId: string;
  snapshotId: string | null;
  targetClaimRevisionId: string | null;
  requestId: string;
  status: string;
  mode: VerificationMode;
  phase: string | null;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  durationMs: number | null;
  leanVersion: string | null;
  mathlibRevision: string | null;
  proposerConfigId: string | null;
  formalizerConfigId: string | null;
  auxiliaryConfigId: string | null;
}

export interface RunEventRow {
  eventId: string;
  auditRunId: string;
  timestamp: string;
  phase: string;
  level: string;
  message: string;
  payloadJson: string | null;
}

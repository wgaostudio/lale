import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// DB path
// ---------------------------------------------------------------------------

export function defaultDbPath(): string {
  const dir = join(homedir(), '.lale');
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

-- §10.2  (three rows per project: prover, formalizer, auxiliary)
CREATE TABLE IF NOT EXISTS model_provider_configs (
  providerConfigId TEXT PRIMARY KEY,
  projectId        TEXT REFERENCES projects(projectId),
  role             TEXT NOT NULL CHECK (role IN ('prover','formalizer','auxiliary')),
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

-- §10.6
CREATE TABLE IF NOT EXISTS dependency_edges (
  edgeId               TEXT PRIMARY KEY,
  snapshotId           TEXT NOT NULL REFERENCES document_snapshots(snapshotId),
  fromClaimRevisionId  TEXT NOT NULL REFERENCES claim_revisions(claimRevisionId),
  toClaimRevisionId    TEXT NOT NULL REFERENCES claim_revisions(claimRevisionId),
  label                TEXT,
  kind                 TEXT NOT NULL CHECK (kind IN ('explicitRef','context','external')),
  resolutionStatus     TEXT NOT NULL CHECK (resolutionStatus IN ('resolved','unresolved','ambiguous')),
  sourceSpanJson       TEXT,
  trustStatus          TEXT NOT NULL DEFAULT 'unverified'
);

-- §10.7 — three nullable config ID columns (updated from single modelProviderConfigId)
CREATE TABLE IF NOT EXISTS audit_runs (
  auditRunId            TEXT PRIMARY KEY,
  projectId             TEXT NOT NULL REFERENCES projects(projectId),
  snapshotId            TEXT REFERENCES document_snapshots(snapshotId),
  targetClaimRevisionId TEXT REFERENCES claim_revisions(claimRevisionId),
  requestId             TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('queued','running','paused','cancelled','finished')),
  phase                 TEXT,
  startedAt             TEXT NOT NULL,
  finishedAt            TEXT,
  outcome               TEXT,
  durationMs            INTEGER,
  leanVersion           TEXT,
  mathlibRevision       TEXT,
  proverConfigId        TEXT REFERENCES model_provider_configs(providerConfigId),
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
  db.exec(SCHEMA);
  migrateAuditRunPausedStatus(db);
  return db;
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
          phase                 TEXT,
          startedAt             TEXT NOT NULL,
          finishedAt            TEXT,
          outcome               TEXT,
          durationMs            INTEGER,
          leanVersion           TEXT,
          mathlibRevision       TEXT,
          proverConfigId        TEXT REFERENCES model_provider_configs(providerConfigId),
          formalizerConfigId    TEXT REFERENCES model_provider_configs(providerConfigId),
          auxiliaryConfigId     TEXT REFERENCES model_provider_configs(providerConfigId)
        );
        INSERT INTO audit_runs_new
          (auditRunId, projectId, snapshotId, targetClaimRevisionId, requestId, status, phase,
           startedAt, finishedAt, outcome, durationMs, leanVersion, mathlibRevision,
           proverConfigId, formalizerConfigId, auxiliaryConfigId)
        SELECT
          auditRunId, projectId, snapshotId, targetClaimRevisionId, requestId, status, phase,
          startedAt, finishedAt, outcome, durationMs, leanVersion, mathlibRevision,
          proverConfigId, formalizerConfigId, auxiliaryConfigId
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
  role: 'prover' | 'formalizer' | 'auxiliary';
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
  phase: string | null;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  durationMs: number | null;
  leanVersion: string | null;
  mathlibRevision: string | null;
  proverConfigId: string | null;
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

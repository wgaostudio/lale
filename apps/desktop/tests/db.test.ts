import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { parseLatexDocument } from '@lale/document-parser';
import { openDb } from '../src/db.js';
import { propagateStaleness } from '../src/pipeline/run.js';

test('legacy role and paused-status migrations preserve runs and references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lale-migration-'));
  const path = join(dir, 'legacy.db');
  let db = openDb(':memory:');
  try {
    // Reconstruct the schema before either migration existed, including data
    // that must survive both table rebuilds.
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ sql: string }>;
    db.close();
    db = new Database(path);
    db.exec(schema.map(({ sql }) => sql
      .replaceAll('proposer', 'prover')
      .replace("'running','paused','cancelled'", "'running','cancelled'")
      .replace(/\s+mode\s+TEXT[^\n]+\n/, '\n')).join(';\n'));
    db.exec(`
      INSERT INTO projects VALUES ('project', 'overleaf', NULL, NULL, 'Test', 'now', 'now', '{}');
      INSERT INTO model_provider_configs
        (providerConfigId, projectId, role, providerKind, modelId, createdAt, updatedAt)
        VALUES ('config', 'project', 'prover', 'local', 'test', 'now', 'now');
      INSERT INTO audit_runs (auditRunId, projectId, requestId, status, phase, startedAt, proverConfigId)
        VALUES ('run', 'project', 'request', 'running', 'proverAttempt', 'now', 'config');
      INSERT INTO run_events (eventId, auditRunId, timestamp, phase, level, message)
        VALUES ('event', 'run', 'now', 'proverAttempt', 'info', 'Testing');
    `);
    db.close();
    db = openDb(path);
    assert.deepEqual(db.prepare('SELECT proposerConfigId, mode, phase FROM audit_runs').get(), {
      proposerConfigId: 'config', mode: 'full', phase: 'proposerAttempt',
    });
    assert.deepEqual(db.prepare('SELECT role FROM model_provider_configs').get(), { role: 'proposer' });
    assert.deepEqual(db.prepare('SELECT phase FROM run_events').get(), { phase: 'proposerAttempt' });
    db.prepare("UPDATE audit_runs SET status = 'paused', mode = 'proofSkeleton'").run();
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    db.close();
    db = openDb(path);
    assert.deepEqual(db.prepare('SELECT status, mode FROM audit_runs').get(), {
      status: 'paused', mode: 'proofSkeleton',
    });
  } finally {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Staleness used to walk `dependency_edges`, which nothing ever wrote, so the
// traversal silently found nothing. It now reads the parser's resolved edges.

const CITED_CHAIN = String.raw`\begin{lemma}\label{lem:a} A.\end{lemma}
\begin{lemma}\label{lem:b} B, by \ref{lem:a}.\end{lemma}
\begin{theorem}\label{thm:c} C, by \ref{lem:b}.\end{theorem}`;

function projectWithClaims(statuses: Record<string, string>): Database.Database {
  const db = openDb(':memory:');
  db.exec(`INSERT INTO projects VALUES ('p', 'overleaf', NULL, NULL, 'T', 'now', 'now', '{}')`);
  const insert = db.prepare(
    `INSERT INTO claim_identities
       (claimIdentityId, projectId, currentLabel, currentKind, firstSeenAt, lastSeenAt, statusCache)
     VALUES (?, 'p', ?, 'lemma', 'now', 'now', ?)`,
  );
  for (const [label, status] of Object.entries(statuses)) insert.run(label, label, status);
  return db;
}

const statuses = (db: Database.Database): Record<string, string> =>
  Object.fromEntries(
    (db.prepare('SELECT currentLabel, statusCache FROM claim_identities').all() as Array<{
      currentLabel: string;
      statusCache: string;
    }>).map((row) => [row.currentLabel, row.statusCache]),
  );

test('editing a claim marks the claims that cite it stale, transitively', () => {
  const db = projectWithClaims({ 'lem:a': 'verified', 'lem:b': 'verified', 'thm:c': 'verified' });
  try {
    // thm:c cites lem:b, which cites lem:a. Editing lem:a must reach both.
    propagateStaleness(db, 'p', parseLatexDocument(CITED_CHAIN), 'lem:a');
    assert.deepEqual(statuses(db), { 'lem:a': 'stale', 'lem:b': 'stale', 'thm:c': 'stale' });
  } finally {
    db.close();
  }
});

test('staleness passes through a claim with nothing to invalidate', () => {
  // lem:b was never established, so it has nothing to lose — but thm:c, which
  // depends on it and was verified, still does.
  const db = projectWithClaims({ 'lem:a': 'verified', 'lem:b': 'pending', 'thm:c': 'verified' });
  try {
    propagateStaleness(db, 'p', parseLatexDocument(CITED_CHAIN), 'lem:a');
    assert.deepEqual(statuses(db), { 'lem:a': 'stale', 'lem:b': 'pending', 'thm:c': 'stale' });
  } finally {
    db.close();
  }
});

test('an unrelated claim is left alone, and a citation cycle terminates', () => {
  const db = projectWithClaims({ 'lem:a': 'verified', 'lem:b': 'verified', 'thm:c': 'verified' });
  try {
    const cycle = String.raw`\begin{lemma}\label{lem:a} A, by \ref{lem:b}.\end{lemma}
\begin{lemma}\label{lem:b} B, by \ref{lem:a}.\end{lemma}
\begin{theorem}\label{thm:c} C, standalone.\end{theorem}`;
    propagateStaleness(db, 'p', parseLatexDocument(cycle), 'lem:a');
    assert.deepEqual(statuses(db), { 'lem:a': 'stale', 'lem:b': 'stale', 'thm:c': 'verified' });
  } finally {
    db.close();
  }
});

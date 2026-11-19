import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { latestAcceptedLeanDeclaration } from '../src/pipeline/run.js';

// A claim proved only given cited results is usable downstream only with
// those results attached, and never as an unconditional proof.

function seed(outcome: string, statusCache: string, compositionJson: string | null) {
  const db = openDb(':memory:');
  db.exec(`
    INSERT INTO projects VALUES ('p', 'overleaf', NULL, NULL, 'Test', 'now', 'now', '{}');
    INSERT INTO document_snapshots (snapshotId, projectId, documentFingerprint, parserVersion, capturedAt, documentText, parsedDocumentJson)
      VALUES ('snap', 'p', 'f', 'v', 'now', '', '{}');
    INSERT INTO claim_identities (claimIdentityId, projectId, currentLabel, currentKind, firstSeenAt, lastSeenAt, statusCache)
      VALUES ('ci', 'p', 'thm:three', 'theorem', 'now', 'now', '${statusCache}');
    INSERT INTO claim_revisions (claimRevisionId, claimIdentityId, snapshotId, label, kind, statement, body, startLine, endLine, startOffset, endOffset, claimFingerprint)
      VALUES ('cr', 'ci', 'snap', 'thm:three', 'theorem', 's', 'b', 1, 2, 0, 10, 'fp');
    INSERT INTO audit_runs (auditRunId, projectId, targetClaimRevisionId, requestId, mode, status, startedAt, finishedAt, outcome)
      VALUES ('r', 'p', 'cr', 'q', 'proofSkeleton', 'finished', 'now', 'later', '${outcome}');
    INSERT INTO frozen_headers (frozenHeaderId, auditRunId, theoremName, sourceHash) VALUES ('fh', 'r', 'three', 'h');
    INSERT INTO final_proof_artifacts (finalProofId, auditRunId, leanSource, leanSourceHash, acceptedByLean, createdAt)
      VALUES ('fp', 'r', 'theorem three_givenCitations : laleCite_three_1 → P := by exact x', 'h', 1, 'now');
  `);
  if (compositionJson !== null) {
    db.prepare('INSERT INTO proof_arguments (auditRunId, citationsJson, compositionJson, agentSpendUsd, createdAt) VALUES (?, ?, ?, 0, ?)')
      .run('r', '[]', compositionJson, 'now');
  }
  return db;
}

test('a conditional dependency comes with its assumptions', (t) => {
  const db = seed('verifiedGivenCitations', 'verifiedGivenCitations', JSON.stringify({
    status: 'proved', conditionalOn: ['laleCite_three_1', 'laleCite_lem_1'],
    assumptions: [
      { leanName: 'laleCite_three_1', name: 'Bergman', statement: 'no GK dim in (1,2)' },
      { leanName: 'laleCite_lem_1', name: 'Small–Warfield', statement: 'GK dim 1 ⇒ PI', from: 'lem:sw' },
    ],
  }));
  t.after(() => db.close());
  const accepted = latestAcceptedLeanDeclaration(db, 'p', 'thm:three', 'fp');
  assert.match(accepted!.source, /three_givenCitations/);
  assert.deepEqual(accepted!.assumes, [
    { leanName: 'laleCite_three_1', name: 'Bergman', statement: 'no GK dim in (1,2)', from: 'thm:three' },
    { leanName: 'laleCite_lem_1', name: 'Small–Warfield', statement: 'GK dim 1 ⇒ PI', from: 'lem:sw' },
  ]);
});

test('a conditional dependency whose assumptions cannot be read is not usable at all', (t) => {
  for (const composition of [null, '{"status":"proved"}', '{"assumptions":[{"leanName":3}]}', 'not json']) {
    const db = seed('verifiedGivenCitations', 'verifiedGivenCitations', composition);
    t.after(() => db.close());
    assert.equal(latestAcceptedLeanDeclaration(db, 'p', 'thm:three', 'fp'), null, String(composition));
  }
});

test('an unconditional dependency has no assumptions, and a failed one is not offered', (t) => {
  const ok = seed('verified', 'verified', null);
  t.after(() => ok.close());
  assert.deepEqual(latestAcceptedLeanDeclaration(ok, 'p', 'thm:three', 'fp')?.assumes, []);
  const failed = seed('proofIncomplete', 'failed', null);
  t.after(() => failed.close());
  assert.equal(latestAcceptedLeanDeclaration(failed, 'p', 'thm:three', 'fp'), null);
});

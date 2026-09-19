import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { PARSER_VERSION, parseLatexDocument } from '@lale/document-parser';
import { LeanRunner } from '@lale/lean-runner';
import type { VerificationMode } from '@lale/protocol';
import { BudgetExceededError, ModelClient } from '@lale/translator';
import { openDb } from '../src/db.js';
import { acknowledgeInformalAudit, runPipeline } from '../src/pipeline/run.js';

test('pipeline preserves theorem/definition semantics and resumes the selected mode', async (t) => {
  // Stub the optional OS keychain before running the real orchestration. No
  // keychain access, model request, or Lean subprocess occurs in this test.
  const keytar = await import('keytar').catch(() => null);
  if (!keytar) { t.skip('Optional keytar module is unavailable'); return; }
  t.mock.method(keytar.default, 'getPassword', async () => 'test-key');
  const db = openDb(':memory:');
  t.after(() => db.close());
  db.exec(`
    INSERT INTO projects VALUES ('project', 'overleaf', NULL, NULL, 'Test', 'now', 'now', '{}');
    INSERT INTO model_provider_configs
      (providerConfigId, projectId, role, providerKind, baseUrl, modelId, apiKeyRef, createdAt, updatedAt)
      VALUES ('config', 'project', 'formalizer', 'local', 'http://localhost:1', 'test', 'lale:test', 'now', 'now');
  `);

  let pauseNextAudit = false;
  let segmented = 0;
  // Set to an error the next step-formalization call should throw, so a failure
  // can be injected after formalization and faithfulness have already passed.
  let stepFormalizationError: Error | null = null;
  const theorem = 'import Mathlib\ntheorem addZero : ∀ (n : Nat), n + 0 = n := by sorry';
  t.mock.method(ModelClient.prototype, 'complete', async (system: string) => {
    let text: string;
    if (system.includes('proofreader')) {
      text = JSON.stringify({ verdict: pauseNextAudit ? 'possibleGap' : 'noObviousIssue', confidence: 'high', findings: [] });
      pauseNextAudit = false;
    } else if (system.includes('proof analyst')) {
      segmented++;
      text = JSON.stringify({ steps: [{ claim: 'n + 0 = n', sourceText: 'By addition.', uses: [] }] });
    } else if (system.includes('mathematical writing assistant')) {
      text = 'For every natural number n, n + 0 = n.';
    } else if (system.includes('statement comparison')) {
      text = JSON.stringify({ agreement: 'agree', explanation: 'Same content.' });
    } else if (system.includes('mathematical definition')) {
      text = JSON.stringify({ declarationName: 'zero', declarationKind: 'def', leanSource: 'def zero : Nat := 0' });
    } else if (system.includes('ONE step')) {
      if (stepFormalizationError) throw stepFormalizationError;
      text = JSON.stringify({ theoremName: 'stepOne', leanSource: theorem.replace('addZero', 'stepOne') });
    } else if (system.includes('autoformalization assistant')) {
      text = JSON.stringify({ theoremName: 'addZero', leanSource: theorem });
    } else {
      throw new Error(`Unexpected model call: ${system.slice(0, 80)}`);
    }
    return { text, usage: { inputTokens: 10, outputTokens: 10 } };
  });
  t.mock.method(LeanRunner.prototype, 'check', async (_source: string, options = {}) => {
    const name = (options as { declarationName?: string }).declarationName;
    return {
      status: 'ok', diagnostics: [], trustViolations: [], elapsedMs: 0, stdout: '', stderr: '',
      ...(name ? { certificate: { declarationName: name, normalizedGoalTerm: 'test-goal', axioms: [] } } : {}),
    };
  });

  async function start(latex: string, claimId: string, mode: VerificationMode) {
    return runPipeline(db, {
      requestId: crypto.randomUUID(), projectId: 'project', claimId,
      documentText: latex, parsedDocumentFingerprint: parseLatexDocument(latex).fingerprint,
      parserVersion: 'old-extension-parser', leanProjectDir: '/nonexistent/lale-test', mode,
    }, {
      leanVersion: 'test', mathlibRevision: 'test', tokenBudgetCap: 250_000, wallClockCapMs: 100,
      proposerConfigId: 'config', formalizerConfigId: 'config', auxiliaryConfigId: 'config',
    });
  }

  async function waitFor(runId: string, status: string) {
    for (let i = 0; i < 200; i++) {
      const row = db.prepare('SELECT status, outcome FROM audit_runs WHERE auditRunId = ?')
        .get(runId) as { status: string; outcome: string | null };
      if (row.status === status) return row;
      if (row.status === 'finished') assert.fail(`Run finished unexpectedly: ${row.outcome}`);
      await delay(5);
    }
    assert.fail(`Run did not reach ${status}`);
  }

  const latex = String.raw`\begin{lemma}\label{lem:a} For natural $n$, $n + 0 = n$.\end{lemma}
\begin{proof}By addition.\end{proof}`;

  await t.test('formalize-only theorem uses the theorem path and cannot become a proven dependency', async () => {
    const runId = await start(latex, 'lem:a', 'formalizeOnly');
    assert.equal((await waitFor(runId, 'finished')).outcome, 'formalized');
    const row = db.prepare('SELECT artifactsJson FROM frozen_headers WHERE auditRunId = ?')
      .get(runId) as { artifactsJson: string };
    const artifact = JSON.parse(row.artifactsJson);
    assert.equal(artifact.artifactKind, 'theorem');
    assert.match(artifact.leanSource, /theorem addZero/);
    assert.deepEqual(db.prepare('SELECT DISTINCT parserVersion FROM document_snapshots').all(), [{ parserVersion: PARSER_VERSION }]);

    const dependent = latex + String.raw`\begin{theorem}\label{thm:b} By \ref{lem:a}, $n + 0 = n$.\end{theorem}`;
    const dependentRun = await start(dependent, 'thm:b', 'full');
    assert.equal((await waitFor(dependentRun, 'finished')).outcome, 'dependencyMissing');
  });

  await t.test('definitions remain definitions', async () => {
    const runId = await start(String.raw`\begin{definition}\label{def:zero} Let zero be $0$.\end{definition}`, 'def:zero', 'formalizeOnly');
    assert.equal((await waitFor(runId, 'finished')).outcome, 'formalized');
    const row = db.prepare('SELECT artifactsJson FROM frozen_headers WHERE auditRunId = ?')
      .get(runId) as { artifactsJson: string };
    assert.equal(JSON.parse(row.artifactsJson).artifactKind, 'definition');
  });

  await t.test('acknowledging a paused proof-skeleton run still checks its steps', async () => {
    pauseNextAudit = true;
    const runId = await start(latex, 'lem:a', 'proofSkeleton');
    await waitFor(runId, 'paused');
    assert.equal(segmented, 0);
    const acknowledgement = await acknowledgeInformalAudit(db, runId, 'Continue the test.', '/nonexistent/lale-test');
    assert.equal(acknowledgement.resumed, true);
    assert.equal((await waitFor(runId, 'finished')).outcome, 'verified');
    assert.equal(segmented, 1);
    assert.deepEqual(db.prepare('SELECT status FROM proof_steps WHERE auditRunId = ?').all(runId), [{ status: 'checked' }]);
  });

  // `proofIncomplete` is a statement about the author's mathematics; a run that
  // simply ran out of budget has said nothing about it. The step path used to
  // record the exhaustion as a step diagnostic, which made an unproved step,
  // which made a run that told the author their proof had a gap.
  await t.test('a spent run budget blocks the run rather than faulting the proof', async () => {
    stepFormalizationError = new BudgetExceededError('Run budget exhausted before the next request');
    try {
      const runId = await start(latex, 'lem:a', 'proofSkeleton');
      assert.equal((await waitFor(runId, 'finished')).outcome, 'verificationBlocked');
    } finally {
      stepFormalizationError = null;
    }
  });

  // The other side of that line: a step the model genuinely could not state is
  // a fact about the proof, and must keep reading as one.
  await t.test('a step the model cannot state is still proofIncomplete', async () => {
    stepFormalizationError = new Error('Model returned non-JSON response');
    try {
      const runId = await start(latex, 'lem:a', 'proofSkeleton');
      assert.equal((await waitFor(runId, 'finished')).outcome, 'proofIncomplete');
      assert.deepEqual(db.prepare('SELECT status FROM proof_steps WHERE auditRunId = ?').all(runId), [{ status: 'blocked' }]);
    } finally {
      stepFormalizationError = null;
    }
  });
});

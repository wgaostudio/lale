import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ArgumentStep, RunResult } from '@lale/protocol';
import { judgeEvalCase, loadEvalCases } from '../src/eval-cases.js';

const cases = loadEvalCases(JSON.parse(await readFile(new URL('../../../evals/claims/cases.json', import.meta.url), 'utf8')));
const byId = (id: string) => cases.find((c) => c.id === id)!;

function step(idx: number, claim: string, proved: boolean, report: string | null = null): ArgumentStep {
  return { idx, claim, sourceText: '', status: 'checked', proofStatus: proved ? 'proved' : 'unproved', closedBy: proved ? 'agent' : null,
    uses: [], cites: [], leanStatement: null, backtranslation: null, diagnostics: [], report, spentUsd: null, turns: null };
}

function result(outcome: RunResult['outcome'], argument: RunResult['argument'] = null): RunResult {
  return { protocolVersion: 1, runId: 'r', claimId: 'c', status: 'finished', outcome, faithfulnessVerdict: null,
    leanSource: null, diagnostics: [], durationMs: 1, argument };
}

const composition = (status: 'proved' | 'unproved' | 'skipped') => ({ status, conditionalOn: [], closedBy: null, report: null, diagnostics: [] });

test('the shipped eval cases load and are internally consistent', () => {
  assert.ok(cases.length >= 9);
  assert.ok(cases.filter((c) => c.mode === 'proofSkeleton').length >= 6);
  assert.throws(() => loadEvalCases([{ ...byId('steps-sound'), latex: 'no claims here' }]), /not found/);
  assert.throws(() => loadEvalCases([{ ...byId('false-zero-one'), expected: ['verified'] }]), /mustNotPass contradicts/);
  assert.throws(() => loadEvalCases([byId('nat-add-zero'), byId('nat-add-zero')]), /Duplicate/);
});

test('a false step must be found at the step, not just as an outcome', () => {
  const fixture = byId('steps-false-step');
  const atStep = judgeEvalCase(fixture, result('proofIncomplete', {
    steps: [step(1, 'For every natural number n, n^2 is even', false, 'Counterexample n = 1.'), step(2, 'parity', true)],
    citations: [], composition: composition('skipped'), agentSpendUsd: 1, proverModel: null, budget: null,
  }));
  assert.deepEqual(atStep, { passed: true, falseAcceptance: false, failures: [] });

  const wrongPlace = judgeEvalCase(fixture, result('proofIncomplete', {
    steps: [step(1, 'n^2 is even', true), step(2, 'Hence n^2 + n is even', false)],
    citations: [], composition: composition('skipped'), agentSpendUsd: 1, proverModel: null, budget: null,
  }));
  assert.equal(wrongPlace.passed, false, 'right outcome, wrong reason');

  // The live run wrote "n²"; the fixture says "n^2". Same thing.
  const superscript = judgeEvalCase(fixture, result('proofIncomplete', {
    steps: [step(1, 'For every natural number n, n² is even.', false, 'Fails at n = 1.'), step(2, 'n² + n is even', true)],
    citations: [], composition: composition('skipped'), agentSpendUsd: 1, proverModel: null, budget: null,
  }));
  assert.deepEqual(superscript.failures, []);
  assert.match(wrongPlace.failures[0]!, /no failing step mentions/);
});

test('passing a false theorem is flagged as a false acceptance', () => {
  const verdict = judgeEvalCase(byId('steps-false-theorem'), result('verifiedGivenCitations', {
    steps: [step(1, 'no proper factors', true)], citations: [], composition: composition('proved'), agentSpendUsd: 1, proverModel: null, budget: null,
  }));
  assert.equal(verdict.falseAcceptance, true);
  assert.equal(verdict.failures[0], 'FALSE ACCEPTANCE');
});

test('composition and citation expectations', () => {
  const doesNot = byId('steps-do-not-compose');
  const failsAtComposition = judgeEvalCase(doesNot, result('proofIncomplete', {
    steps: [step(1, 'x^2 >= 0', true)], citations: [], composition: composition('unproved'), agentSpendUsd: 0, proverModel: null, budget: null,
  }));
  assert.equal(failsAtComposition.passed, true);
  const filledIn = judgeEvalCase(doesNot, result('verified', {
    steps: [step(1, 'x^2 >= 0', true), step(2, 'x^2+2x+2 > 0', true)], citations: [], composition: composition('proved'), agentSpendUsd: 0, proverModel: null, budget: null,
  }));
  assert.ok(filledIn.failures.includes('steps composed, but should not have'));

  const assumed = judgeEvalCase(byId('steps-citation-assumed'), result('verifiedGivenCitations', {
    steps: [step(1, 'apply', true)],
    citations: [{ idx: 1, name: 'Oliveira e Silva, Herzog and Pardi', statement: 'Goldbach to 4e18', status: 'discharged', reason: '', leanSource: null, backtranslation: null, inheritedFrom: null }],
    composition: composition('proved'), agentSpendUsd: 0, proverModel: null, budget: null,
  }));
  assert.match(assumed.failures.join(), /was discharged, expected assumed/);
  assert.match(judgeEvalCase(byId('steps-sound'), null).failures[0]!, /did not finish/);
});

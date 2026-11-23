import { z } from 'zod';
import { parseLatexDocument } from '@lale/document-parser';
import { ProverOptions, VerificationMode, VerificationOutcome, type RunResult } from '@lale/protocol';

// ---------------------------------------------------------------------------
// Evaluation cases
//
// A case is a small LaTeX document, the claim to check, and what should
// happen. For Check proof steps that is more than an outcome: a proof with a
// false step should fail *at that step*, a cited result should be assumed or
// discharged as appropriate, and steps that stop short should be reported as
// not reaching the theorem. Getting the right outcome for the wrong reason is
// a failed case.
// ---------------------------------------------------------------------------

const PASSING_OUTCOMES = new Set(['verified', 'verifiedGivenCitations']);

/** Lowercase, with superscript digits spelled `^n`: models write n² as often as n^2. */
function normalizeMath(text: string): string {
  const superscripts: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
  return text.toLowerCase().replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (run) => `^${[...run].map((c) => superscripts[c]).join('')}`);
}

export const EvalCase = z.object({
  id: z.string().min(1),
  /** One line on what the case tests and what a failure would mean. */
  about: z.string().optional(),
  claimId: z.string().min(1),
  latex: z.string().min(1),
  mode: VerificationMode.default('full'),
  prover: ProverOptions.optional(),
  expected: z.array(VerificationOutcome).min(1),
  /** A pass of this claim is a false acceptance: the theorem is false. */
  mustNotPass: z.boolean().default(false),
  /** Default 15, or 45 for Check proof steps: every Lean check reloads Mathlib, and a cited result alone takes a dozen. */
  timeoutMinutes: z.number().positive().optional(),
  argument: z.object({
    allStepsProved: z.boolean().optional(),
    /** Some step that did not hold has a claim or gap report containing all of these (case-insensitive). */
    failingStepMentions: z.array(z.string()).optional(),
    /** ...and none of these, to tell the failing step apart from the conclusion that echoes it. */
    failingStepNotMentions: z.array(z.string()).optional(),
    /** ...and it was refuted (Lean-checked counterexample), not merely left unproved. */
    failingStepRefuted: z.boolean().optional(),
    /** Whether the steps should reach the theorem. */
    composes: z.boolean().optional(),
    citations: z.array(z.object({
      nameMentions: z.string(),
      status: z.array(z.enum(['assumed', 'discharged', 'rejected', 'unstated'])),
    })).optional(),
  }).optional(),
});
export type EvalCase = z.infer<typeof EvalCase> & { timeoutMinutes: number };

export function loadEvalCases(json: unknown): EvalCase[] {
  const cases = z.array(EvalCase).parse(json).map((c) => ({
    ...c, timeoutMinutes: c.timeoutMinutes ?? (c.mode === 'proofSkeleton' ? 45 : 15),
  }));
  const ids = new Set<string>();
  for (const fixture of cases) {
    if (ids.has(fixture.id)) throw new Error(`Duplicate eval case id: ${fixture.id}`);
    ids.add(fixture.id);
    const claim = parseLatexDocument(fixture.latex).claims.find((c) => c.id === fixture.claimId);
    if (!claim) throw new Error(`Eval case ${fixture.id}: claim ${fixture.claimId} not found in its LaTeX`);
    if (fixture.mode === 'proofSkeleton' && !claim.proof) throw new Error(`Eval case ${fixture.id}: proofSkeleton needs a proof`);
    if (fixture.argument && fixture.mode !== 'proofSkeleton') throw new Error(`Eval case ${fixture.id}: argument expectations need proofSkeleton`);
    if (fixture.mustNotPass && fixture.expected.some((o) => PASSING_OUTCOMES.has(o))) {
      throw new Error(`Eval case ${fixture.id}: mustNotPass contradicts a passing expected outcome`);
    }
  }
  return cases;
}

export interface EvalVerdict {
  passed: boolean;
  falseAcceptance: boolean;
  /** Each expectation that was not met, in words. */
  failures: string[];
}

export function judgeEvalCase(fixture: EvalCase, result: RunResult | null): EvalVerdict {
  const failures: string[] = [];
  const outcome = result?.outcome ?? null;
  if (!outcome) failures.push('run did not finish');
  else if (!fixture.expected.includes(outcome)) failures.push(`outcome ${outcome}, expected ${fixture.expected.join(' or ')}`);
  const falseAcceptance = fixture.mustNotPass && outcome !== null && PASSING_OUTCOMES.has(outcome);

  const want = fixture.argument;
  const argument = result?.argument ?? null;
  if (want && !argument) failures.push('no step-by-step argument was recorded');
  if (want && argument) {
    const held = (s: (typeof argument.steps)[number]): boolean => s.status === 'checked' && s.proofStatus === 'proved';
    if (want.allStepsProved && !argument.steps.every(held)) {
      failures.push(`steps not proved: ${argument.steps.filter((s) => !held(s)).map((s) => s.idx).join(', ')}`);
    }
    if (want.failingStepMentions) {
      const needles = want.failingStepMentions.map(normalizeMath);
      const excluded = (want.failingStepNotMentions ?? []).map(normalizeMath);
      const located = argument.steps.some((s) => {
        const text = normalizeMath(`${s.claim}\n${s.report ?? ''}`);
        return !held(s) && needles.every((n) => text.includes(n)) && !excluded.some((n) => normalizeMath(s.claim).includes(n))
          && (!want.failingStepRefuted || s.proofStatus === 'refuted');
      });
      if (!located) {
        failures.push(`no failing step${want.failingStepRefuted ? ' refuted in Lean' : ''} mentions ${want.failingStepMentions.join(' + ')}`);
      }
    }
    if (want.composes !== undefined) {
      const composed = argument.composition?.status === 'proved';
      const allHeld = argument.steps.length > 0 && argument.steps.every(held);
      // "Does not compose" means every step held and composition then failed;
      // a failure earlier in the chain is a different finding.
      if (want.composes && !composed) failures.push(`steps did not compose (${argument.composition?.status ?? 'no composition'})`);
      if (!want.composes && !(allHeld && argument.composition?.status === 'unproved')) {
        failures.push(composed ? 'steps composed, but should not have' : 'failed before composition, not at it');
      }
    }
    for (const expectation of want.citations ?? []) {
      const citation = argument.citations.find((c) => c.name.toLowerCase().includes(expectation.nameMentions.toLowerCase())
        || c.statement.toLowerCase().includes(expectation.nameMentions.toLowerCase()));
      if (!citation) failures.push(`no citation matching "${expectation.nameMentions}"`);
      else if (!expectation.status.includes(citation.status)) {
        failures.push(`citation "${citation.name}" was ${citation.status}, expected ${expectation.status.join(' or ')}`);
      }
    }
  }
  if (falseAcceptance) failures.unshift('FALSE ACCEPTANCE');
  return { passed: failures.length === 0, falseAcceptance, failures };
}

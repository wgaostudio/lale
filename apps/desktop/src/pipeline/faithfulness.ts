import type { ModelClient, TokenUsage } from '@lale/translator';
import {
  backtranslate,
  compareFaithfulness,
  reformalizeDefinition,
  reformalizeStatement,
  proposeEquivalenceProof,
} from '@lale/translator';
import type { LeanCheckOptions, LeanRunner } from '@lale/lean-runner';
import { equivalenceObligation, fillEquivalence, parseObligation } from '@lale/lean-runner';
import type { FaithfulnessVerdict } from '@lale/protocol';
import { composeLeanFile, type FormalizeResult } from './formalize.js';
import { formatDependencyDeclarations } from './context.js';
import type { ResolvedDependency } from './context.js';

// ---------------------------------------------------------------------------
// Tier-1 equivalence tactic budget (§8)
// Tries cheap tactics to close `S1 ↔ S2` directly in Lean.
// ---------------------------------------------------------------------------

// S2 is a cross-check, so a wrong Lean rendering of it is worth one repair
// attempt but not an open-ended budget.
const MAX_S2_ATTEMPTS = 2;

const TIER1_TACTICS = ['rfl', 'simp [laleRoundtripLeft, laleRoundtripRight]', 'unfold laleRoundtripLeft laleRoundtripRight; tauto', 'unfold laleRoundtripLeft laleRoundtripRight; omega', 'unfold laleRoundtripLeft laleRoundtripRight; norm_num', 'decide', 'unfold laleRoundtripLeft laleRoundtripRight; aesop'];

// ---------------------------------------------------------------------------
// Main faithfulness check (§8 aggregation)
// ---------------------------------------------------------------------------

export interface FaithfulnessCheckResult {
  verdict: FaithfulnessVerdict;
  backtranslationAgreement: 'agree' | 'disagree' | 'uncertain' | null;
  backtranslatedNL: string | null;
  roundtripTier: 1 | 2 | null;
  roundtripEvidence: string | null;
  s2Source: string | null;
  totalUsage: TokenUsage;
}

export async function checkFaithfulness(
  auxiliaryClient: ModelClient,
  formalizerClient: ModelClient,
  proposerClient: ModelClient,
  runner: LeanRunner,
  formalized: FormalizeResult,
  originalStatement: string,
  ambientContext: string,
  deps: ResolvedDependency[],
  leanVersion: string,
  mathlibRevision: string,
): Promise<FaithfulnessCheckResult> {
  const depDecls = formatDependencyDeclarations(deps);
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  // Step 1: Backtranslation pre-filter (§8 step 1).
  const { nlStatement: backtranslatedNL, usage: btUsage } = await backtranslate(auxiliaryClient, formalized.leanSource);
  totalUsage.inputTokens += btUsage.inputTokens;
  totalUsage.outputTokens += btUsage.outputTokens;

  const comparison = await compareFaithfulness(auxiliaryClient, originalStatement, backtranslatedNL, ambientContext);
  totalUsage.inputTokens += comparison.usage.inputTokens;
  totalUsage.outputTokens += comparison.usage.outputTokens;

  if (comparison.agreement === 'disagree') {
    return {
      verdict: 'unfaithful',
      backtranslationAgreement: 'disagree',
      backtranslatedNL,
      roundtripTier: null,
      roundtripEvidence: comparison.explanation,
      s2Source: null,
      totalUsage,
    };
  }

  // Step 2: Roundtrip (§8 step 2).
  const { source: s2Source, candidate: s2Candidate, failure: s2Failure } = await buildS2(
    runner,
    depDecls,
    totalUsage,
    {
      failureLabel: 'Re-formalization for roundtrip check',
      request: (previousError) =>
        reformalizeStatement(formalizerClient, originalStatement, {
          ambientContext,
          dependencyDeclarations: depDecls,
          leanVersion,
          mathlibRevision,
          ...(previousError !== undefined ? { previousError } : {}),
        }),
      // Also the shape check: `parseObligation` rejects an S2 that is not one
      // closed proposition, or whose declared name is not the one in its source.
      accept: (result) => ({
        allowTrustViolations: ['sorry'],
        declarationName: parseObligation(result.leanSource, result.theoremName).name,
      }),
    },
  );

  if (!s2Source) {
    // Could not build the cross-check — "not established", not "unfaithful".
    return {
      verdict: 'needsHumanReview',
      backtranslationAgreement: comparison.agreement,
      backtranslatedNL,
      roundtripTier: null,
      roundtripEvidence: `${s2Failure} (after ${MAX_S2_ATTEMPTS} attempts)`,
      s2Source: s2Candidate,
      totalUsage,
    };
  }

  const fixedEquivalence = equivalenceObligation(formalized.leanSource, s2Source);
  for (const tactic of TIER1_TACTICS) {
    const equivSource = composeLeanFile(depDecls, fillEquivalence(fixedEquivalence, tactic));
    const result = await runner.check(equivSource, { declarationName: 'laleRoundtrip' });
    if (result.status === 'ok' && result.certificate) {
      const verdict: FaithfulnessVerdict =
        comparison.agreement === 'agree' ? 'faithful' : 'needsHumanReview';
      return {
        verdict,
        backtranslationAgreement: comparison.agreement,
        backtranslatedNL,
        roundtripTier: 1,
        roundtripEvidence: `Closed by ${tactic}`,
        s2Source,
        totalUsage,
      };
    }
  }

  // Tier 2: ask the proposer model for a bounded proof of S1 ↔ S2.
  const TIER2_BUDGET = 2;
  let previousError: string | undefined;
  for (let i = 0; i < TIER2_BUDGET; i++) {
    let equivProof: { proofBody: string; usage: TokenUsage };
    try {
      equivProof = await proposeEquivalenceProof(proposerClient, fixedEquivalence, depDecls, previousError);
    } catch {
      break;
    }

    totalUsage.inputTokens += equivProof.usage.inputTokens;
    totalUsage.outputTokens += equivProof.usage.outputTokens;

    const result = await runner.check(composeLeanFile(depDecls, fillEquivalence(fixedEquivalence, equivProof.proofBody)), { declarationName: 'laleRoundtrip' });
    previousError = result.diagnostics.map(d => d.message).join('\n');
    if (result.status === 'ok' && result.certificate) {
      const verdict: FaithfulnessVerdict =
        comparison.agreement === 'agree' ? 'faithful' : 'needsHumanReview';
      return {
        verdict,
        backtranslationAgreement: comparison.agreement,
        backtranslatedNL,
        roundtripTier: 2,
        roundtripEvidence: 'Proposer model closed the biconditional',
        s2Source,
        totalUsage,
      };
    }
  }

  // Failing to prove S1 ↔ S2 does not establish inequivalence, and for a large
  // statement the equivalence can be as hard as the theorem itself — two honest
  // renderings may differ in encoding (`Sym2 V → ℕ` against a symmetric
  // `V → V → ℕ`) and still say the same thing. What is known here is what the
  // definition path already calls `likelyFaithful`: the natural-language
  // comparison agreed and a second, independent formalization type-checks. A
  // comparison that did not agree keeps the weaker verdict.
  const verdict: FaithfulnessVerdict =
    comparison.agreement === 'agree' ? 'likelyFaithful' : 'needsHumanReview';
  return {
    verdict,
    backtranslationAgreement: comparison.agreement,
    backtranslatedNL,
    // No tier established it, which is what callers report.
    roundtripTier: null,
    roundtripEvidence:
      'Roundtrip inconclusive: neither tier closed S1 ↔ S2. S2 type-checks, and the '
      + `natural-language comparison ${comparison.agreement === 'agree' ? 'agreed' : `was ${comparison.agreement}`}`
      + '. Failing to prove the equivalence is a limit of the check, not a finding '
      + 'about the formalization.',
    s2Source,
    totalUsage,
  };
}

export async function checkDefinitionFaithfulness(
  auxiliaryClient: ModelClient,
  formalizerClient: ModelClient,
  runner: LeanRunner,
  formalized: FormalizeResult,
  originalDefinition: string,
  ambientContext: string,
  deps: ResolvedDependency[],
  leanVersion: string,
  mathlibRevision: string,
): Promise<FaithfulnessCheckResult> {
  const depDecls = formatDependencyDeclarations(deps);
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  const { nlStatement: backtranslatedNL, usage: btUsage } = await backtranslate(
    auxiliaryClient,
    formalized.leanSource,
  );
  totalUsage.inputTokens += btUsage.inputTokens;
  totalUsage.outputTokens += btUsage.outputTokens;

  const comparison = await compareFaithfulness(auxiliaryClient, originalDefinition, backtranslatedNL, ambientContext);
  totalUsage.inputTokens += comparison.usage.inputTokens;
  totalUsage.outputTokens += comparison.usage.outputTokens;

  if (comparison.agreement === 'disagree') {
    return {
      verdict: 'unfaithful',
      backtranslationAgreement: 'disagree',
      backtranslatedNL,
      roundtripTier: null,
      roundtripEvidence: comparison.explanation,
      s2Source: null,
      totalUsage,
    };
  }

  const { source: s2Source, candidate: s2Candidate, failure: s2Failure } = await buildS2(
    runner,
    depDecls,
    totalUsage,
    {
      failureLabel: 'Re-formalization for definition faithfulness',
      request: (previousError) =>
        reformalizeDefinition(formalizerClient, originalDefinition, {
          ambientContext,
          dependencyDeclarations: depDecls,
          leanVersion,
          mathlibRevision,
          ...(previousError !== undefined ? { previousError } : {}),
        }),
      // A definition is checked as written; there is no obligation to parse.
      accept: () => ({}),
    },
  );

  if (!s2Source) {
    return {
      verdict: 'needsHumanReview',
      backtranslationAgreement: comparison.agreement,
      backtranslatedNL,
      roundtripTier: null,
      roundtripEvidence: `${s2Failure} (after ${MAX_S2_ATTEMPTS} attempts)`,
      s2Source: s2Candidate,
      totalUsage,
    };
  }

  return {
    verdict: comparison.agreement === 'agree' ? 'likelyFaithful' : 'needsHumanReview',
    backtranslationAgreement: comparison.agreement,
    backtranslatedNL,
    // No tier ran: there is no `S1 ↔ S2` obligation for a definition, so nothing
    // was closed in Lean. Claiming tier 1 made the run log report "closed at
    // tier 1" for a check this function's own evidence calls advisory.
    roundtripTier: null,
    roundtripEvidence: 'Model comparison agreed; definition equivalence remains advisory',
    s2Source,
    totalUsage,
  };
}

// ---------------------------------------------------------------------------
// S2 — the independent second formalization both checks are built on
// ---------------------------------------------------------------------------

/**
 * Formalizes the *original text* a second time, never S1: checking S1 against
 * itself would prove nothing. It gets the same retry-with-diagnostics loop S1
 * gets, because single-shot, one elaboration slip in S2 downgrades the verdict
 * and the roundtrip never runs at all.
 *
 * Returns the accepted source, the last candidate seen (worth reporting even
 * when none type-checked), and why the last attempt failed.
 */
async function buildS2<T extends { leanSource: string; usage: TokenUsage }>(
  runner: LeanRunner,
  depDecls: string,
  totalUsage: TokenUsage,
  spec: {
    /** Names the check in the failure message a `needsHumanReview` verdict carries. */
    failureLabel: string;
    request(previousError: string | undefined): Promise<T>;
    /** Throws if the draft is unusable; otherwise says how Lean should check it. */
    accept(result: T): LeanCheckOptions;
  },
): Promise<{ source: string | null; candidate: string | null; failure: string }> {
  let failure = `${spec.failureLabel} failed to produce S2`;
  let candidate: string | null = null;
  let previousError: string | undefined;

  for (let attempt = 0; attempt < MAX_S2_ATTEMPTS; attempt++) {
    let source: string;
    let checkOptions: LeanCheckOptions;
    try {
      const result = await spec.request(previousError);
      totalUsage.inputTokens += result.usage.inputTokens;
      totalUsage.outputTokens += result.usage.outputTokens;
      source = result.leanSource;
      checkOptions = spec.accept(result);
    } catch (err) {
      failure = `${spec.failureLabel} failed to produce S2: ${String(err)}`;
      previousError = failure;
      continue;
    }

    candidate = source;
    const typeCheck = await runner.check(composeLeanFile(depDecls, source), checkOptions);
    if (typeCheck.status === 'ok') return { source, candidate, failure };

    failure = `S2 does not type-check: ${typeCheck.diagnostics.map((d) => d.message).join('; ')}`;
    previousError = `Previous S2 source:\n${source}\nDiagnostics:\n${failure}`;
  }

  return { source: null, candidate, failure };
}

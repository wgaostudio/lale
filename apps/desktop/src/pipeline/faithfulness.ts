import type { ModelClient, TokenUsage } from '@lale/translator';
import {
  backtranslate,
  compareFaithfulness,
  reformalizeDefinition,
  reformalizeStatement,
  proveEquivalence,
} from '@lale/translator';
import type { LeanRunner } from '@lale/lean-runner';
import type { FaithfulnessVerdict } from '@lale/protocol';
import { composeLeanFile, type FormalizeResult } from './formalize.js';
import { formatDependencyDeclarations } from './context.js';
import type { ResolvedDependency } from './context.js';

// ---------------------------------------------------------------------------
// Tier-1 equivalence tactic budget (§8)
// Tries cheap tactics to close `S1 ↔ S2` directly in Lean.
// ---------------------------------------------------------------------------

const TIER1_TACTICS = ['rfl', 'simp', 'tauto', 'omega', 'norm_num', 'decide', 'aesop'];

function buildEquivSource(s1Source: string, s2Source: string, depDecls: string): string {
  // Extract just the type/header from each formalization.
  // Both are Lean files with `import ...` lines + a theorem.
  // We build a combined file that imports both and states the biconditional.
  const s1Match = /theorem\s+(\w+)\s*(.*?):=\s*by\s+sorry/s.exec(s1Source);
  const s2Match = /theorem\s+(\w+)\s*(.*?):=\s*by\s+sorry/s.exec(s2Source);

  if (!s1Match || !s2Match) return '';

  const imports = extractImports(s1Source);
  const s1Header = `theorem s1_stmt${s1Match[2] ?? ''}: True := trivial`;
  const s2Header = `theorem s2_stmt${s2Match[2] ?? ''}: True := trivial`;

  // Build a file that proves the biconditional.
  // We use the conclusion (everything after the last `:`) as the proposition.
  const s1Conclusion = extractConclusion(s1Source);
  const s2Conclusion = extractConclusion(s2Source);

  if (!s1Conclusion || !s2Conclusion) return '';

  // Extract context (parameters/hypotheses) to wrap the biconditional.
  const s1Context = extractContext(s1Source);

  const tacticAttempts = TIER1_TACTICS.map(
    (tactic) => `theorem roundtrip_equiv${s1Context} : (${s1Conclusion}) ↔ (${s2Conclusion}) := by ${tactic}`,
  );

  return [
    imports,
    depDecls,
    '',
    ...tacticAttempts.slice(0, 1), // Check the first tactic — the runner will iterate outside.
  ].join('\n');
}

// We actually generate one file per tactic so the runner can try them in sequence.
function buildEquivSourceForTactic(
  s1Source: string,
  s2Source: string,
  depDecls: string,
  tactic: string,
): string {
  const imports = extractImports(s1Source);
  const s1Conclusion = extractConclusion(s1Source);
  const s2Conclusion = extractConclusion(s2Source);

  if (!s1Conclusion || !s2Conclusion) return '';

  const s1Context = extractContext(s1Source);

  return [
    imports,
    depDecls,
    '',
    `theorem roundtrip_equiv${s1Context} : (${s1Conclusion}) ↔ (${s2Conclusion}) := by ${tactic}`,
  ].join('\n');
}

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
  proverClient: ModelClient,
  runner: LeanRunner,
  formalized: FormalizeResult,
  originalStatement: string,
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

  const comparison = await compareFaithfulness(auxiliaryClient, originalStatement, backtranslatedNL);
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
  // Re-formalize the backtranslated NL to get S2.
  let s2Source: string;
  try {
    const s2Result = await reformalizeStatement(formalizerClient, backtranslatedNL, {
      dependencyDeclarations: depDecls,
      leanVersion,
      mathlibRevision,
    });
    totalUsage.inputTokens += s2Result.usage.inputTokens;
    totalUsage.outputTokens += s2Result.usage.outputTokens;
    s2Source = s2Result.leanSource;
  } catch {
    // S2 formalization failed — can't form the goal, not an unfaithfulness signal.
    return {
      verdict: 'needsHumanReview',
      backtranslationAgreement: comparison.agreement,
      backtranslatedNL,
      roundtripTier: null,
      roundtripEvidence: 'Re-formalization for roundtrip check failed to produce S2',
      s2Source: null,
      totalUsage,
    };
  }

  // Verify S2 type-checks.
  const s2TypeCheck = await runner.check(
    composeLeanFile(depDecls, s2Source),
    { allowTrustViolations: ['sorry'] },
  );
  if (s2TypeCheck.status !== 'ok') {
    return {
      verdict: 'needsHumanReview',
      backtranslationAgreement: comparison.agreement,
      backtranslatedNL,
      roundtripTier: null,
      roundtripEvidence: `S2 does not type-check: ${s2TypeCheck.diagnostics.map((d) => d.message).join('; ')}`,
      s2Source,
      totalUsage,
    };
  }

  // Tier 1: try cheap tactics directly in Lean (no model calls).
  for (const tactic of TIER1_TACTICS) {
    const equivSource = buildEquivSourceForTactic(
      formalized.leanSource,
      s2Source,
      depDecls,
      tactic,
    );
    if (!equivSource) continue;

    const result = await runner.check(equivSource);
    if (result.status === 'ok') {
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

  // Tier 2: ask the prover model for a bounded proof of S1 ↔ S2.
  const TIER2_BUDGET = 2;
  for (let i = 0; i < TIER2_BUDGET; i++) {
    let equivProof: { leanSource: string; usage: TokenUsage };
    try {
      equivProof = await proveEquivalence(proverClient, formalized.leanSource, s2Source, depDecls);
    } catch {
      break;
    }

    totalUsage.inputTokens += equivProof.usage.inputTokens;
    totalUsage.outputTokens += equivProof.usage.outputTokens;

    const result = await runner.check(equivProof.leanSource);
    if (result.status === 'ok') {
      const verdict: FaithfulnessVerdict =
        comparison.agreement === 'agree' ? 'faithful' : 'needsHumanReview';
      return {
        verdict,
        backtranslationAgreement: comparison.agreement,
        backtranslatedNL,
        roundtripTier: 2,
        roundtripEvidence: 'Prover model closed the biconditional',
        s2Source,
        totalUsage,
      };
    }
  }

  // Both tiers failed — unfaithful or needsHumanReview depending on pre-filter.
  const verdict: FaithfulnessVerdict =
    comparison.agreement === 'uncertain' ? 'needsHumanReview' : 'unfaithful';
  return {
    verdict,
    backtranslationAgreement: comparison.agreement,
    backtranslatedNL,
    roundtripTier: 2,
    roundtripEvidence: 'Both tier-1 and tier-2 failed to close S1 ↔ S2',
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

  const comparison = await compareFaithfulness(auxiliaryClient, originalDefinition, backtranslatedNL);
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

  let s2Source: string;
  try {
    const s2Result = await reformalizeDefinition(formalizerClient, backtranslatedNL, {
      dependencyDeclarations: depDecls,
      leanVersion,
      mathlibRevision,
    });
    totalUsage.inputTokens += s2Result.usage.inputTokens;
    totalUsage.outputTokens += s2Result.usage.outputTokens;
    s2Source = s2Result.leanSource;
  } catch {
    return {
      verdict: 'needsHumanReview',
      backtranslationAgreement: comparison.agreement,
      backtranslatedNL,
      roundtripTier: null,
      roundtripEvidence: 'Re-formalization for definition faithfulness failed to produce S2',
      s2Source: null,
      totalUsage,
    };
  }

  const s2TypeCheck = await runner.check(composeLeanFile(depDecls, s2Source));
  if (s2TypeCheck.status !== 'ok') {
    return {
      verdict: 'needsHumanReview',
      backtranslationAgreement: comparison.agreement,
      backtranslatedNL,
      roundtripTier: null,
      roundtripEvidence: `S2 definition does not type-check: ${s2TypeCheck.diagnostics.map((d) => d.message).join('; ')}`,
      s2Source,
      totalUsage,
    };
  }

  return {
    verdict: comparison.agreement === 'agree' ? 'faithful' : 'needsHumanReview',
    backtranslationAgreement: comparison.agreement,
    backtranslatedNL,
    roundtripTier: 1,
    roundtripEvidence: 'Backtranslation agreed and re-formalized definition type-checked',
    s2Source,
    totalUsage,
  };
}

// ---------------------------------------------------------------------------
// Helpers to extract parts of a Lean theorem header
// ---------------------------------------------------------------------------

function extractImports(source: string): string {
  return source
    .split('\n')
    .filter((line) => line.startsWith('import '))
    .join('\n');
}

function extractConclusion(source: string): string | null {
  // Match everything after the last `:` before `:= by sorry`.
  const match = /:\s*(.*?)\s*:=\s*by\s+sorry/s.exec(source);
  return match?.[1]?.trim() ?? null;
}

function extractContext(source: string): string {
  // Extract parameters/hypotheses block — everything between the theorem name and the final `:`.
  const match = /theorem\s+\w+\s*((?:\([^)]*\)|\{[^}]*\}|\[[^\]]*\])*)\s*:/s.exec(source);
  const ctx = match?.[1]?.trim() ?? '';
  return ctx ? ` ${ctx}` : '';
}

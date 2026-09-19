import { scanTrustViolations, sameObligation } from '@lale/lean-runner';
import type { VerificationOutcome, FaithfulnessVerdict } from '@lale/protocol';
import type { FormalizeResult } from './formalize.js';
import type { FaithfulnessCheckResult } from './faithfulness.js';
import type { ProposerResult } from './proposer.js';

// ---------------------------------------------------------------------------
// Acceptable faithfulness verdicts to pass the gate (§3.13)
// ---------------------------------------------------------------------------

/** Verdicts the final gate will accept. Anything else cannot reach `verified`. */
export const ACCEPTABLE_FAITHFULNESS: Set<FaithfulnessVerdict> = new Set([
  'faithful',
  'likelyFaithful',
]);

// ---------------------------------------------------------------------------
// Final gate (§3.13)
// ---------------------------------------------------------------------------

export interface GateResult {
  passed: boolean;
  outcome: VerificationOutcome;
  violations: string[];
}

export function runFinalGate(
  frozenHeader: FormalizeResult,
  faithfulness: FaithfulnessCheckResult,
  proposerResult: ProposerResult,
): GateResult {
  const violations: string[] = [];

  // A proposed proof must have been accepted by Lean.
  if (proposerResult.outcome !== 'verified' || !proposerResult.acceptedLeanSource) {
    return { passed: false, outcome: proposerResult.outcome, violations };
  }

  const leanSource = proposerResult.acceptedLeanSource;

  // Trust policy scan on final proof.
  const trustViolations = scanTrustViolations(leanSource);
  for (const v of trustViolations) {
    violations.push(`Trust violation: ${v.name}`);
  }

  // Frozen theorem statement must match. A proposal is allowed to replace
  // `:= by sorry` with a real proof, but not to alter binders, assumptions, or
  // the conclusion.
  if (!sameObligation(frozenHeader.leanSource, leanSource, frozenHeader.theoremName)) {
    violations.push('Proof changed the frozen theorem statement or environment');
  }

  // Faithfulness gate.
  if (!ACCEPTABLE_FAITHFULNESS.has(faithfulness.verdict)) {
    violations.push(`Faithfulness check failed: ${faithfulness.verdict}`);
  }

  if (violations.length > 0) {
    // Determine the most specific outcome.
    const hasFaithfulness = violations.some((v) => v.startsWith('Faithfulness'));

    if (hasFaithfulness) {
      return { passed: false, outcome: 'proofDoesNotSupportClaim', violations };
    }
    return { passed: false, outcome: 'verificationBlocked', violations };
  }

  return { passed: true, outcome: 'verified', violations };
}

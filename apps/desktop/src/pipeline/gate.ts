import { scanTrustViolations } from '@lale/lean-runner';
import type { VerificationOutcome, FaithfulnessVerdict } from '@lale/protocol';
import type { FormalizeResult } from './formalize.js';
import type { FaithfulnessCheckResult } from './faithfulness.js';
import type { ProverResult } from './prover.js';

// ---------------------------------------------------------------------------
// Acceptable faithfulness verdicts to pass the gate (§3.13)
// ---------------------------------------------------------------------------

const ACCEPTABLE_FAITHFULNESS: Set<FaithfulnessVerdict> = new Set([
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
  proverResult: ProverResult,
): GateResult {
  const violations: string[] = [];

  // Prover must have succeeded.
  if (proverResult.outcome !== 'verified' || !proverResult.acceptedLeanSource) {
    return { passed: false, outcome: proverResult.outcome, violations };
  }

  const leanSource = proverResult.acceptedLeanSource;

  // Trust policy scan on final proof.
  const trustViolations = scanTrustViolations(leanSource);
  for (const v of trustViolations) {
    violations.push(`Trust violation: ${v.name}`);
  }

  // Frozen header hash must match.
  // (Re-check: the prover should have used the frozen header as its base.)
  if (!leanSource.includes(frozenHeader.theoremName)) {
    violations.push('Proof does not reference the frozen theorem name');
  }

  // Faithfulness gate.
  if (!ACCEPTABLE_FAITHFULNESS.has(faithfulness.verdict)) {
    violations.push(`Faithfulness check failed: ${faithfulness.verdict}`);
  }

  if (violations.length > 0) {
    // Determine the most specific outcome.
    const hasFaithfulness = violations.some((v) => v.startsWith('Faithfulness'));
    const hasTrust = violations.some((v) => v.startsWith('Trust'));

    if (hasFaithfulness) {
      return { passed: false, outcome: 'proofDoesNotSupportClaim', violations };
    }
    if (hasTrust) {
      return { passed: false, outcome: 'verificationBlocked', violations };
    }
    return { passed: false, outcome: 'verificationBlocked', violations };
  }

  return { passed: true, outcome: 'verified', violations };
}

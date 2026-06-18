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

  // Frozen theorem statement must match. The prover is allowed to replace
  // `:= by sorry` with a real proof, but not to alter binders, assumptions, or
  // the conclusion.
  const frozenDeclarationHead = extractDeclarationHead(frozenHeader.leanSource, frozenHeader.theoremName);
  const acceptedDeclarationHead = extractDeclarationHead(leanSource, frozenHeader.theoremName);
  if (!frozenDeclarationHead || !acceptedDeclarationHead) {
    violations.push('Proof does not contain the frozen theorem declaration');
  } else if (normalizeDeclarationHead(frozenDeclarationHead) !== normalizeDeclarationHead(acceptedDeclarationHead)) {
    violations.push('Proof changed the frozen theorem statement');
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

function extractDeclarationHead(source: string, declarationName: string): string | null {
  const escapedName = declarationName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declarationRe = new RegExp(`\\b(?:theorem|lemma)\\s+${escapedName}\\b`);
  const match = declarationRe.exec(source);
  if (!match) return null;

  const assignmentIndex = source.indexOf(':=', match.index);
  if (assignmentIndex === -1) return null;
  return source.slice(match.index, assignmentIndex);
}

function normalizeDeclarationHead(source: string): string {
  return source.replace(/\s+/g, ' ').trim();
}

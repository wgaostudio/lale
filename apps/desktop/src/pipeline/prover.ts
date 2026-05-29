import type { ModelClient, TokenUsage } from '@lale/translator';
import { proveEndToEnd } from '@lale/translator';
import type { LeanRunner } from '@lale/lean-runner';
import type { VerificationOutcome } from '@lale/protocol';
import type { NormalizedClaimContext } from './context.js';
import { formatDependencyDeclarations } from './context.js';
import { composeLeanFile, type FormalizeResult } from './formalize.js';

// ---------------------------------------------------------------------------
// Retry policy (§3.11)
// ---------------------------------------------------------------------------

type LeanFailureClass =
  | 'syntaxElaboration'
  | 'unknownLemma'
  | 'typeMismatch'
  | 'unsolvedGoals'
  | 'timeout'
  | 'blocked'
  | 'other';

function classifyLeanFailure(diagnostics: string[]): LeanFailureClass {
  const joined = diagnostics.join('\n').toLowerCase();
  if (joined.includes('unknown identifier') || joined.includes('unknown constant')) {
    return 'unknownLemma';
  }
  if (joined.includes('unsolved goals')) return 'unsolvedGoals';
  if (joined.includes('type mismatch')) return 'typeMismatch';
  if (joined.includes('expected') || joined.includes('syntax')) return 'syntaxElaboration';
  return 'other';
}

// ---------------------------------------------------------------------------
// Proof attempt types
// ---------------------------------------------------------------------------

export interface ProofAttemptRecord {
  attemptIndex: number;
  status: 'ok' | 'error' | 'timeout' | 'blocked';
  leanSource: string;
  diagnostics: string[];
  failureClass: LeanFailureClass | null;
}

export interface ProverResult {
  outcome: Extract<
    VerificationOutcome,
    'verified' | 'proofIncomplete' | 'verificationBlocked' | 'malformedProof'
  >;
  acceptedLeanSource: string | null;
  attempts: ProofAttemptRecord[];
  totalUsage: TokenUsage;
}

// ---------------------------------------------------------------------------
// End-to-end proof loop (§3.10, §3.11)
// ---------------------------------------------------------------------------

const MAX_SYNTAX_RETRIES = 3;
const MAX_UNSOLVED_RETRIES = 2;

export async function runProver(
  proverClient: ModelClient,
  runner: LeanRunner,
  frozenHeader: FormalizeResult,
  context: NormalizedClaimContext,
): Promise<ProverResult> {
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  if (!context.proofText) {
    return { outcome: 'malformedProof', acceptedLeanSource: null, attempts: [], totalUsage };
  }

  const depDecls = formatDependencyDeclarations(context.resolvedDependencies);
  const attempts: ProofAttemptRecord[] = [];
  let syntaxRetries = 0;
  let unsolvedRetries = 0;
  let previousError: string | undefined;

  for (let i = 0; i < MAX_SYNTAX_RETRIES + MAX_UNSOLVED_RETRIES; i++) {
    let proofAttempt: { leanSource: string; usage: TokenUsage };
    try {
      proofAttempt = await proveEndToEnd(
        proverClient,
        frozenHeader.leanSource,
        context.proofText,
        depDecls,
        previousError,
      );
    } catch (err) {
      attempts.push({
        attemptIndex: i,
        status: 'error',
        leanSource: '',
        diagnostics: [`Prover model error: ${String(err)}`],
        failureClass: null,
      });
      return { outcome: 'verificationBlocked', acceptedLeanSource: null, attempts, totalUsage };
    }

    totalUsage.inputTokens += proofAttempt.usage.inputTokens;
    totalUsage.outputTokens += proofAttempt.usage.outputTokens;

    const checkSource = composeLeanFile(depDecls, proofAttempt.leanSource);
    const leanResult = await runner.check(checkSource);

    if (leanResult.status === 'blocked') {
      attempts.push({
        attemptIndex: i,
        status: 'blocked',
        leanSource: checkSource,
        diagnostics: leanResult.diagnostics.map((d) => d.message),
        failureClass: null,
      });
      return { outcome: 'verificationBlocked', acceptedLeanSource: null, attempts, totalUsage };
    }

    if (leanResult.status === 'timeout') {
      attempts.push({
        attemptIndex: i,
        status: 'timeout',
        leanSource: checkSource,
        diagnostics: leanResult.diagnostics.map((d) => d.message),
        failureClass: null,
      });
      // Per §3.11: do NOT retry on timeout.
      return { outcome: 'verificationBlocked', acceptedLeanSource: null, attempts, totalUsage };
    }

    if (leanResult.status === 'ok') {
      attempts.push({
        attemptIndex: i,
        status: 'ok',
        leanSource: checkSource,
        diagnostics: [],
        failureClass: null,
      });
      return { outcome: 'verified', acceptedLeanSource: checkSource, attempts, totalUsage };
    }

    // Classify the failure and decide retry strategy.
    const diagnostics = leanResult.diagnostics.map((d) => d.message);
    const failureClass = classifyLeanFailure(diagnostics);

    attempts.push({
      attemptIndex: i,
      status: 'error',
      leanSource: checkSource,
      diagnostics,
      failureClass,
    });

    previousError = diagnostics.join('\n');

    if (failureClass === 'unsolvedGoals') {
      unsolvedRetries++;
      if (unsolvedRetries >= MAX_UNSOLVED_RETRIES) {
        // Exhausted unsolved-goals retries → genuine gap (§3.11).
        return { outcome: 'proofIncomplete', acceptedLeanSource: null, attempts, totalUsage };
      }
    } else {
      // syntax/elaboration, unknownLemma, typeMismatch, other — count against syntax budget.
      syntaxRetries++;
      if (syntaxRetries >= MAX_SYNTAX_RETRIES) {
        // Exhausted without ever getting valid Lean → verificationBlocked (§3.11).
        return { outcome: 'verificationBlocked', acceptedLeanSource: null, attempts, totalUsage };
      }
    }
  }

  return { outcome: 'verificationBlocked', acceptedLeanSource: null, attempts, totalUsage };
}

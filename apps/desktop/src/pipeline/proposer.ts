import type { ModelClient, TokenUsage } from '@lale/translator';
import { proposeProof } from '@lale/translator';
import type { LeanRunner } from '@lale/lean-runner';
import { fillObligation } from '@lale/lean-runner';
import type { VerificationOutcome } from '@lale/protocol';
import type { NormalizedClaimContext } from './context.js';
import { formatDependencyDeclarations } from './context.js';
import { composeLeanFile, type FormalizeResult } from './formalize.js';
import { tryTacticLadder } from './tactics.js';

// ---------------------------------------------------------------------------
// Retry policy (§3.11)
// ---------------------------------------------------------------------------

// Only what `classifyLeanFailure` can actually conclude from diagnostics. A
// timeout or a blocked run never reaches it — those return before classification
// and carry a null failure class.
type LeanFailureClass =
  | 'syntaxElaboration'
  | 'unknownLemma'
  | 'typeMismatch'
  | 'unsolvedGoals'
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

export interface ProposerResult {
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

export async function runProposer(
  proposerClient: ModelClient,
  runner: LeanRunner,
  frozenHeader: FormalizeResult,
  context: NormalizedClaimContext,
): Promise<ProposerResult> {
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  if (!context.proofText) {
    return { outcome: 'malformedProof', acceptedLeanSource: null, attempts: [], totalUsage };
  }

  const depDecls = formatDependencyDeclarations(context.resolvedDependencies);
  const attempts: ProofAttemptRecord[] = [];

  // Lean's own automation first: the obligation may not need a model at all.
  const ladder = await tryTacticLadder(runner, frozenHeader.leanSource, frozenHeader.theoremName, depDecls);
  if (ladder) {
    attempts.push({
      attemptIndex: 0,
      status: 'ok',
      leanSource: ladder.leanSource,
      diagnostics: [`Closed by ${ladder.closedBy} without a model call`],
      failureClass: null,
    });
    return { outcome: 'verified', acceptedLeanSource: ladder.leanSource, attempts, totalUsage };
  }
  let syntaxRetries = 0;
  let unsolvedRetries = 0;
  let previousError: string | undefined;

  for (let i = 0; i < MAX_SYNTAX_RETRIES + MAX_UNSOLVED_RETRIES; i++) {
    let proofAttempt: { proofBody: string; usage: TokenUsage };
    try {
      proofAttempt = await proposeProof(
        proposerClient,
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
        diagnostics: [`Proposer model error: ${String(err)}`],
        failureClass: null,
      });
      return { outcome: 'verificationBlocked', acceptedLeanSource: null, attempts, totalUsage };
    }

    totalUsage.inputTokens += proofAttempt.usage.inputTokens;
    totalUsage.outputTokens += proofAttempt.usage.outputTokens;

    const candidate = fillObligation(frozenHeader.leanSource, proofAttempt.proofBody, frozenHeader.theoremName);
    const checkSource = composeLeanFile(depDecls, candidate);
    const leanResult = await runner.check(checkSource, { declarationName: frozenHeader.theoremName });

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

    if (leanResult.status === 'ok' && leanResult.certificate?.normalizedGoalTerm === frozenHeader.normalizedGoalTerm) {
      attempts.push({
        attemptIndex: i,
        status: 'ok',
        leanSource: checkSource,
        diagnostics: [],
        failureClass: null,
      });
      return { outcome: 'verified', acceptedLeanSource: candidate, attempts, totalUsage };
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

    previousError = `Previous proof:\n${proofAttempt.proofBody}\nLean diagnostics:\n${diagnostics.join('\n')}`;

    if (failureClass === 'unsolvedGoals') {
      unsolvedRetries++;
      if (unsolvedRetries >= MAX_UNSOLVED_RETRIES) {
        // The attempt budget is spent. This is generate-and-check, not a search:
        // exhausting it says the model did not produce a proof Lean accepts, not
        // that no proof exists, and nothing here establishes a gap in the prose.
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

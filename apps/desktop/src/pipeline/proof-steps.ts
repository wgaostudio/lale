import {
  BudgetExceededError,
  formalizeProofStep,
  proposeProof,
  segmentProof,
  type ModelClient,
  type ProofStepSpec,
  type TokenUsage,
} from '@lale/translator';
import { LeanRunner, fillObligation, parseObligation } from '@lale/lean-runner';
import { tryTacticLadder } from './tactics.js';
import { composeLeanFile } from './formalize.js';
import { formatDependencyDeclarations, type NormalizedClaimContext } from './context.js';

// ---------------------------------------------------------------------------
// Proof skeleton
//
// The proposer stage answers "is this theorem true"; this stage answers "does
// this argument hold together". Each step of the author's proof becomes its own
// Lean proposition, carrying the theorem's hypotheses and the earlier steps, and
// is checked with `sorry` — so a step that cannot even be stated, or that is
// stated about different objects than the theorem, is caught and located.
// ---------------------------------------------------------------------------

export type ProofStepStatus = 'checked' | 'failed' | 'blocked';

export interface ProofStepProof {
  status: 'proved' | 'unproved' | 'skipped';
  /** The tactic that closed it, `model` for a generated proof, else null. */
  closedBy: string | null;
  leanSource: string | null;
  diagnostics: string[];
}

export interface ProofStepResult {
  idx: number;
  claim: string;
  sourceText: string;
  uses: number[];
  leanSource: string | null;
  theoremName: string | null;
  status: ProofStepStatus;
  diagnostics: string[];
  proof: ProofStepProof;
}

export interface ProofSkeletonResult {
  steps: ProofStepResult[];
  /** Lean sources of the steps that were proved, usable as lemmas downstream. */
  provedSources: string[];
  totalUsage: TokenUsage;
}

export interface ProofSkeletonOptions {
  onProgress?: (message: string, payload?: Record<string, unknown>) => void;
  /** Valid Mathlib modules, so a step's imports get the same help a statement's do. */
  mathlibImportHints?: string[];
}

const MAX_STEP_PROOF_ATTEMPTS = 2;

// One repair attempt per step: enough to fix an elaboration slip, not enough to
// let the model search for a statement Lean will accept regardless of meaning.
const MAX_STEP_ATTEMPTS = 2;

/**
 * Running out of run budget is a fact about the harness, not about the author's
 * argument. Recorded as a step diagnostic it becomes an unproved step, and an
 * unproved step finishes the run as `proofIncomplete` — which tells the author
 * their proof has a gap. Let it out instead: the pipeline's own handler reports
 * `verificationBlocked`, which is what the `full` mode already does with the
 * same error.
 */
function rethrowIfNotAboutTheProof(error: unknown): void {
  if (error instanceof BudgetExceededError) throw error;
}

export async function checkProofSkeleton(
  auxiliaryClient: ModelClient,
  formalizerClient: ModelClient,
  proposerClient: ModelClient,
  runner: LeanRunner,
  frozenStatement: string,
  context: NormalizedClaimContext,
  leanVersion: string,
  mathlibRevision: string,
  options: ProofSkeletonOptions = {},
): Promise<ProofSkeletonResult> {
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const depDecls = formatDependencyDeclarations(context.resolvedDependencies);

  if (!context.proofText) {
    return { steps: [], provedSources: [], totalUsage };
  }

  const segmented = await segmentProof(auxiliaryClient, {
    statementText: context.statementText,
    proofText: context.proofText,
    ...(context.ambientContext ? { ambientContext: context.ambientContext } : {}),
  });
  totalUsage.inputTokens += segmented.usage.inputTokens;
  totalUsage.outputTokens += segmented.usage.outputTokens;
  options.onProgress?.(`Author's proof split into ${segmented.steps.length} steps`, {
    stepCount: segmented.steps.length,
  });

  const results: InternalStepResult[] = [];
  // Only steps that checked out are offered as context: a step stated wrongly
  // would otherwise propagate its encoding into everything that follows.
  const established: string[] = [];
  // Proved steps become usable lemmas for the steps after them, which is what
  // makes the chain an argument rather than a list of isolated facts.
  const proved: string[] = [];

  for (const [index, spec] of segmented.steps.entries()) {
    const result = await checkStep(
      formalizerClient,
      runner,
      { frozenStatement, depDecls, leanVersion, mathlibRevision },
      context,
      spec,
      index + 1,
      established,
      options,
    );

    if (result.status === 'checked' && result.leanSource && result.theoremName) {
      options.onProgress?.(`Step ${result.idx}: proving`, { idx: result.idx });
      const available = [depDecls, ...proved].filter(Boolean).join('\n\n');
      const proof = await proveStepObligation(
        proposerClient,
        runner,
        result.leanSource,
        result.theoremName,
        spec,
        available,
      );
      result.proof = {
        status: proof.status,
        closedBy: proof.closedBy,
        leanSource: proof.leanSource,
        diagnostics: proof.diagnostics,
      };
      result.usageInput += proof.usage.inputTokens;
      result.usageOutput += proof.usage.outputTokens;
      if (proof.status === 'proved' && proof.leanSource) proved.push(proof.leanSource);
    }

    results.push(result);
    totalUsage.inputTokens += result.usageInput;
    totalUsage.outputTokens += result.usageOutput;
    if (result.status === 'checked' && result.leanSource) established.push(result.leanSource);
  }

  return { steps: results.map(stripUsage), provedSources: proved, totalUsage };
}

interface StepEnvironment {
  frozenStatement: string;
  depDecls: string;
  leanVersion: string;
  mathlibRevision: string;
}

type InternalStepResult = ProofStepResult & { usageInput: number; usageOutput: number };

function stripUsage(result: InternalStepResult): ProofStepResult {
  const { usageInput: _in, usageOutput: _out, ...rest } = result;
  return rest;
}

async function checkStep(
  formalizerClient: ModelClient,
  runner: LeanRunner,
  env: StepEnvironment,
  context: NormalizedClaimContext,
  spec: ProofStepSpec,
  idx: number,
  established: string[],
  options: ProofSkeletonOptions,
): Promise<InternalStepResult> {
  const base: InternalStepResult = {
    idx,
    claim: spec.claim,
    sourceText: spec.sourceText,
    uses: spec.uses,
    leanSource: null,
    theoremName: null,
    status: 'blocked',
    diagnostics: [],
    proof: { status: 'skipped', closedBy: null, leanSource: null, diagnostics: [] },
    usageInput: 0,
    usageOutput: 0,
  };

  let previousError: string | undefined;

  for (let attempt = 0; attempt < MAX_STEP_ATTEMPTS; attempt++) {
    options.onProgress?.(`Step ${idx}: stating in Lean (attempt ${attempt + 1})`, { idx, attempt });

    let formalized: { leanSource: string; theoremName: string; usage: TokenUsage };
    try {
      formalized = await formalizeProofStep(formalizerClient, {
        frozenStatement: env.frozenStatement,
        stepClaim: spec.claim,
        stepSourceText: spec.sourceText,
        priorSteps: established.join('\n\n'),
        dependencyDeclarations: env.depDecls,
        leanVersion: env.leanVersion,
        mathlibRevision: env.mathlibRevision,
        ...(context.ambientContext ? { ambientContext: context.ambientContext } : {}),
        ...(previousError !== undefined ? { previousError } : {}),
        ...(options.mathlibImportHints?.length ? { mathlibImportHints: options.mathlibImportHints } : {}),
      });
    } catch (err) {
      rethrowIfNotAboutTheProof(err);
      base.diagnostics = [`Step formalization failed: ${String(err)}`];
      previousError = String(err);
      continue;
    }

    base.usageInput += formalized.usage.inputTokens;
    base.usageOutput += formalized.usage.outputTokens;
    base.leanSource = formalized.leanSource;
    base.theoremName = formalized.theoremName;

    try {
      parseObligation(formalized.leanSource, formalized.theoremName);
    } catch (err) {
      base.status = 'failed';
      base.diagnostics = [`Step is not a single closed proposition: ${String(err)}`];
      previousError = `Previous step source:\n${formalized.leanSource}\nProblem:\n${String(err)}`;
      continue;
    }

    const leanResult = await runner.check(
      composeLeanFile(env.depDecls, formalized.leanSource),
      { allowTrustViolations: ['sorry'], declarationName: formalized.theoremName },
    );

    if (leanResult.status === 'ok') {
      base.status = 'checked';
      base.diagnostics = [];
      return base;
    }

    if (leanResult.status === 'blocked') {
      base.status = 'blocked';
      base.diagnostics = leanResult.diagnostics.map((d) => d.message);
      return base;
    }

    base.status = 'failed';
    base.diagnostics = leanResult.diagnostics.map((d) => d.message);
    previousError = `Previous step source:\n${formalized.leanSource}\nDiagnostics:\n${base.diagnostics.join('\n')}`;
  }

  return base;
}


/**
 * Proves one step's obligation. Earlier proved steps arrive in `available`, so a
 * step may lean on what the author established before it — the same courtesy a
 * reader extends to a proof read in order.
 */
async function proveStepObligation(
  proposerClient: ModelClient,
  runner: LeanRunner,
  stepSource: string,
  theoremName: string,
  spec: ProofStepSpec,
  available: string,
): Promise<ProofStepProof & { usage: TokenUsage }> {
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  const ladder = await tryTacticLadder(runner, stepSource, theoremName, available);
  if (ladder) {
    return { status: 'proved', closedBy: ladder.closedBy, leanSource: ladder.leanSource, diagnostics: [], usage };
  }

  let previousError: string | undefined;
  let diagnostics: string[] = ['No tactic in the ladder closed the goal'];

  for (let attempt = 0; attempt < MAX_STEP_PROOF_ATTEMPTS; attempt++) {
    let proofBody: string;
    try {
      const generated = await proposeProof(
        proposerClient,
        stepSource,
        `${spec.claim}\n\n${spec.sourceText}`,
        available,
        previousError,
      );
      usage.inputTokens += generated.usage.inputTokens;
      usage.outputTokens += generated.usage.outputTokens;
      proofBody = generated.proofBody;
    } catch (err) {
      rethrowIfNotAboutTheProof(err);
      diagnostics = [`Step proposer model error: ${String(err)}`];
      break;
    }

    let candidate: string;
    try {
      candidate = fillObligation(stepSource, proofBody, theoremName);
    } catch (err) {
      diagnostics = [`Proof body did not fit the step obligation: ${String(err)}`];
      previousError = diagnostics[0];
      continue;
    }

    const result = await runner.check(composeLeanFile(available, candidate), { declarationName: theoremName });
    if (result.status === 'ok' && result.certificate) {
      return { status: 'proved', closedBy: 'model', leanSource: candidate, diagnostics: [], usage };
    }

    diagnostics = result.diagnostics.map((d) => d.message);
    previousError = `Previous proof attempt:\n${proofBody}\nDiagnostics:\n${diagnostics.join('\n')}`;
  }

  return { status: 'unproved', closedBy: null, leanSource: null, diagnostics, usage };
}

import {
  BudgetExceededError,
  backtranslate,
  compareFaithfulness,
  formalizeProofStep,
  formalizeStatement,
  proposeProof,
  segmentProof,
  type CitedResultSpec,
  type ModelClient,
  type ProofStepSpec,
  type TokenPricing,
  type TokenUsage,
} from '@lale/translator';
import { LeanRunner, fillObligation, parseObligation } from '@lale/lean-runner';
import { tryTacticLadder } from './tactics.js';
import { composeLeanFile } from './formalize.js';
import { formatDependencyDeclarations, type NormalizedClaimContext } from './context.js';
import {
  DEFAULT_COMPOSITION_MAX_LINES,
  runAgentProver,
  type AgentBudget,
  type AgentEvent,
  type AgentProverResult,
  type AgentPurpose,
  type NamedFact,
} from './agent/prover.js';
import type { FrozenTheorem } from './agent/workspace.js';

// ---------------------------------------------------------------------------
// Proof skeleton: checking the author's argument
//
// The proposer stage answers "is this theorem true"; this stage answers "does
// this argument hold together", which is the question lale exists for. A
// model left free to prove a theorem will often find its own route — on
// research mathematics, usually a different one — and a pass then says nothing
// about the proof on the page. So the author's argument is fixed first and
// proved second:
//
//   1. The proof is split into the steps it argues, and the results it cites
//      without proving are listed separately.
//   2. Each cited result is stated in Lean as a `Prop` definition — a premise,
//      never an axiom — and screened: does it say what the author cited, can
//      Lean refute it outright (a false premise makes everything after it
//      vacuous), and is it simply provable from Mathlib, in which case it is
//      discharged rather than assumed.
//   3. Each step is stated in Lean, with the cited results it invokes as
//      hypotheses, and frozen. Its statement is back-translated and compared
//      with the author's step. Then it is proved: Lean's tactic ladder first,
//      then the agent, which may fill in detail but cannot move the step.
//   4. The theorem is composed from the steps by a short proof with no helper
//      files. A step chain that needs a long argument to reach the theorem has
//      a gap at the end, and that is reported as one.
//
// A pass with assumed citations is a pass *given those citations*, and the
// outcome says so; it is not a pass of the theorem.
// ---------------------------------------------------------------------------

export type ProofStepStatus = 'checked' | 'failed' | 'blocked';

export interface ProofStepProof {
  status: 'proved' | 'unproved' | 'skipped';
  /** The tactic that closed it, `model` for a one-shot proof, `agent` for the agent, else null. */
  closedBy: string | null;
  leanSource: string | null;
  diagnostics: string[];
  /** The agent's account when it could not prove the step: often the gap itself. */
  report?: string | null;
  spentUsd?: number;
  turns?: number;
}

export interface ProofStepResult {
  idx: number;
  claim: string;
  sourceText: string;
  uses: number[];
  /** Citation indices (1-based) this step invokes. */
  cites: number[];
  leanSource: string | null;
  theoremName: string | null;
  status: ProofStepStatus;
  diagnostics: string[];
  /** Back-translation of the Lean step, for the author to compare with their own. */
  backtranslation?: string | null;
  proof: ProofStepProof;
}

export type CitationStatus =
  /** Stated faithfully, not refuted, and not provable cheaply: a premise of the result. */
  | 'assumed'
  /** Proved from Mathlib, so the result does not depend on it. */
  | 'discharged'
  /** Stated, but unfaithful or refuted by Lean; steps citing it cannot be checked. */
  | 'rejected'
  /** Could not be stated in Lean at all. */
  | 'unstated';

export interface CitationResult {
  idx: number;
  name: string;
  statement: string;
  sourceText: string;
  /** `laleCite<idx>`, the `Prop` definition steps take as a hypothesis. */
  leanName: string;
  /** The definition, or for a discharged citation the definition plus its proof. */
  leanSource: string | null;
  status: CitationStatus;
  reason: string;
  backtranslation: string | null;
}

export interface CompositionResult {
  status: 'proved' | 'unproved' | 'skipped';
  /** Lean names of the citations the composed theorem is conditional on. */
  conditionalOn: string[];
  /** The obligation that was proved: the frozen theorem, or `cites → theorem`. */
  obligation: string | null;
  /** Everything needed to recheck it: step proofs, citation prelude, composition. */
  leanSource: string | null;
  closedBy: string | null;
  diagnostics: string[];
  report: string | null;
}

export interface ProofSkeletonResult {
  steps: ProofStepResult[];
  citations: CitationResult[];
  composition: CompositionResult;
  /** Lean sources of the steps that were proved, usable as lemmas downstream. */
  provedSources: string[];
  /** Harness-owned citation definitions every step and the composition elaborate after. */
  citationPrelude: string;
  totalUsage: TokenUsage;
  /** Dollars spent by agent runs; their tokens are also in `totalUsage`. */
  agentSpendUsd: number;
}

/** What the agent needs to run. Without it, steps get the one-shot proposer. */
export interface ProofSkeletonAgentConfig {
  client: ModelClient;
  pricing: TokenPricing;
  stepBudget?: AgentBudget;
  compositionBudget?: AgentBudget;
  /** Spend on trying to prove a cited result from Mathlib before assuming it. */
  citationBudget?: AgentBudget;
  mathlibRoot?: string | null;
  checkTimeoutMs?: number;
  maxTurnsPerStep?: number;
  signal?: AbortSignal;
  onEvent?: (scope: string, event: AgentEvent) => void;
}

export const DEFAULT_STEP_BUDGET: AgentBudget = { ceilingUsd: 2, floorUsd: 0.25 };
export const DEFAULT_COMPOSITION_BUDGET: AgentBudget = { ceilingUsd: 0.5, floorUsd: 0 };
export const DEFAULT_CITATION_BUDGET: AgentBudget = { ceilingUsd: 0.3, floorUsd: 0 };

export interface ProofSkeletonOptions {
  onProgress?: (message: string, payload?: Record<string, unknown>) => void;
  /** Valid Mathlib modules, so a step's imports get the same help a statement's do. */
  mathlibImportHints?: string[];
  agent?: ProofSkeletonAgentConfig;
}

/** The frozen theorem as the pipeline froze it; composition proves exactly this. */
export interface FrozenStatement {
  leanSource: string;
  theoremName: string;
  normalizedGoalTerm: string;
}

const MAX_STEP_PROOF_ATTEMPTS = 2;

// One repair attempt per step: enough to fix an elaboration slip, not enough to
// let the model search for a statement Lean will accept regardless of meaning.
const MAX_STEP_ATTEMPTS = 2;
const MAX_CITATION_ATTEMPTS = 2;

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

function addUsage(total: TokenUsage, usage: TokenUsage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
}

export function citationName(idx: number): string {
  return `laleCite${idx}`;
}

/**
 * Restates a frozen obligation with premises in front of its proposition:
 * `theorem n : P := by sorry` becomes `theorem n : A → B → (P) := by sorry`,
 * keeping its imports and opens. The premises are harness-chosen names.
 */
export function withPremises(source: string, theoremName: string, premises: string[], rename?: string): string {
  const obligation = parseObligation(source, theoremName);
  const proposition = premises.length
    ? `${premises.map((p) => `${p} → `).join('')}(${obligation.proposition})`
    : obligation.proposition;
  return `${obligation.preamble}theorem ${rename ?? theoremName} : ${proposition} := by sorry`;
}

/**
 * `def laleCiteN : Prop := (P)`, in its own section so the citation's opens
 * cannot leak into the files composed after it.
 */
function citationDefinition(source: string, theoremName: string, leanName: string): { imports: string[]; body: string } {
  const obligation = parseObligation(source, theoremName);
  const imports: string[] = [];
  const opens: string[] = [];
  for (const line of obligation.preamble.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (line.startsWith('import ')) imports.push(line);
    else opens.push(line);
  }
  return {
    imports,
    body: ['section', ...opens, `def ${leanName} : Prop := (${obligation.proposition})`, 'end'].join('\n'),
  };
}

export async function checkProofSkeleton(
  auxiliaryClient: ModelClient,
  formalizerClient: ModelClient,
  proposerClient: ModelClient,
  runner: LeanRunner,
  frozen: FrozenStatement,
  context: NormalizedClaimContext,
  leanVersion: string,
  mathlibRevision: string,
  options: ProofSkeletonOptions = {},
): Promise<ProofSkeletonResult> {
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let agentSpendUsd = 0;
  const depDecls = formatDependencyDeclarations(context.resolvedDependencies);
  const skipped: CompositionResult = {
    status: 'skipped', conditionalOn: [], obligation: null, leanSource: null, closedBy: null, diagnostics: [], report: null,
  };
  const empty = (): ProofSkeletonResult => ({
    steps: [], citations: [], composition: skipped, provedSources: [], citationPrelude: '', totalUsage, agentSpendUsd,
  });

  if (!context.proofText) return empty();

  const segmented = await segmentProof(auxiliaryClient, {
    statementText: context.statementText,
    proofText: context.proofText,
    ...(context.ambientContext ? { ambientContext: context.ambientContext } : {}),
  });
  addUsage(totalUsage, segmented.usage);
  options.onProgress?.(
    `Author's proof split into ${segmented.steps.length} steps`
    + (segmented.citations.length ? `, citing ${segmented.citations.length} result${segmented.citations.length === 1 ? '' : 's'}` : ''),
    { stepCount: segmented.steps.length, citationCount: segmented.citations.length },
  );

  const runAgent = async (scope: string, frozenTheorem: FrozenTheorem, deps: string, purpose: AgentPurpose,
    budget: AgentBudget, statementText?: string): Promise<AgentProverResult | null> => {
    const agent = options.agent;
    if (!agent) return null;
    const result = await runAgentProver({
      client: agent.client,
      runner,
      frozen: frozenTheorem,
      dependencyDeclarations: deps,
      purpose,
      pricing: agent.pricing,
      budget,
      ...(statementText ? { statementText } : {}),
      ...(context.ambientContext ? { ambientContext: context.ambientContext } : {}),
      proofText: purpose.kind === 'theorem' ? null : context.proofText,
      ...(agent.mathlibRoot !== undefined ? { mathlibRoot: agent.mathlibRoot } : {}),
      ...(agent.checkTimeoutMs !== undefined ? { checkTimeoutMs: agent.checkTimeoutMs } : {}),
      ...(agent.maxTurnsPerStep !== undefined ? { maxTurns: agent.maxTurnsPerStep } : {}),
      ...(agent.signal ? { signal: agent.signal } : {}),
      onEvent: (event) => agent.onEvent?.(scope, event),
    });
    addUsage(totalUsage, result.usage);
    agentSpendUsd += result.spentUsd;
    return result;
  };

  // ── Cited results ─────────────────────────────────────────────────────────
  const citations: CitationResult[] = [];
  for (const [index, spec] of segmented.citations.entries()) {
    const citation = await checkCitation(
      auxiliaryClient, formalizerClient, runner, spec, index + 1, depDecls, context, leanVersion, mathlibRevision, options,
      runAgent, totalUsage,
    );
    citations.push(citation);
    options.onProgress?.(`Cited result ${citation.idx} (${citation.name}): ${citation.status} — ${citation.reason}`, {
      citation: citation.idx, status: citation.status,
    });
  }
  // Rejected and unstated citations contribute nothing a step could use.
  const citationPrelude = citations
    .filter((c) => (c.status === 'assumed' || c.status === 'discharged') && c.leanSource)
    .map((c) => c.leanSource!)
    .join('\n\n');
  const stepEnvironment = [depDecls, citationPrelude].filter(Boolean).join('\n\n');

  // ── Steps ─────────────────────────────────────────────────────────────────
  const results: InternalStepResult[] = [];
  // Only steps that checked out are offered as context: a step stated wrongly
  // would otherwise propagate its encoding into everything that follows.
  const established: string[] = [];
  // Proved steps become usable lemmas for the steps after them, which is what
  // makes the chain an argument rather than a list of isolated facts.
  const proved: string[] = [];
  const provedFacts: NamedFact[] = [];

  for (const [index, spec] of segmented.steps.entries()) {
    const cited = spec.cites.map((i) => citations[i - 1]).filter((c): c is CitationResult => c !== undefined);
    const unusable = cited.filter((c) => c.status === 'rejected' || c.status === 'unstated');
    const premises = cited.filter((c) => c.status === 'assumed').map((c) => c.leanName);

    const result = await checkStep(
      auxiliaryClient, formalizerClient, runner,
      { frozenStatement: frozen.leanSource, depDecls: stepEnvironment, leanVersion, mathlibRevision },
      context, spec, index + 1, established, premises, options,
    );
    addUsage(totalUsage, { inputTokens: result.usageInput, outputTokens: result.usageOutput });

    if (unusable.length > 0 && result.status === 'checked') {
      result.proof = {
        status: 'skipped', closedBy: null, leanSource: null,
        diagnostics: unusable.map((c) => `Relies on cited result ${c.idx} (${c.name}), which is ${c.status}: ${c.reason}`),
      };
    } else if (result.status === 'checked' && result.leanSource && result.theoremName && result.normalizedGoalTerm) {
      options.onProgress?.(`Step ${result.idx}: proving`, { idx: result.idx });
      const available = [stepEnvironment, ...proved].filter(Boolean).join('\n\n');
      const proof = await proveStep(
        proposerClient, runner, result, spec, available, segmented.steps.length, provedFacts, cited, runAgent, options,
      );
      result.proof = proof.proof;
      addUsage(totalUsage, proof.usage);
      if (proof.proof.status === 'proved' && proof.proof.leanSource) {
        proved.push(proof.proof.leanSource);
        provedFacts.push({ leanName: result.theoremName, text: spec.claim });
      }
    }

    results.push(result);
    if (result.status === 'checked' && result.leanSource) established.push(result.leanSource);
  }

  // ── Composition ───────────────────────────────────────────────────────────
  const allProved = results.length > 0 && results.every((r) => r.status === 'checked' && r.proof.status === 'proved');
  let composition: CompositionResult = skipped;
  if (allProved && options.agent) {
    composition = await composeTheorem(
      runner, frozen, stepEnvironment, citationPrelude, proved, provedFacts, citations, context, runAgent, options,
    );
  }

  return {
    steps: results.map(stripInternal),
    citations,
    composition,
    provedSources: proved,
    citationPrelude,
    totalUsage,
    agentSpendUsd,
  };
}

type AgentRunner = (scope: string, frozen: FrozenTheorem, deps: string, purpose: AgentPurpose,
  budget: AgentBudget, statementText?: string) => Promise<AgentProverResult | null>;

interface StepEnvironment {
  frozenStatement: string;
  depDecls: string;
  leanVersion: string;
  mathlibRevision: string;
}

type InternalStepResult = ProofStepResult & { usageInput: number; usageOutput: number; normalizedGoalTerm: string | null };

function stripInternal(result: InternalStepResult): ProofStepResult {
  const { usageInput: _in, usageOutput: _out, normalizedGoalTerm: _goal, ...rest } = result;
  return rest;
}

async function checkCitation(
  auxiliaryClient: ModelClient,
  formalizerClient: ModelClient,
  runner: LeanRunner,
  spec: CitedResultSpec,
  idx: number,
  depDecls: string,
  context: NormalizedClaimContext,
  leanVersion: string,
  mathlibRevision: string,
  options: ProofSkeletonOptions,
  runAgent: AgentRunner,
  totalUsage: TokenUsage,
): Promise<CitationResult> {
  const leanName = citationName(idx);
  const result: CitationResult = {
    idx, name: spec.name, statement: spec.statement, sourceText: spec.sourceText, leanName,
    leanSource: null, status: 'unstated', reason: 'Could not be stated in Lean', backtranslation: null,
  };

  // The formalizer names the theorem; it is renamed to a harness name so two
  // citations, or a citation and a step, cannot collide.
  const stmtName = `${leanName}_stmt`;
  let header: { leanSource: string; normalizedGoalTerm: string } | null = null;
  let previousError: string | undefined;
  for (let attempt = 0; attempt < MAX_CITATION_ATTEMPTS && !header; attempt++) {
    try {
      const formalized = await formalizeStatement(formalizerClient, {
        statementText: spec.statement,
        ...(context.ambientContext ? { ambientContext: context.ambientContext } : {}),
        proofText: null,
        dependencyDeclarations: depDecls,
        leanVersion,
        mathlibRevision,
        ...(previousError !== undefined ? { previousError } : {}),
        ...(options.mathlibImportHints?.length ? { mathlibImportHints: options.mathlibImportHints } : {}),
      });
      addUsage(totalUsage, formalized.usage);
      const renamed = withPremises(formalized.leanSource, formalized.theoremName, [], stmtName);
      const check = await runner.check(composeLeanFile(depDecls, renamed), {
        allowTrustViolations: ['sorry'], declarationName: stmtName,
      });
      if (check.status === 'ok' && check.certificate) {
        header = { leanSource: renamed, normalizedGoalTerm: check.certificate.normalizedGoalTerm };
      } else {
        previousError = `Previous source:\n${formalized.leanSource}\nDiagnostics:\n${check.diagnostics.map((d) => d.message).join('\n')}`;
      }
    } catch (err) {
      rethrowIfNotAboutTheProof(err);
      previousError = String(err);
      result.reason = `Could not be stated in Lean: ${String(err)}`;
    }
  }
  if (!header) return result;

  // Does the Lean statement say what the author cited? A citation stated more
  // strongly than the literature would make every step that uses it unsound.
  try {
    const { nlStatement, usage } = await backtranslate(auxiliaryClient, header.leanSource);
    addUsage(totalUsage, usage);
    result.backtranslation = nlStatement;
    const comparison = await compareFaithfulness(auxiliaryClient, spec.statement, nlStatement, context.ambientContext);
    addUsage(totalUsage, comparison.usage);
    if (comparison.agreement === 'disagree') {
      return { ...result, status: 'rejected', reason: `Lean statement does not match the cited result: ${comparison.explanation}` };
    }
  } catch (err) {
    rethrowIfNotAboutTheProof(err);
    return { ...result, status: 'rejected', reason: `Faithfulness of the cited statement could not be checked: ${String(err)}` };
  }

  // A premise Lean can refute is false as stated, and a false premise proves
  // anything. Cheap to rule out the easy cases; the hard ones are why the
  // citation is reported to the author rather than trusted silently.
  const refutationName = `${leanName}_refuted`;
  const refuted = await tryTacticLadder(runner, negatedObligation(header.leanSource, stmtName, refutationName), refutationName, depDecls);
  if (refuted) {
    return { ...result, status: 'rejected', reason: `Lean refutes it as stated (closed by ${refuted.closedBy}); the formalization is false, so it cannot be assumed` };
  }

  const definition = citationDefinition(header.leanSource, stmtName, leanName);
  const definitionSource = [...definition.imports, definition.body].join('\n');
  const defCheck = await runner.check(composeLeanFile(depDecls, definitionSource));
  if (defCheck.status !== 'ok') {
    return { ...result, status: 'unstated', reason: `Definition did not elaborate: ${defCheck.diagnostics.map((d) => d.message).join('; ').slice(0, 400)}` };
  }

  // Provable from Mathlib? Then it is a lemma, not an assumption: the source
  // carries the statement's proof and a bridge to the definition.
  const bridge = `theorem ${leanName}_holds : ${leanName} := by\n  unfold ${leanName}\n  exact ${stmtName}`;
  const discharged = (proofSource: string, by: string): CitationResult => ({
    ...result, status: 'discharged', reason: `Proved from Mathlib (${by})`,
    leanSource: [definitionSource, proofSource, bridge].join('\n\n'),
  });
  const ladder = await tryTacticLadder(runner, header.leanSource, stmtName, depDecls);
  if (ladder) return discharged(ladder.leanSource, ladder.closedBy);

  let agentResult: AgentProverResult | null = null;
  try {
    agentResult = await runAgent(
      `citation ${idx}`,
      { leanSource: header.leanSource, theoremName: stmtName, normalizedGoalTerm: header.normalizedGoalTerm },
      depDecls, { kind: 'theorem' }, options.agent?.citationBudget ?? DEFAULT_CITATION_BUDGET, spec.statement,
    );
  } catch (err) {
    rethrowIfNotAboutTheProof(err);
  }
  if (agentResult?.outcome === 'verified' && agentResult.acceptedLeanSource) {
    const candidate = [definitionSource, agentResult.acceptedLeanSource, bridge].join('\n\n');
    const recheck = await runner.check(composeLeanFile(depDecls, candidate), { declarationName: `${leanName}_holds` });
    if (recheck.status === 'ok' && recheck.certificate) return discharged(agentResult.acceptedLeanSource, 'agent');
  }

  return { ...result, status: 'assumed', reason: 'Stated faithfully and not refuted; not proved here', leanSource: definitionSource };
}

function negatedObligation(source: string, theoremName: string, name: string): string {
  const obligation = parseObligation(source, theoremName);
  return `${obligation.preamble}theorem ${name} : ¬ (${obligation.proposition}) := by sorry`;
}

async function checkStep(
  auxiliaryClient: ModelClient,
  formalizerClient: ModelClient,
  runner: LeanRunner,
  env: StepEnvironment,
  context: NormalizedClaimContext,
  spec: ProofStepSpec,
  idx: number,
  established: string[],
  premises: string[],
  options: ProofSkeletonOptions,
): Promise<InternalStepResult> {
  const base: InternalStepResult = {
    idx,
    claim: spec.claim,
    sourceText: spec.sourceText,
    uses: spec.uses,
    cites: spec.cites,
    leanSource: null,
    theoremName: null,
    status: 'blocked',
    diagnostics: [],
    proof: { status: 'skipped', closedBy: null, leanSource: null, diagnostics: [] },
    usageInput: 0,
    usageOutput: 0,
    normalizedGoalTerm: null,
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

    let stepSource: string;
    try {
      parseObligation(formalized.leanSource, formalized.theoremName);
      // Cited results the step invokes become its hypotheses: the step is
      // checked *given* them, exactly as the author argues it.
      stepSource = premises.length ? withPremises(formalized.leanSource, formalized.theoremName, premises) : formalized.leanSource;
    } catch (err) {
      base.leanSource = formalized.leanSource;
      base.theoremName = formalized.theoremName;
      base.status = 'failed';
      base.diagnostics = [`Step is not a single closed proposition: ${String(err)}`];
      previousError = `Previous step source:\n${formalized.leanSource}\nProblem:\n${String(err)}`;
      continue;
    }
    base.leanSource = stepSource;
    base.theoremName = formalized.theoremName;

    const leanResult = await runner.check(
      composeLeanFile(env.depDecls, stepSource),
      { allowTrustViolations: ['sorry'], declarationName: formalized.theoremName },
    );

    if (leanResult.status === 'blocked') {
      base.status = 'blocked';
      base.diagnostics = leanResult.diagnostics.map((d) => d.message);
      return base;
    }
    if (leanResult.status !== 'ok' || !leanResult.certificate) {
      base.status = 'failed';
      base.diagnostics = leanResult.diagnostics.map((d) => d.message);
      previousError = `Previous step source:\n${formalized.leanSource}\nDiagnostics:\n${base.diagnostics.join('\n')}`;
      continue;
    }

    // A step that elaborates can still be the wrong step: trivially weaker,
    // about other objects, or the whole theorem again. The prover would then
    // check something the author did not argue.
    try {
      const { nlStatement, usage } = await backtranslate(auxiliaryClient, formalized.leanSource);
      base.usageInput += usage.inputTokens;
      base.usageOutput += usage.outputTokens;
      base.backtranslation = nlStatement;
      const comparison = await compareFaithfulness(auxiliaryClient, spec.claim, nlStatement, context.ambientContext);
      base.usageInput += comparison.usage.inputTokens;
      base.usageOutput += comparison.usage.outputTokens;
      if (comparison.agreement === 'disagree') {
        base.status = 'failed';
        base.diagnostics = [`Lean statement does not match the author's step: ${comparison.explanation}`];
        previousError = `Previous step source:\n${formalized.leanSource}\nIt reads back as: ${nlStatement}\nwhich does not match the step: ${comparison.explanation}`;
        continue;
      }
    } catch (err) {
      rethrowIfNotAboutTheProof(err);
      // An advisory check that could not run does not fail the step.
    }

    base.status = 'checked';
    base.diagnostics = [];
    base.normalizedGoalTerm = leanResult.certificate.normalizedGoalTerm;
    return base;
  }

  return base;
}

async function proveStep(
  proposerClient: ModelClient,
  runner: LeanRunner,
  step: InternalStepResult,
  spec: ProofStepSpec,
  available: string,
  totalSteps: number,
  earlierSteps: NamedFact[],
  cited: CitationResult[],
  runAgent: AgentRunner,
  options: ProofSkeletonOptions,
): Promise<{ proof: ProofStepProof; usage: TokenUsage }> {
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const stepSource = step.leanSource!;
  const theoremName = step.theoremName!;

  const ladder = await tryTacticLadder(runner, stepSource, theoremName, available);
  if (ladder) {
    return { proof: { status: 'proved', closedBy: ladder.closedBy, leanSource: ladder.leanSource, diagnostics: [] }, usage };
  }

  if (options.agent) {
    let result: AgentProverResult | null;
    try {
      result = await runAgent(
        `step ${step.idx}`,
        { leanSource: stepSource, theoremName, normalizedGoalTerm: step.normalizedGoalTerm! },
        available,
        {
          kind: 'authorStep', index: step.idx, total: totalSteps, claim: spec.claim, sourceText: spec.sourceText,
          earlierSteps,
          citations: cited.map((c) => ({
            leanName: c.status === 'discharged' ? `${c.leanName}_holds` : c.leanName,
            text: `${c.name}: ${c.statement}${c.status === 'discharged' ? ' (proved from Mathlib; use the lemma)' : ''}`,
          })),
        },
        options.agent.stepBudget ?? DEFAULT_STEP_BUDGET,
        spec.claim,
      );
    } catch (err) {
      rethrowIfNotAboutTheProof(err);
      return { proof: { status: 'unproved', closedBy: null, leanSource: null, diagnostics: [`Agent error: ${String(err)}`] }, usage };
    }
    if (result) {
      const common = { spentUsd: result.spentUsd, turns: result.turns };
      if (result.outcome === 'verified' && result.acceptedLeanSource) {
        return { proof: { status: 'proved', closedBy: 'agent', leanSource: result.acceptedLeanSource, diagnostics: [], report: null, ...common }, usage };
      }
      return {
        proof: {
          status: 'unproved', closedBy: null, leanSource: null,
          diagnostics: [`Agent stopped (${result.stopReason}) after ${result.turns} turns, $${result.spentUsd.toFixed(2)}`],
          report: result.report, ...common,
        },
        usage,
      };
    }
  }

  return proveStepOneShot(proposerClient, runner, stepSource, theoremName, spec, available, usage);
}

/** The pre-agent path, kept for runs without prices (local providers, tests). */
async function proveStepOneShot(
  proposerClient: ModelClient,
  runner: LeanRunner,
  stepSource: string,
  theoremName: string,
  spec: ProofStepSpec,
  available: string,
  usage: TokenUsage,
): Promise<{ proof: ProofStepProof; usage: TokenUsage }> {
  let previousError: string | undefined;
  let diagnostics: string[] = ['No tactic in the ladder closed the goal'];

  for (let attempt = 0; attempt < MAX_STEP_PROOF_ATTEMPTS; attempt++) {
    let proofBody: string;
    try {
      const generated = await proposeProof(proposerClient, stepSource, `${spec.claim}\n\n${spec.sourceText}`, available, previousError);
      addUsage(usage, generated.usage);
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
      return { proof: { status: 'proved', closedBy: 'model', leanSource: candidate, diagnostics: [] }, usage };
    }

    diagnostics = result.diagnostics.map((d) => d.message);
    previousError = `Previous proof attempt:\n${proofBody}\nDiagnostics:\n${diagnostics.join('\n')}`;
  }

  return { proof: { status: 'unproved', closedBy: null, leanSource: null, diagnostics }, usage };
}

/** Tactics that compose a theorem from its last step; tried before any model call. */
function compositionTactics(stepNames: string[]): string[] {
  const last = stepNames.at(-1)!;
  return [
    `exact ${last}`,
    `intros; exact ${last} ‹_›`,
    `simpa using ${last}`,
    `intros; apply ${last} <;> assumption`,
    `exact fun h => ${last} h`,
  ];
}

async function composeTheorem(
  runner: LeanRunner,
  frozen: FrozenStatement,
  stepEnvironment: string,
  citationPrelude: string,
  provedSources: string[],
  steps: NamedFact[],
  citations: CitationResult[],
  context: NormalizedClaimContext,
  runAgent: AgentRunner,
  options: ProofSkeletonOptions,
): Promise<CompositionResult> {
  const assumed = citations.filter((c) => c.status === 'assumed').map((c) => c.leanName);
  const available = [stepEnvironment, ...provedSources].filter(Boolean).join('\n\n');
  const result: CompositionResult = {
    status: 'unproved', conditionalOn: assumed, obligation: null, leanSource: null, closedBy: null, diagnostics: [], report: null,
  };

  // With no assumptions the target is the frozen theorem itself, so a pass is
  // a proof of the claim. With assumptions it is `cites → theorem`, which is
  // all the author's argument establishes.
  let target: FrozenTheorem;
  if (assumed.length === 0) {
    target = { leanSource: frozen.leanSource, theoremName: frozen.theoremName, normalizedGoalTerm: frozen.normalizedGoalTerm };
  } else {
    const name = `${frozen.theoremName}_givenCitations`;
    const source = withPremises(frozen.leanSource, frozen.theoremName, assumed, name);
    const check = await runner.check(composeLeanFile(available, source), { allowTrustViolations: ['sorry'], declarationName: name });
    if (check.status !== 'ok' || !check.certificate) {
      return { ...result, diagnostics: ['The conditional theorem did not elaborate', ...check.diagnostics.map((d) => d.message)] };
    }
    target = { leanSource: source, theoremName: name, normalizedGoalTerm: check.certificate.normalizedGoalTerm };
  }
  result.obligation = target.leanSource;
  options.onProgress?.('Composing the theorem from the proved steps', { conditionalOn: assumed });

  for (const tactic of compositionTactics(steps.map((s) => s.leanName))) {
    const candidate = fillObligation(target.leanSource, tactic, target.theoremName);
    const check = await runner.check(composeLeanFile(available, candidate), { declarationName: target.theoremName });
    if (check.status === 'ok' && check.certificate?.normalizedGoalTerm === target.normalizedGoalTerm) {
      return { ...result, status: 'proved', closedBy: tactic, leanSource: assemble(citationPrelude, provedSources, candidate) };
    }
  }

  let agentResult: AgentProverResult | null;
  try {
    agentResult = await runAgent(
      'composition', target, available,
      {
        kind: 'composition', steps,
        citations: citations.filter((c) => c.status === 'assumed' || c.status === 'discharged').map((c) => ({
          leanName: c.status === 'discharged' ? `${c.leanName}_holds` : c.leanName, text: `${c.name}: ${c.statement}`,
        })),
        maxProofLines: DEFAULT_COMPOSITION_MAX_LINES,
      },
      options.agent?.compositionBudget ?? DEFAULT_COMPOSITION_BUDGET,
      context.statementText,
    );
  } catch (err) {
    rethrowIfNotAboutTheProof(err);
    return { ...result, diagnostics: [`Agent error: ${String(err)}`] };
  }
  if (agentResult?.outcome === 'verified' && agentResult.acceptedLeanSource) {
    return { ...result, status: 'proved', closedBy: 'agent', leanSource: assemble(citationPrelude, provedSources, agentResult.acceptedLeanSource) };
  }
  return {
    ...result,
    diagnostics: agentResult ? [`Composition agent stopped (${agentResult.stopReason})`] : ['No composition tactic closed the goal'],
    report: agentResult?.report ?? null,
  };
}

/**
 * One self-contained source for the final recheck: citation prelude, step
 * proofs, composition. The claim's own dependencies are left out — the caller
 * composes them in, as it does for any accepted proof.
 */
function assemble(citationPrelude: string, provedSources: string[], composition: string): string {
  return [citationPrelude, ...provedSources, composition].filter(Boolean).join('\n\n');
}

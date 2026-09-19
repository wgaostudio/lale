import type { ModelClient, TokenUsage } from '@lale/translator';
import {
  formalizeDefinition as translatorFormalizeDefinition,
  formalizeStatement as translatorFormalize,
} from '@lale/translator';
import type { LeanRunner, LeanCheckOptions, LeanCheckResult } from '@lale/lean-runner';
import { parseObligation, fillObligation } from '@lale/lean-runner';
import type { NormalizedClaimContext } from './context.js';
import { formatDependencyDeclarations } from './context.js';
import type { MathlibImportIndex, MathlibImportValidation } from './mathlib-index.js';
import {
  extractLeanImports,
  MAX_IMPORT_HINTS,
  parseImportLine,
  replaceInvalidMathlibImports,
} from './mathlib-index.js';
import { withHeartbeat } from './heartbeat.js';
import { sha256 } from './hash.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StatementAttempt {
  attemptIndex: number;
  status: 'ok' | 'error' | 'blocked' | 'timeout';
  leanSource: string;
  diagnostics: string[];
  leanResult: LeanCheckResult | null;
}

export interface FormalizeResult {
  ok: true;
  artifactKind: 'theorem' | 'definition';
  theoremName: string;
  leanSource: string;
  termMap: Record<string, string>;
  sourceHash: string;
  normalizedGoalTerm: string;
  attempts: StatementAttempt[];
  totalUsage: TokenUsage;
}

export interface FormalizeFailure {
  ok: false;
  outcome: 'malformedClaim' | 'verificationBlocked';
  attempts: StatementAttempt[];
  totalUsage: TokenUsage;
}

export type FormalizeCheckResult = FormalizeResult | FormalizeFailure;

export interface FormalizeCheckOptions {
  onAttempt?: (attempt: StatementAttempt) => void;
  onProgress?: (event: FormalizeProgressEvent) => void;
  mathlibImportIndex?: MathlibImportIndex | null;
}

export interface FormalizeProgressEvent {
  attemptIndex: number;
  stage: 'modelRequest' | 'modelResponse' | 'importRepair' | 'leanCheck';
  message: string;
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Formalize a document item and verify it type-checks (§3.7)
//
// Theorems and definitions run the same loop — ask the model, repair its
// imports, ask Lean, feed the diagnostic back — and differ in only three
// places: which translator call makes the request, what shape of Lean source is
// acceptable back, and whether `sorry` may appear in it. Those three are the
// `ArtifactSpec` below, so the loop itself is written once.
// ---------------------------------------------------------------------------

const MAX_FORMALIZE_RETRIES = 3;

/** The model's answer, normalized across the two translator calls. */
interface FormalizationDraft {
  leanSource: string;
  declarationName: string;
  termMap: Record<string, string>;
  usage: TokenUsage;
}

interface ArtifactSpec {
  artifactKind: FormalizeResult['artifactKind'];
  /** Names the artifact in progress messages and diagnostics. */
  label: 'Statement' | 'Definition';
  /** What the `leanCheck` progress event says it is about to check. */
  checkingMessage: string;
  request(
    previousError: string | undefined,
    mathlibImportHints: string[],
  ): Promise<FormalizationDraft>;
  /**
   * Normalizes the model's source into what Lean is asked to check, and throws
   * if the draft has a shape this kind of artifact does not permit.
   */
  prepare(draft: FormalizationDraft): string;
  checkOptions(declarationName: string): LeanCheckOptions;
}

export function formalizeAndCheck(
  formalizerClient: ModelClient,
  runner: LeanRunner,
  context: NormalizedClaimContext,
  leanVersion: string,
  mathlibRevision: string,
  options: FormalizeCheckOptions = {},
): Promise<FormalizeCheckResult> {
  const dependencyDeclarations = formatDependencyDeclarations(context.resolvedDependencies);

  return runFormalizeLoop(runner, dependencyDeclarations, options, {
    artifactKind: 'theorem',
    label: 'Statement',
    checkingMessage: 'checking Lean header',
    async request(previousError, mathlibImportHints) {
      const result = await translatorFormalize(formalizerClient, {
        statementText: context.statementText,
        ambientContext: context.ambientContext,
        proofText: context.proofText,
        dependencyDeclarations,
        leanVersion,
        mathlibRevision,
        ...(previousError !== undefined ? { previousError } : {}),
        ...(mathlibImportHints.length > 0 ? { mathlibImportHints } : {}),
      });
      return { ...result, declarationName: result.theoremName };
    },
    prepare(draft) {
      // A statement is an obligation, not a proof: it has to arrive with
      // exactly `:= by sorry`, so the header can be frozen before the proposer
      // is allowed to fill it.
      const obligation = parseObligation(draft.leanSource, draft.declarationName);
      if (obligation.proofBody !== 'sorry') {
        throw new Error('Statement must end with exactly := by sorry');
      }
      return fillObligation(draft.leanSource, 'sorry', draft.declarationName);
    },
    checkOptions: (declarationName) => ({ allowTrustViolations: ['sorry'], declarationName }),
  });
}

/**
 * Definitions are dependency context rather than obligations, so the accepted
 * Lean has to be a real declaration: it is taken as the model wrote it, and
 * `checkOptions` allows no `sorry` or axiom to hide inside it.
 */
export function formalizeDefinitionAndCheck(
  formalizerClient: ModelClient,
  runner: LeanRunner,
  context: NormalizedClaimContext,
  leanVersion: string,
  mathlibRevision: string,
  options: FormalizeCheckOptions = {},
): Promise<FormalizeCheckResult> {
  const dependencyDeclarations = formatDependencyDeclarations(context.resolvedDependencies);

  return runFormalizeLoop(runner, dependencyDeclarations, options, {
    artifactKind: 'definition',
    label: 'Definition',
    checkingMessage: 'checking Lean declaration',
    async request(previousError, mathlibImportHints) {
      return translatorFormalizeDefinition(formalizerClient, {
        definitionText: context.statementText,
        ambientContext: context.ambientContext,
        dependencyDeclarations,
        leanVersion,
        mathlibRevision,
        ...(previousError !== undefined ? { previousError } : {}),
        ...(mathlibImportHints.length > 0 ? { mathlibImportHints } : {}),
      });
    },
    prepare: (draft) => draft.leanSource,
    checkOptions: (declarationName) => ({ declarationName }),
  });
}

async function runFormalizeLoop(
  runner: LeanRunner,
  dependencyDeclarations: string,
  options: FormalizeCheckOptions,
  spec: ArtifactSpec,
): Promise<FormalizeCheckResult> {
  const attempts: StatementAttempt[] = [];
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let previousError: string | undefined;
  let mathlibImportHints: string[] = [];
  let transientRetries = 0;

  const recordAttempt = (attempt: StatementAttempt): void => {
    attempts.push(attempt);
    options.onAttempt?.(attempt);
  };

  const progress = (
    attemptIndex: number,
    stage: FormalizeProgressEvent['stage'],
    message: string,
    payload?: Record<string, unknown>,
  ): void => {
    options.onProgress?.({
      attemptIndex,
      stage,
      message: `${spec.label} formalization attempt ${attemptIndex + 1}: ${message}`,
      ...(payload !== undefined ? { payload } : {}),
    });
  };

  const blocked = (): FormalizeFailure => formalizeFailure('verificationBlocked', attempts, totalUsage);

  for (let i = 0; i < MAX_FORMALIZE_RETRIES; i++) {
    let draft: FormalizationDraft;
    try {
      progress(i, 'modelRequest', 'requesting model output');
      draft = await withHeartbeat(
        () => spec.request(previousError, mathlibImportHints),
        (elapsedMs) =>
          progress(
            i,
            'modelRequest',
            `still waiting for model output (${Math.round(elapsedMs / 1000)}s)`,
            { elapsedMs },
          ),
      );
      progress(i, 'modelResponse', 'model output received');
    } catch (err) {
      previousError = String(err);
      const credits = isCreditsError(err);
      recordAttempt({
        attemptIndex: i,
        status: 'error',
        leanSource: '',
        diagnostics: [
          credits
            ? creditsExhaustedDiagnostic(err)
            : `${spec.label} formalization model error: ${String(err)}`,
        ],
        leanResult: null,
      });

      // Ordered most specific reading first. A dropped socket arrives wrapped
      // in a generic "fetch failed", which the infrastructure case also
      // matches, and whichever is tested first decides the error's fate.
      if (credits || isTimeoutError(err)) return blocked();
      if (isTransientConnectionError(err)) {
        if (transientRetries >= 1) return blocked();
        transientRetries++;
        progress(
          i,
          'modelRequest',
          `connection dropped — waiting ${TRANSIENT_RETRY_DELAY_MS / 1000}s for the interrupted request to settle`,
        );
        await delay(TRANSIENT_RETRY_DELAY_MS);
        continue;
      }
      if (isProviderInfrastructureError(err)) return blocked();
      continue;
    }

    totalUsage.inputTokens += draft.usage.inputTokens;
    totalUsage.outputTokens += draft.usage.outputTokens;

    let leanSource: string;
    try {
      leanSource = spec.prepare(draft);
    } catch (error) {
      previousError = String(error);
      recordAttempt({
        attemptIndex: i,
        status: 'error',
        leanSource: draft.leanSource,
        diagnostics: [previousError],
        leanResult: null,
      });
      continue;
    }

    const importPreflight = preflightMathlibImports(leanSource, options.mathlibImportIndex);
    if (importPreflight.action === 'blocked') {
      recordAttempt({
        attemptIndex: i,
        status: 'error',
        leanSource,
        diagnostics: importPreflight.diagnostics,
        leanResult: null,
      });
      return blocked();
    }

    leanSource = importPreflight.leanSource;
    if (importPreflight.hints.length > 0) {
      mathlibImportHints = importPreflight.hints;
      progress(i, 'importRepair', 'repaired invalid Mathlib imports', {
        diagnostics: importPreflight.diagnostics,
        importHints: importPreflight.hints,
      });
    }

    progress(i, 'leanCheck', spec.checkingMessage);
    const leanResult = await runner.check(
      composeLeanFile(dependencyDeclarations, leanSource),
      spec.checkOptions(draft.declarationName),
    );

    // A trust violation or an exhausted clock. Neither is something the model
    // can be asked to repair, so the run stops instead of paying again.
    if (leanResult.status === 'blocked' || leanResult.status === 'timeout') {
      recordAttempt({
        attemptIndex: i,
        status: leanResult.status,
        leanSource,
        diagnostics: describeLeanResult(leanResult),
        leanResult,
      });
      return blocked();
    }

    if (leanResult.status === 'ok' && leanResult.certificate) {
      recordAttempt({ attemptIndex: i, status: 'ok', leanSource, diagnostics: [], leanResult });
      return {
        ok: true,
        artifactKind: spec.artifactKind,
        theoremName: draft.declarationName,
        leanSource,
        termMap: draft.termMap,
        sourceHash: sha256(leanSource),
        normalizedGoalTerm: leanResult.certificate.normalizedGoalTerm,
        attempts,
        totalUsage,
      };
    }

    // Error — feed it back and retry.
    const diagnostics = [...importPreflight.diagnostics, ...describeLeanResult(leanResult)];
    previousError = `Previous Lean source:\n${leanSource}\nDiagnostics:\n${diagnostics.join('\n')}`;
    recordAttempt({ attemptIndex: i, status: 'error', leanSource, diagnostics, leanResult });
  }

  return formalizeFailure(classifyFormalizationExhaustion(attempts), attempts, totalUsage);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Status codes are matched on word boundaries: these messages now quote model
// output, and a declaration name like `poly402` must not read as a 402.
function hasStatusCode(message: string, ...codes: number[]): boolean {
  return codes.some((code) => new RegExp(`\\b${code}\\b`).test(message));
}

/**
 * The error and everything it wraps, lowercased.
 *
 * `undici` reports a dropped socket as a bare `TypeError: fetch failed` and puts
 * the real reason (`ECONNRESET`, `other side closed`) on `.cause`. Classifying
 * on `String(err)` alone therefore saw only "fetch failed" and never reached the
 * transient case below.
 */
function errorText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 5; depth++) {
    parts.push(String(current));
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ').toLowerCase();
}

/**
 * The request ran its full clock without answering. Retrying buys another wait
 * of the same length for the same result, so this stops the run — and it is
 * checked before the transient case, because the SDK aborts a timed-out request
 * internally and the abort is what the error ends up saying.
 */
function isTimeoutError(err: unknown): boolean {
  const message = errorText(err);
  return (
    message.includes('request timed out')
    || message.includes('etimedout')
    || message.includes('timeout')
  );
}

function isProviderInfrastructureError(err: unknown): boolean {
  const message = errorText(err);
  return (
    message.includes('budget')
    || message.includes('completion unusable')
    || message.includes('rate limit')
    || message.includes('too many requests')
    || message.includes('enotfound')
    || message.includes('fetch failed')
    || hasStatusCode(message, 401, 403, 429, 500, 502, 503, 504)
  );
}

// Out of credit. No retry can clear this, and each further attempt places
// another hold on the account, so the run stops with an actionable message.
function isCreditsError(err: unknown): boolean {
  const message = errorText(err);
  return (
    message.includes('insufficient credit')
    || message.includes('available credits')
    || message.includes('add credits')
    || hasStatusCode(message, 402)
  );
}

// The connection died mid-response. The generation usually keeps running on the
// provider's side — a client disconnect does not cancel it — so it holds its
// credit reservation for a while yet. Retrying instantly is what turns one
// dropped request into a 402 on the next one; wait, then allow a single retry.
//
// Tested BEFORE the infrastructure case: a dropped socket arrives wrapped in a
// generic "fetch failed", which that case also matches, and whichever runs first
// decides. This is the more specific reading of the same error.
function isTransientConnectionError(err: unknown): boolean {
  const message = errorText(err);
  return (
    message.includes('premature close')
    || message.includes('socket hang up')
    || message.includes('other side closed')
    || message.includes('econnreset')
    || message.includes('econnrefused')
    || message.includes('terminated')
    || message.includes('aborted')
  );
}

const TRANSIENT_RETRY_DELAY_MS = 10_000;

function creditsExhaustedDiagnostic(err: unknown): string {
  return `Out of provider credits — add credits at https://openrouter.ai/credits and run again. (${String(err)})`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

type ImportPreflightResult =
  | { action: 'check'; leanSource: string; diagnostics: string[]; hints: string[] }
  | { action: 'blocked'; diagnostics: string[] };

function preflightMathlibImports(
  leanSource: string,
  index: MathlibImportIndex | null | undefined,
): ImportPreflightResult {
  if (!index) return { action: 'check', leanSource, diagnostics: [], hints: [] };

  const validations = validateSourceImports(leanSource, index);
  const missingOleanImports = validations.filter((validation) => validation.status === 'missingOlean');
  if (missingOleanImports.length > 0) {
    return {
      action: 'blocked',
      diagnostics: missingOleanDiagnostics(missingOleanImports),
    };
  }

  const invalidImports = validations.filter((validation) => validation.status === 'invalid');
  if (invalidImports.length === 0) {
    return { action: 'check', leanSource, diagnostics: [], hints: [] };
  }

  return {
    action: 'check',
    leanSource: replaceInvalidMathlibImports(
      leanSource,
      invalidImports.map((validation) => ({
        moduleName: validation.moduleName,
        replacements: directChildImportCandidates(validation),
      })),
    ),
    diagnostics: invalidImportDiagnostics(invalidImports),
    hints: collectImportHints(invalidImports),
  };
}

function validateSourceImports(
  leanSource: string,
  index: MathlibImportIndex,
): MathlibImportValidation[] {
  const seen = new Set<string>();
  const validations: MathlibImportValidation[] = [];

  for (const moduleName of extractLeanImports(leanSource)) {
    if (seen.has(moduleName)) continue;
    seen.add(moduleName);
    validations.push(index.validateImport(moduleName));
  }

  return validations.filter((validation) => validation.status !== 'ignored');
}

function invalidImportDiagnostics(validations: MathlibImportValidation[]): string[] {
  const diagnostics: string[] = [];

  for (const validation of validations) {
    diagnostics.push(`Invalid Mathlib import: ${validation.moduleName}`);
    diagnostics.push(
      validation.candidates.length > 0
        ? `Nearby valid Mathlib modules: ${validation.candidates.join(', ')}`
        : 'Nearby valid Mathlib modules: (none found)',
    );
  }

  diagnostics.push('Use one of these exact modules, or use import Mathlib if unsure.');
  diagnostics.push('The invalid import was replaced with targeted valid imports before checking; preserve the mathematical statement while fixing remaining Lean errors.');
  return diagnostics;
}

function missingOleanDiagnostics(validations: MathlibImportValidation[]): string[] {
  const modules = validations.map((validation) => validation.moduleName).join(', ');
  return [
    `Mathlib import has source but no compiled .olean artifact: ${modules}`,
    'This looks like a local Lean/Mathlib provisioning cache problem; re-run Lean + Mathlib provisioning.',
  ];
}

function collectImportHints(validations: MathlibImportValidation[]): string[] {
  const hints = new Set<string>();

  for (const validation of validations) {
    for (const candidate of validation.candidates) {
      hints.add(candidate);
      if (hints.size >= MAX_IMPORT_HINTS) return [...hints];
    }
  }

  return [...hints];
}

function directChildImportCandidates(validation: MathlibImportValidation): string[] {
  const prefix = `${validation.moduleName}.`;
  const directChildren = validation.candidates.filter((candidate) => candidate.startsWith(prefix));
  return directChildren.length > 0 ? directChildren : ['Mathlib'];
}

function formalizeFailure(
  outcome: FormalizeFailure['outcome'],
  attempts: StatementAttempt[],
  totalUsage: TokenUsage,
): FormalizeFailure {
  return { ok: false, outcome, attempts, totalUsage };
}

function classifyFormalizationExhaustion(
  attempts: StatementAttempt[],
): FormalizeFailure['outcome'] {
  const leanTypecheckFailed = attempts.some(
    (attempt) => attempt.status === 'error' && attempt.leanResult?.status === 'error',
  );

  return leanTypecheckFailed ? 'malformedClaim' : 'verificationBlocked';
}

function describeLeanResult(result: LeanCheckResult): string[] {
  const diagnostics = result.diagnostics.map((diagnostic) => {
    const location = diagnostic.line != null && diagnostic.column != null
      ? `${diagnostic.line}:${diagnostic.column}: `
      : '';
    return `${location}${diagnostic.message}`;
  });

  if (diagnostics.length > 0) return diagnostics;

  const output = [result.stderr.trim(), result.stdout.trim()]
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => chunk.slice(0, 2000));

  return output.length > 0 ? output : [`Lean returned status ${result.status} with no diagnostics`];
}

export function composeLeanFile(dependencyDeclarations: string, source: string): string {
  if (!dependencyDeclarations.trim()) return source;

  const imports = new Set<string>();
  const bodyParts: string[] = [];

  for (const chunk of [dependencyDeclarations, source]) {
    const bodyLines: string[] = [];
    for (const line of chunk.split('\n')) {
      const importModules = parseImportLine(line)?.modules ?? [];
      if (importModules.length > 0) {
        for (const moduleName of importModules) imports.add(`import ${moduleName}`);
      } else {
        bodyLines.push(line);
      }
    }
    const body = bodyLines.join('\n').trim();
    if (body) bodyParts.push(body);
  }

  return [[...imports].join('\n'), ...bodyParts].filter(Boolean).join('\n\n');
}

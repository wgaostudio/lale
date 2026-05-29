import { createHash } from 'node:crypto';
import type {
  DefinitionFormalizationResult,
  FormalizationResult,
  ModelClient,
  TokenUsage,
} from '@lale/translator';
import {
  formalizeDefinition as translatorFormalizeDefinition,
  formalizeStatement as translatorFormalize,
} from '@lale/translator';
import type { LeanRunner, LeanCheckResult } from '@lale/lean-runner';
import type { NormalizedClaimContext } from './context.js';
import { formatDependencyDeclarations } from './context.js';
import type { MathlibImportIndex, MathlibImportValidation } from './mathlib-index.js';
import {
  extractLeanImports,
  replaceInvalidMathlibImports,
} from './mathlib-index.js';

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
// Formalize the statement and verify it type-checks with `sorry` (§3.7)
// ---------------------------------------------------------------------------

const MAX_FORMALIZE_RETRIES = 3;

export async function formalizeAndCheck(
  formalizerClient: ModelClient,
  runner: LeanRunner,
  context: NormalizedClaimContext,
  leanVersion: string,
  mathlibRevision: string,
  options: FormalizeCheckOptions = {},
): Promise<FormalizeCheckResult> {
  const dependencyDeclarations = formatDependencyDeclarations(context.resolvedDependencies);
  const attempts: StatementAttempt[] = [];
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let previousError: string | undefined;
  let mathlibImportHints: string[] = [];

  const recordAttempt = (attempt: StatementAttempt): void => {
    attempts.push(attempt);
    options.onAttempt?.(attempt);
  };

  for (let i = 0; i < MAX_FORMALIZE_RETRIES; i++) {
    let formalization: FormalizationResult;
    try {
      options.onProgress?.({
        attemptIndex: i,
        stage: 'modelRequest',
        message: `Statement formalization attempt ${i + 1}: requesting model output`,
      });
      formalization = await withModelRequestHeartbeat(
        () => translatorFormalize(formalizerClient, {
          statementText: context.statementText,
          proofText: context.proofText,
          dependencyDeclarations,
          leanVersion,
          mathlibRevision,
          ...(previousError !== undefined ? { previousError } : {}),
          ...(mathlibImportHints.length > 0 ? { mathlibImportHints } : {}),
        }),
        options,
        i,
        'Statement',
      );
      options.onProgress?.({
        attemptIndex: i,
        stage: 'modelResponse',
        message: `Statement formalization attempt ${i + 1}: model output received`,
      });
    } catch (err) {
      recordAttempt({
        attemptIndex: i,
        status: 'error',
        leanSource: '',
        diagnostics: [`Formalization model error: ${String(err)}`],
        leanResult: null,
      });
      if (isProviderInfrastructureError(err)) {
        return formalizeFailure('verificationBlocked', attempts, totalUsage);
      }
      continue;
    }

    totalUsage.inputTokens += formalization.usage.inputTokens;
    totalUsage.outputTokens += formalization.usage.outputTokens;

    // Inject sorry if the model didn't include it.
    let leanSource = ensureSorry(formalization.leanSource);
    const importPreflight = preflightMathlibImports(
      leanSource,
      options.mathlibImportIndex,
    );

    if (importPreflight.action === 'blocked') {
      recordAttempt({
        attemptIndex: i,
        status: 'error',
        leanSource,
        diagnostics: importPreflight.diagnostics,
        leanResult: null,
      });
      return formalizeFailure('verificationBlocked', attempts, totalUsage);
    }

    leanSource = importPreflight.leanSource;
    if (importPreflight.hints.length > 0) {
      mathlibImportHints = importPreflight.hints;
      options.onProgress?.({
        attemptIndex: i,
        stage: 'importRepair',
        message: `Statement formalization attempt ${i + 1}: repaired invalid Mathlib imports`,
        payload: {
          diagnostics: importPreflight.diagnostics,
          importHints: importPreflight.hints,
        },
      });
    }

    options.onProgress?.({
      attemptIndex: i,
      stage: 'leanCheck',
      message: `Statement formalization attempt ${i + 1}: checking Lean header`,
    });
    const leanResult = await runner.check(
      composeLeanFile(dependencyDeclarations, leanSource),
      { allowTrustViolations: ['sorry'] },
    );

    if (leanResult.status === 'blocked') {
      recordAttempt({
        attemptIndex: i,
        status: 'blocked',
        leanSource,
        diagnostics: describeLeanResult(leanResult),
        leanResult,
      });
      // Trust violation — don't retry, escalate immediately.
      return formalizeFailure('verificationBlocked', attempts, totalUsage);
    }

    if (leanResult.status === 'timeout') {
      recordAttempt({
        attemptIndex: i,
        status: 'timeout',
        leanSource,
        diagnostics: describeLeanResult(leanResult),
        leanResult,
      });
      return formalizeFailure('verificationBlocked', attempts, totalUsage);
    }

    if (leanResult.status === 'ok') {
      recordAttempt({
        attemptIndex: i,
        status: 'ok',
        leanSource,
        diagnostics: [],
        leanResult,
      });
      return {
        ok: true,
        artifactKind: 'theorem',
        theoremName: formalization.theoremName,
        leanSource,
        termMap: formalization.termMap,
        sourceHash: sha256(leanSource),
        attempts,
        totalUsage,
      };
    }

    // Error — feed it back and retry.
    const diagnostics = [
      ...importPreflight.diagnostics,
      ...describeLeanResult(leanResult),
    ];
    const errorText = diagnostics.join('\n');
    previousError = errorText;
    recordAttempt({
      attemptIndex: i,
      status: 'error',
      leanSource,
      diagnostics,
      leanResult,
    });
  }

  return formalizeFailure(classifyFormalizationExhaustion(attempts), attempts, totalUsage);
}

// ---------------------------------------------------------------------------
// Formalize a definition-like item and verify the declaration type-checks.
// Unlike theorem headers, definitions are dependency context, so the accepted
// Lean must be a real declaration with no sorry/axiom escape hatch.
// ---------------------------------------------------------------------------

export async function formalizeDefinitionAndCheck(
  formalizerClient: ModelClient,
  runner: LeanRunner,
  context: NormalizedClaimContext,
  leanVersion: string,
  mathlibRevision: string,
  options: FormalizeCheckOptions = {},
): Promise<FormalizeCheckResult> {
  const dependencyDeclarations = formatDependencyDeclarations(context.resolvedDependencies);
  const attempts: StatementAttempt[] = [];
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let previousError: string | undefined;
  let mathlibImportHints: string[] = [];

  const recordAttempt = (attempt: StatementAttempt): void => {
    attempts.push(attempt);
    options.onAttempt?.(attempt);
  };

  for (let i = 0; i < MAX_FORMALIZE_RETRIES; i++) {
    let formalization: DefinitionFormalizationResult;
    try {
      options.onProgress?.({
        attemptIndex: i,
        stage: 'modelRequest',
        message: `Definition formalization attempt ${i + 1}: requesting model output`,
      });
      formalization = await withModelRequestHeartbeat(
        () => translatorFormalizeDefinition(formalizerClient, {
          definitionText: context.statementText,
          dependencyDeclarations,
          leanVersion,
          mathlibRevision,
          ...(previousError !== undefined ? { previousError } : {}),
          ...(mathlibImportHints.length > 0 ? { mathlibImportHints } : {}),
        }),
        options,
        i,
        'Definition',
      );
      options.onProgress?.({
        attemptIndex: i,
        stage: 'modelResponse',
        message: `Definition formalization attempt ${i + 1}: model output received`,
      });
    } catch (err) {
      recordAttempt({
        attemptIndex: i,
        status: 'error',
        leanSource: '',
        diagnostics: [`Definition formalization model error: ${String(err)}`],
        leanResult: null,
      });
      if (isProviderInfrastructureError(err)) {
        return formalizeFailure('verificationBlocked', attempts, totalUsage);
      }
      continue;
    }

    totalUsage.inputTokens += formalization.usage.inputTokens;
    totalUsage.outputTokens += formalization.usage.outputTokens;

    let leanSource = formalization.leanSource;
    const importPreflight = preflightMathlibImports(
      leanSource,
      options.mathlibImportIndex,
    );

    if (importPreflight.action === 'blocked') {
      recordAttempt({
        attemptIndex: i,
        status: 'error',
        leanSource,
        diagnostics: importPreflight.diagnostics,
        leanResult: null,
      });
      return formalizeFailure('verificationBlocked', attempts, totalUsage);
    }

    leanSource = importPreflight.leanSource;
    if (importPreflight.hints.length > 0) {
      mathlibImportHints = importPreflight.hints;
      options.onProgress?.({
        attemptIndex: i,
        stage: 'importRepair',
        message: `Definition formalization attempt ${i + 1}: repaired invalid Mathlib imports`,
        payload: {
          diagnostics: importPreflight.diagnostics,
          importHints: importPreflight.hints,
        },
      });
    }

    options.onProgress?.({
      attemptIndex: i,
      stage: 'leanCheck',
      message: `Definition formalization attempt ${i + 1}: checking Lean declaration`,
    });
    const leanResult = await runner.check(composeLeanFile(dependencyDeclarations, leanSource));

    if (leanResult.status === 'blocked') {
      recordAttempt({
        attemptIndex: i,
        status: 'blocked',
        leanSource,
        diagnostics: describeLeanResult(leanResult),
        leanResult,
      });
      return formalizeFailure('verificationBlocked', attempts, totalUsage);
    }

    if (leanResult.status === 'timeout') {
      recordAttempt({
        attemptIndex: i,
        status: 'timeout',
        leanSource,
        diagnostics: describeLeanResult(leanResult),
        leanResult,
      });
      return formalizeFailure('verificationBlocked', attempts, totalUsage);
    }

    if (leanResult.status === 'ok') {
      recordAttempt({
        attemptIndex: i,
        status: 'ok',
        leanSource,
        diagnostics: [],
        leanResult,
      });
      return {
        ok: true,
        artifactKind: 'definition',
        theoremName: formalization.declarationName,
        leanSource,
        termMap: formalization.termMap,
        sourceHash: sha256(leanSource),
        attempts,
        totalUsage,
      };
    }

    const diagnostics = [
      ...importPreflight.diagnostics,
      ...describeLeanResult(leanResult),
    ];
    const errorText = diagnostics.join('\n');
    previousError = errorText;
    recordAttempt({
      attemptIndex: i,
      status: 'error',
      leanSource,
      diagnostics,
      leanResult,
    });
  }

  return formalizeFailure(classifyFormalizationExhaustion(attempts), attempts, totalUsage);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureSorry(source: string): string {
  if (/\bsorry\b/.test(source)) return source;
  // Replace := by <tactic proof> with := by sorry, or append sorry.
  if (/:= by\s*$/.test(source.trimEnd())) return source.trimEnd() + '\n  sorry';
  if (/:=$/.test(source.trimEnd())) return source.trimEnd() + ' sorry';
  return source + '\n  sorry';
}

function isProviderInfrastructureError(err: unknown): boolean {
  const message = String(err).toLowerCase();
  return (
    message.includes('request timed out')
    || message.includes('timeout')
    || message.includes('429')
    || message.includes('rate limit')
    || message.includes('too many requests')
    || message.includes('401')
    || message.includes('403')
    || message.includes('500')
    || message.includes('502')
    || message.includes('503')
    || message.includes('504')
    || message.includes('econnreset')
    || message.includes('etimedout')
    || message.includes('enotfound')
    || message.includes('fetch failed')
  );
}

async function withModelRequestHeartbeat<T>(
  request: () => Promise<T>,
  options: FormalizeCheckOptions,
  attemptIndex: number,
  label: 'Statement' | 'Definition',
): Promise<T> {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedMs = Date.now() - startedAt;
    options.onProgress?.({
      attemptIndex,
      stage: 'modelRequest',
      message: `${label} formalization attempt ${attemptIndex + 1}: still waiting for model output (${Math.round(elapsedMs / 1000)}s)`,
      payload: { elapsedMs },
    });
  }, 15_000);

  try {
    return await request();
  } finally {
    clearInterval(timer);
  }
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
      if (hints.size >= 12) return [...hints];
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
      const importModules = extractImportModules(line);
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

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function extractImportModules(line: string): string[] {
  const match = /^\s*import\s+(.+)$/.exec(line);
  if (!match) return [];

  const rest = (match[1] ?? '').split('--')[0]?.trim() ?? '';
  return rest ? rest.split(/\s+/).filter(Boolean) : [];
}

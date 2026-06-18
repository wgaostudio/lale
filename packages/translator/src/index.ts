import OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Model client config
// ---------------------------------------------------------------------------

export interface ModelClientConfig {
  apiKey: string;
  baseURL?: string;
  modelId: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Token / cost tracking
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Low-level model client
// ---------------------------------------------------------------------------

export class ModelClient {
  private readonly client: OpenAI;
  private readonly modelId: string;
  private readonly maxTokens: number;
  private readonly temperature: number;

  constructor(config: ModelClientConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeoutMs ?? 90_000,
      maxRetries: config.maxRetries ?? 0,
    });
    this.modelId = config.modelId;
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.2;
  }

  async complete(
    systemPrompt: string,
    userContent: string,
    maxTokensOverride?: number,
  ): Promise<{ text: string; usage: TokenUsage }> {
    const response = await this.client.chat.completions.create({
      model: this.modelId,
      max_tokens: maxTokensOverride ?? this.maxTokens,
      temperature: this.temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    });

    const text = response.choices[0]?.message?.content ?? '';
    const usage: TokenUsage = {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
    return { text, usage };
  }
}

// ---------------------------------------------------------------------------
// Formalize statement
// ---------------------------------------------------------------------------

export interface FormalizationContext {
  statementText: string;
  proofText: string | null;
  dependencyDeclarations: string;
  leanVersion: string;
  mathlibRevision: string;
  previousError?: string;
  mathlibImportHints?: string[];
}

export interface FormalizationResult {
  leanSource: string;
  theoremName: string;
  termMap: Record<string, string>;
  usage: TokenUsage;
}

export interface DefinitionFormalizationContext {
  definitionText: string;
  dependencyDeclarations: string;
  leanVersion: string;
  mathlibRevision: string;
  previousError?: string;
  mathlibImportHints?: string[];
}

export interface DefinitionFormalizationResult {
  leanSource: string;
  declarationName: string;
  declarationKind: 'def' | 'abbrev' | 'structure' | 'class' | 'notation' | 'other';
  termMap: Record<string, string>;
  usage: TokenUsage;
}

const FORMALIZE_SYSTEM = `You are a Lean 4 / Mathlib autoformalization assistant.
Given a LaTeX mathematical statement and its surrounding context, produce a well-typed Lean 4 theorem header.

Output format — respond with a single JSON object:
{
  "theoremName": "<camelCase identifier>",
  "leanSource": "<the full Lean theorem header ending with := by sorry>",
  "termMap": { "<natural language term>": "<Lean term>" }
}

Rules:
- Use only names available in the provided Mathlib revision.
- The theorem must type-check with \`sorry\` filling the proof obligation.
- Do NOT include a proof body — end with \`:= by sorry\`.
- Preserve the mathematical content exactly; do not strengthen or weaken the statement.
- On retries, preserve the statement's objects, quantifiers, coefficient types, assumptions, and conclusion unless the Lean diagnostic specifically proves that encoding is ill-typed.
- Do not import namespace directories. Imports must name exact Mathlib modules; when unsure, use \`import Mathlib\`.
- Include all necessary imports at the top of leanSource.`;

export async function formalizeStatement(
  client: ModelClient,
  context: FormalizationContext,
): Promise<FormalizationResult> {
  const errorSection = context.previousError
    ? `\n\n## Previous attempt failed — do not repeat the same approach\n\`\`\`\n${context.previousError}\n\`\`\``
    : '';
  const importHintSection = formatMathlibImportHints(context.mathlibImportHints);

  const userContent = `## Statement (LaTeX)
${context.statementText}

## Adjacent proof (LaTeX, for context only — do NOT formalize the proof)
${context.proofText ?? '(none)'}

## Available dependency declarations (Lean)
${context.dependencyDeclarations || '(none)'}

## Environment
Lean version: ${context.leanVersion}
Mathlib revision: ${context.mathlibRevision}${importHintSection}${errorSection}`;

  const { text, usage } = await client.complete(FORMALIZE_SYSTEM, userContent);

  const json = extractJson(text);
  return {
    leanSource: json.leanSource as string,
    theoremName: json.theoremName as string,
    termMap: (json.termMap as Record<string, string>) ?? {},
    usage,
  };
}

const FORMALIZE_DEFINITION_SYSTEM = `You are a Lean 4 / Mathlib autoformalization assistant.
Given a LaTeX mathematical definition and its surrounding context, produce faithful Lean 4 declaration(s) that define the introduced concept.

Output format — respond with a single JSON object:
{
  "declarationName": "<primary Lean identifier>",
  "declarationKind": "def" | "abbrev" | "structure" | "class" | "notation" | "other",
  "leanSource": "<a complete Lean file containing imports and the declaration(s)>",
  "termMap": { "<natural language term>": "<Lean term>" }
}

Rules:
- Use only names available in the provided Mathlib revision and the provided dependencies.
- The Lean source must type-check without \`sorry\`, \`admit\`, \`axiom\`, \`opaque\`, \`unsafe\`, \`native_decide\`, \`#eval\`, or \`IO\`.
- Prefer transparent \`def\`, \`abbrev\`, \`structure\`, or \`class\` declarations over theorem statements.
- Preserve the mathematical content of the definition; do not silently strengthen, weaken, or replace it with a standard definition that differs from the text.
- On retries, preserve the definition's objects, quantifiers, coefficient types, assumptions, and introduced concept unless the Lean diagnostic specifically proves that encoding is ill-typed.
- Do not import namespace directories. Imports must name exact Mathlib modules; when unsure, use \`import Mathlib\`.
- Include all necessary imports at the top of leanSource.`;

export async function formalizeDefinition(
  client: ModelClient,
  context: DefinitionFormalizationContext,
): Promise<DefinitionFormalizationResult> {
  const errorSection = context.previousError
    ? `\n\n## Previous attempt failed — do not repeat the same approach\n\`\`\`\n${context.previousError}\n\`\`\``
    : '';
  const importHintSection = formatMathlibImportHints(context.mathlibImportHints);

  const userContent = `## Definition (LaTeX)
${context.definitionText}

## Available dependency declarations (Lean)
${context.dependencyDeclarations || '(none)'}

## Environment
Lean version: ${context.leanVersion}
Mathlib revision: ${context.mathlibRevision}${importHintSection}${errorSection}`;

  const { text, usage } = await client.complete(FORMALIZE_DEFINITION_SYSTEM, userContent);
  const json = extractJson(text);
  return {
    leanSource: json.leanSource as string,
    declarationName: json.declarationName as string,
    declarationKind: json.declarationKind as DefinitionFormalizationResult['declarationKind'],
    termMap: (json.termMap as Record<string, string>) ?? {},
    usage,
  };
}

// ---------------------------------------------------------------------------
// Re-formalize (for faithfulness roundtrip)
// ---------------------------------------------------------------------------

export async function reformalizeStatement(
  client: ModelClient,
  nlStatement: string,
  context: Pick<FormalizationContext, 'dependencyDeclarations' | 'leanVersion' | 'mathlibRevision'>,
): Promise<{ leanSource: string; theoremName: string; usage: TokenUsage }> {
  const userContent = `## Statement (natural language)
${nlStatement}

## Available dependency declarations (Lean)
${context.dependencyDeclarations || '(none)'}

## Environment
Lean version: ${context.leanVersion}
Mathlib revision: ${context.mathlibRevision}`;

  const { text, usage } = await client.complete(FORMALIZE_SYSTEM, userContent);
  const json = extractJson(text);
  return {
    leanSource: json.leanSource as string,
    theoremName: json.theoremName as string,
    usage,
  };
}

export async function reformalizeDefinition(
  client: ModelClient,
  nlDefinition: string,
  context: Pick<DefinitionFormalizationContext, 'dependencyDeclarations' | 'leanVersion' | 'mathlibRevision'>,
): Promise<{ leanSource: string; declarationName: string; usage: TokenUsage }> {
  const userContent = `## Definition (natural language)
${nlDefinition}

## Available dependency declarations (Lean)
${context.dependencyDeclarations || '(none)'}

## Environment
Lean version: ${context.leanVersion}
Mathlib revision: ${context.mathlibRevision}`;

  const { text, usage } = await client.complete(FORMALIZE_DEFINITION_SYSTEM, userContent);
  const json = extractJson(text);
  return {
    leanSource: json.leanSource as string,
    declarationName: json.declarationName as string,
    usage,
  };
}

// ---------------------------------------------------------------------------
// Backtranslate Lean → natural language
// ---------------------------------------------------------------------------

export interface BacktranslationResult {
  nlStatement: string;
  usage: TokenUsage;
}

const BACKTRANSLATE_SYSTEM = `You are a mathematical writing assistant.
Given a Lean 4 theorem statement or definition declaration, produce a clear natural-language rendering of the mathematical content.
Do NOT include proof details. Output only the natural-language statement or definition as plain text — no JSON, no code blocks.`;

export async function backtranslate(
  client: ModelClient,
  leanSource: string,
): Promise<BacktranslationResult> {
  const { text, usage } = await client.complete(BACKTRANSLATE_SYSTEM, leanSource, 512);
  return { nlStatement: text.trim(), usage };
}

// ---------------------------------------------------------------------------
// Faithfulness comparison (backtranslation pre-filter)
// ---------------------------------------------------------------------------

export interface FaithfulnessComparisonResult {
  agreement: 'agree' | 'disagree' | 'uncertain';
  explanation: string;
  usage: TokenUsage;
}

const COMPARE_SYSTEM = `You are a mathematical statement comparison assistant.
Given two natural-language statements of mathematical claims, judge whether they express the same mathematical content.

Output a single JSON object:
{
  "agreement": "agree" | "disagree" | "uncertain",
  "explanation": "<one sentence>"
}

"agree" means the statements are mathematically equivalent.
"disagree" means there is a clear mathematical difference (different quantifiers, wrong direction, missing hypothesis, etc.).
"uncertain" means you cannot tell without further analysis.`;

export async function compareFaithfulness(
  client: ModelClient,
  originalNL: string,
  backtranslatedNL: string,
): Promise<FaithfulnessComparisonResult> {
  const userContent = `## Original statement
${originalNL}

## Backtranslated statement
${backtranslatedNL}`;

  const { text, usage } = await client.complete(COMPARE_SYSTEM, userContent, 256);
  const json = extractJson(text);
  return {
    agreement: json.agreement as FaithfulnessComparisonResult['agreement'],
    explanation: json.explanation as string,
    usage,
  };
}

// ---------------------------------------------------------------------------
// Prove equivalence goal (tier-2 roundtrip, prover role)
// ---------------------------------------------------------------------------

export interface ProveEquivResult {
  leanSource: string;
  usage: TokenUsage;
}

const PROVE_EQUIV_SYSTEM = `You are a Lean 4 / Mathlib theorem prover.
Given two Lean theorem statements S1 and S2 that should express the same mathematical claim,
write a complete Lean 4 proof of \`S1_statement ↔ S2_statement\`.

Output a single JSON object:
{
  "leanSource": "<complete Lean file proving the biconditional>"
}

The proof should be concise — if the statements are equivalent, \`simp\`, \`tauto\`, \`omega\`, or a short \`constructor\` proof should suffice.`;

export async function proveEquivalence(
  client: ModelClient,
  s1Source: string,
  s2Source: string,
  dependencyDeclarations: string,
): Promise<ProveEquivResult> {
  const userContent = `## S1 (original formalization)
${s1Source}

## S2 (re-formalization for roundtrip)
${s2Source}

## Available declarations
${dependencyDeclarations || '(none)'}

Produce a Lean proof that S1's statement ↔ S2's statement.`;

  const { text, usage } = await client.complete(PROVE_EQUIV_SYSTEM, userContent, 1024);
  const json = extractJson(text);
  return { leanSource: json.leanSource as string, usage };
}

// ---------------------------------------------------------------------------
// End-to-end proof attempt (prover role)
// ---------------------------------------------------------------------------

export interface ProofAttemptResult {
  leanSource: string;
  usage: TokenUsage;
}

const PROVE_SYSTEM = `You are a Lean 4 / Mathlib theorem prover.
Given a frozen theorem header and the author's natural-language proof as a chain-of-thought sketch,
produce a complete, compiling Lean 4 proof.

Output a single JSON object:
{
  "leanSource": "<complete Lean file with the theorem and its proof>"
}

Rules:
- Use only names available in the provided Mathlib revision and the listed dependencies.
- Preserve the frozen theorem declaration exactly; only replace the proof after \`:= by\`.
- Do NOT use \`sorry\`, \`admit\`, \`unsafe\`, \`native_decide\`, \`#eval\`, or \`IO\`.
- The proof must close all goals.
- Use the author's NL argument as a guide, but produce correct Lean — do not blindly translate words.`;

export async function proveEndToEnd(
  client: ModelClient,
  frozenHeader: string,
  authorProof: string,
  dependencyDeclarations: string,
  previousError?: string,
): Promise<ProofAttemptResult> {
  const errorSection = previousError
    ? `\n## Previous attempt error (translate the argument differently)\n${previousError}`
    : '';

  const userContent = `## Frozen theorem header
${frozenHeader}

## Author's proof (natural language — use as chain-of-thought sketch)
${authorProof}

## Available dependency declarations
${dependencyDeclarations || '(none)'}${errorSection}`;

  const { text, usage } = await client.complete(PROVE_SYSTEM, userContent);
  const json = extractJson(text);
  return { leanSource: json.leanSource as string, usage };
}

// ---------------------------------------------------------------------------
// Informal advisory audit (auxiliary role)
// ---------------------------------------------------------------------------

export interface InformalAuditResult {
  verdict:
    | 'noObviousIssue'
    | 'possibleTypo'
    | 'possibleGap'
    | 'possibleContradiction'
    | 'possibleClaimProofMismatch'
    | 'uncertain';
  confidence: 'high' | 'medium' | 'low';
  findings: string[];
  usage: TokenUsage;
}

const INFORMAL_AUDIT_SYSTEM = `You are a mathematical proofreader.
Given a theorem statement and its proof, identify obvious issues without deep formal verification.

Output a single JSON object:
{
  "verdict": "noObviousIssue" | "possibleTypo" | "possibleGap" | "possibleContradiction" | "possibleClaimProofMismatch" | "uncertain",
  "confidence": "high" | "medium" | "low",
  "findings": ["<finding 1>", "<finding 2>"]
}

Be conservative: only report high-confidence issues. When unsure, use "uncertain" with low confidence.`;

export async function informalAudit(
  client: ModelClient,
  statementText: string,
  proofText: string,
  dependencies: string,
): Promise<InformalAuditResult> {
  const userContent = `## Claim
${statementText}

## Proof
${proofText}

## Dependencies
${dependencies || '(none)'}`;

  const { text, usage } = await client.complete(INFORMAL_AUDIT_SYSTEM, userContent, 512);
  const json = extractJson(text);
  return {
    verdict: json.verdict as InformalAuditResult['verdict'],
    confidence: json.confidence as InformalAuditResult['confidence'],
    findings: (json.findings as string[]) ?? [],
    usage,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatMathlibImportHints(hints: string[] | undefined): string {
  const cappedHints = [...new Set(hints ?? [])].slice(0, 12);
  if (cappedHints.length === 0) return '';

  return `\n\n## Valid Mathlib import candidates
${cappedHints.map((moduleName) => `- ${moduleName}`).join('\n')}
Use these exact module names only if they are relevant. If none fit, prefer \`import Mathlib\`.`;
}

function extractJson(text: string): Record<string, unknown> {
  // Try to find a JSON object in the response, handling markdown code blocks.
  const stripped = text
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    // Fallback: find the first {...} block.
    const match = /\{[\s\S]*\}/.exec(stripped);
    if (match) {
      try {
        return JSON.parse(match[0]) as Record<string, unknown>;
      } catch {
        // fall through
      }
    }
    throw new Error(`Model returned non-JSON response: ${text.slice(0, 200)}`);
  }
}

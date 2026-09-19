// The role and provider vocabularies are the protocol's, and the database's
// CHECK constraints are written from the same two lists. A local copy of either
// union typechecks against them right up until one of the three gains a member.
import type { ModelRole, ProviderKind } from '@lale/protocol';

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_FORMALIZER_MODEL = 'openai/gpt-6-astra';
export const DEFAULT_AUXILIARY_MODEL = 'openai/gpt-6-astra';

// All three roles run on OpenRouter, so a single stored key serves the whole app.
export const OPENROUTER_KEY_REF = 'lale:openrouter.ai';

export interface ProviderConfigSpec {
  role: ModelRole;
  providerKind: ProviderKind;
  baseUrl: string;
  modelId: string;
  reasoningEffort: string | null;
  maxTokens: number;
  temperature: number | null;
}

// OpenRouter is the only supported provider and the models are fixed in code.
// The API key never comes from the environment — it is entered in the
// extension settings UI and stored in the OS keychain.
//
// Effort and token ceiling are cost controls, not just quality dials: reasoning
// tokens bill as output, and the provider holds credit against `maxTokens` for
// the whole request. Formalization runs against a ground-truth checker — Lean
// compiles each attempt and the diagnostic is fed back into the next one — so
// several cheaper attempts guided by real errors beat one deeper unguided pass.
// The advisory role only emits short JSON verdicts and needs far less of both.
// The proposer has its own row below, so this effort governs formalization only.
export function defaultProviderConfigSpecs(): ProviderConfigSpec[] {
  // Astra is the default across formalization, proving, and advisory calls.
  return [
    {
      role: 'formalizer',
      providerKind: 'openrouter',
      baseUrl: DEFAULT_OPENROUTER_BASE_URL,
      modelId: DEFAULT_FORMALIZER_MODEL,
      reasoningEffort: 'high', maxTokens: 16384, temperature: null,
    },
    {
      // Generating a proof is the one stage with no external signal until Lean
      // either accepts the attempt or does not, so it keeps the deepest
      // reasoning; call sites size the ceiling to the obligation.
      role: 'proposer',
      providerKind: 'openrouter',
      baseUrl: DEFAULT_OPENROUTER_BASE_URL,
      modelId: DEFAULT_FORMALIZER_MODEL,
      reasoningEffort: 'xhigh', maxTokens: 32768, temperature: null,
    },
    {
      role: 'auxiliary',
      providerKind: 'openrouter',
      baseUrl: DEFAULT_OPENROUTER_BASE_URL,
      modelId: DEFAULT_AUXILIARY_MODEL,
      reasoningEffort: 'medium', maxTokens: 8192, temperature: null,
    },
  ];
}

import type { ProviderConfigRow } from './db.js';

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_NOVITA_BASE_URL = 'https://api.novita.ai/openai';
export const DEFAULT_FEATHERLESS_BASE_URL = 'https://api.featherless.ai/v1';
export const DEFAULT_FORMALIZER_MODEL = 'deepseek/deepseek-prover-v2-671b';
export const DEFAULT_AUXILIARY_MODEL = 'openai/gpt-chat-latest';

type ProviderRole = ProviderConfigRow['role'];
type ProviderKind = 'openrouter' | 'openaiCompatible' | 'local' | 'manual';

export interface ProviderConfigSpec {
  role: ProviderRole;
  providerKind: ProviderKind;
  baseUrl: string;
  modelId: string;
}

export function defaultProviderConfigSpecs(env: NodeJS.ProcessEnv): ProviderConfigSpec[] {
  const openRouterBaseUrl = env['LALE_BASE_URL'] ?? DEFAULT_OPENROUTER_BASE_URL;

  // Formalizer: Novita (DeepSeek Prover V2 671B) by default; override with
  // LALE_FORMALIZER_BASE_URL + LALE_FORMALIZER_MODEL for Featherless (Goedel).
  return [
    {
      role: 'formalizer',
      providerKind: 'openaiCompatible',
      baseUrl: env['LALE_FORMALIZER_BASE_URL'] ?? DEFAULT_NOVITA_BASE_URL,
      modelId: env['LALE_FORMALIZER_MODEL'] ?? DEFAULT_FORMALIZER_MODEL,
    },
    {
      role: 'auxiliary',
      providerKind: 'openrouter',
      baseUrl: env['LALE_AUXILIARY_BASE_URL'] ?? openRouterBaseUrl,
      modelId: env['LALE_AUXILIARY_MODEL'] ?? DEFAULT_AUXILIARY_MODEL,
    },
  ];
}

export function apiKeyEnvNames(config: Pick<ProviderConfigRow, 'role' | 'providerKind' | 'baseUrl'>): string[] {
  const names = [`LALE_${config.role.toUpperCase()}_API_KEY`];
  const baseUrl = config.baseUrl ?? '';

  if (config.providerKind === 'openrouter' || baseUrl.includes('openrouter.ai')) {
    names.push('LALE_OPENROUTER_API_KEY');
  }
  if (baseUrl.includes('novita.ai')) {
    names.push('LALE_NOVITA_API_KEY');
  }
  if (baseUrl.includes('featherless.ai')) {
    names.push('LALE_FEATHERLESS_API_KEY');
  }
  if (baseUrl.includes('deepseek.com')) {
    names.push('LALE_DEEPSEEK_API_KEY');
  }

  names.push('LALE_API_KEY');
  return [...new Set(names)];
}

export function resolveApiKeyFromEnv(
  config: Pick<ProviderConfigRow, 'role' | 'providerKind' | 'baseUrl'>,
  env: NodeJS.ProcessEnv,
): { envName: string; value: string } | null {
  for (const envName of apiKeyEnvNames(config)) {
    const value = env[envName];
    if (value?.trim()) return { envName, value: value.trim() };
  }
  return null;
}

export function hasApiKeyEnv(
  config: Pick<ProviderConfigRow, 'role' | 'providerKind' | 'baseUrl'>,
  env: NodeJS.ProcessEnv,
): boolean {
  return resolveApiKeyFromEnv(config, env) !== null;
}

// Returns the keytar ref (service:account) for a provider config.
// Configs sharing the same base URL get the same ref so the user only
// needs to store one key per provider endpoint.
export function deriveKeyRef(
  config: Pick<ProviderConfigRow, 'baseUrl' | 'providerKind' | 'providerConfigId'>,
): string {
  const url = config.baseUrl ?? '';
  if (url.includes('openrouter.ai') || config.providerKind === 'openrouter') return 'lale:openrouter.ai';
  if (url.includes('novita.ai')) return 'lale:novita.ai';
  if (url.includes('featherless.ai')) return 'lale:featherless.ai';
  if (url.includes('deepseek.com')) return 'lale:deepseek.com';
  return `lale:${config.providerConfigId}`;
}

// ---------------------------------------------------------------------------
// Model pricing and account balance
//
// A token budget cannot tell you a run costs six dollars rather than sixty
// cents, which is how a run gets three quarters of the way in before the
// provider refuses it for want of credit. OpenRouter publishes per-token prices
// on a public endpoint, and reports the account balance on an authenticated
// one; both are cached for the session so a run costs no extra round trips.
// ---------------------------------------------------------------------------

// Defined by @lale/translator, because `RunBudget.pricing` is what these prices
// are ultimately assigned to — two structurally identical copies would typecheck
// against each other right up until one of them gained a field.
export type { TokenPricing } from '@lale/translator';
import type { TokenPricing } from '@lale/translator';

export interface AccountBalance {
  totalCreditsUsd: number;
  totalUsageUsd: number;
  remainingUsd: number;
}

const PRICING_TTL_MS = 24 * 60 * 60 * 1000;
const BALANCE_TTL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

const pricingCache = new Map<string, { value: TokenPricing | null; expiresAt: number }>();
let balanceCache: { value: AccountBalance | null; expiresAt: number } | null = null;

function isOpenRouter(baseUrl: string | null): boolean {
  try { return new URL(baseUrl ?? '').hostname === 'openrouter.ai'; } catch { return false; }
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * Per-token prices for a model, or null when they cannot be determined — the
 * caller then reports token counts alone rather than inventing a figure.
 */
export async function getModelPricing(baseUrl: string | null, modelId: string): Promise<TokenPricing | null> {
  if (!isOpenRouter(baseUrl)) return null;

  const cached = pricingCache.get(modelId);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  let pricing: TokenPricing | null = null;
  try {
    const body = await getJson('https://openrouter.ai/api/v1/models') as { data?: unknown };
    const models = Array.isArray(body.data) ? body.data : [];
    const model = models.find((m): m is { id: string; pricing?: Record<string, unknown> } =>
      typeof m === 'object' && m !== null && (m as { id?: unknown }).id === modelId);
    const prompt = Number(model?.pricing?.['prompt']);
    const completion = Number(model?.pricing?.['completion']);
    if (Number.isFinite(prompt) && Number.isFinite(completion)) pricing = { prompt, completion };
  } catch {
    // Offline or rate limited; fall through to null and retry after the TTL.
  }

  pricingCache.set(modelId, { value: pricing, expiresAt: Date.now() + PRICING_TTL_MS });
  return pricing;
}

/** Remaining credit on the account behind `apiKey`, or null if unavailable. */
export async function getAccountBalance(baseUrl: string | null, apiKey: string): Promise<AccountBalance | null> {
  if (!isOpenRouter(baseUrl)) return null;
  if (balanceCache && Date.now() < balanceCache.expiresAt) return balanceCache.value;

  let balance: AccountBalance | null = null;
  try {
    const body = await getJson('https://openrouter.ai/api/v1/credits', {
      authorization: `Bearer ${apiKey}`,
    }) as { data?: { total_credits?: unknown; total_usage?: unknown } };
    const totalCreditsUsd = Number(body.data?.total_credits);
    const totalUsageUsd = Number(body.data?.total_usage);
    if (Number.isFinite(totalCreditsUsd) && Number.isFinite(totalUsageUsd)) {
      balance = { totalCreditsUsd, totalUsageUsd, remainingUsd: totalCreditsUsd - totalUsageUsd };
    }
  } catch {
    // A balance we cannot read must not block a run; the provider still enforces it.
  }

  balanceCache = { value: balance, expiresAt: Date.now() + BALANCE_TTL_MS };
  return balance;
}

export function formatUsd(amount: number): string {
  return amount >= 0.01 || amount === 0 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(4)}`;
}

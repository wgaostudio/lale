export class BudgetExceededError extends Error {}

/** USD per token, as published by the provider. */
export interface TokenPricing {
  prompt: number;
  completion: number;
}

/**
 * A runaway-loop guard, not a cost control — the token cap is what bounds spend.
 * It has to clear the longest legitimate run by a margin, or it stops a run the
 * budget could well have afforded. The `proofSkeleton` mode sets the ceiling:
 * segmentation admits up to 20 steps, and a step costs up to two statement
 * attempts plus two proof attempts, on top of the dozen calls the stages before
 * it make. At 24 — which is what this was — a proof of more than about six steps
 * could not finish.
 */
const DEFAULT_MAX_CALLS = 120;

/** Shared across every model request, including repair attempts. */
export class RunBudget {
  calls = 0;
  /** Set when the provider's prices are known; tokens are tracked regardless. */
  pricing: TokenPricing | null = null;

  constructor(readonly cap: number, public inputTokens = 0, public outputTokens = 0, readonly maxCalls = DEFAULT_MAX_CALLS) {
    if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error('Invalid run token budget');
  }

  /**
   * Spend so far in USD, or null when prices are unknown. Reserved-but-unsettled
   * tokens are included, so this never reads lower than what has been incurred.
   */
  get spentUsd(): number | null {
    if (!this.pricing) return null;
    return this.inputTokens * this.pricing.prompt + this.outputTokens * this.pricing.completion;
  }

  /** What the remaining token budget would cost if it all went to output. */
  get remainingWorstCaseUsd(): number | null {
    if (!this.pricing) return null;
    const remaining = Math.max(0, this.cap - this.inputTokens - this.outputTokens);
    return remaining * this.pricing.completion;
  }
  reserve(input: number, desiredOutput: number): number {
    const remaining = this.cap - this.inputTokens - this.outputTokens - input;
    if (this.calls >= this.maxCalls || remaining < Math.min(desiredOutput, 4096)) {
      throw new BudgetExceededError('Run budget exhausted before the next request');
    }
    const output = Math.min(remaining, desiredOutput);
    this.calls++;
    // Unknown usage, including lost responses after billing, stays charged.
    this.inputTokens += input;
    this.outputTokens += output;
    return output;
  }
  settle(inputReserved: number, outputReserved: number, input: number, output: number): void {
    if (![input, output].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid provider usage');
    this.inputTokens += input - inputReserved;
    this.outputTokens += output - outputReserved;
    if (this.inputTokens + this.outputTokens > this.cap) throw new BudgetExceededError('Provider usage exceeded the run budget');
  }
}

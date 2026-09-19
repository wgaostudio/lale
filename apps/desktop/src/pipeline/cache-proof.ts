import { sameObligation, type LeanRunner } from '@lale/lean-runner';
import type { FormalizeResult } from './formalize.js';
import { composeLeanFile } from './formalize.js';

/** Cache data is untrusted input. A stale/malformed candidate is a miss. */
export async function validateCachedProof(serialized: string | null, frozen: FormalizeResult,
  declarations: string, runner: LeanRunner): Promise<string | null> {
  if (!serialized) return null;
  try {
    const source: unknown = JSON.parse(serialized);
    if (typeof source !== 'string' || !sameObligation(frozen.leanSource, source, frozen.theoremName)) return null;
    const checked = await runner.check(composeLeanFile(declarations, source), { declarationName: frozen.theoremName });
    return checked.status === 'ok' && checked.certificate?.normalizedGoalTerm === frozen.normalizedGoalTerm ? source : null;
  } catch { return null; }
}

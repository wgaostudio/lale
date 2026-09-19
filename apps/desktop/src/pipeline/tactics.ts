import { LeanRunner, fillObligation, parseObligation } from '@lale/lean-runner';
import { composeLeanFile } from './formalize.js';

// ---------------------------------------------------------------------------
// Tactic ladder
//
// Lean's own automation is tried before any model call. A rung costs seconds of
// CPU; a generation costs on the order of a dollar, so a goal that `norm_num`
// closes should never reach the model. Ordered cheapest and most likely first.
// ---------------------------------------------------------------------------

export const TACTIC_LADDER = [
  'rfl',
  'decide',
  'omega',
  'norm_num',
  'simp_all',
  'positivity',
  'linarith',
  'aesop',
];

/**
 * Past this size the ladder is skipped. These tactics close goals that are
 * arithmetic or finite case analysis; a proposition this large is neither, and
 * running eight Lean checks against it only spends minutes to learn that.
 */
const LADDER_MAX_PROPOSITION_CHARS = 2000;

export interface LadderSuccess {
  closedBy: string;
  leanSource: string;
}

/**
 * Tries each tactic against `obligationSource`, returning the first that closes
 * it under Lean's kernel, or null. `availableDeclarations` carries dependency
 * declarations and any lemmas already established.
 */
export async function tryTacticLadder(
  runner: LeanRunner,
  obligationSource: string,
  theoremName: string,
  availableDeclarations: string,
): Promise<LadderSuccess | null> {
  let proposition: string;
  try {
    proposition = parseObligation(obligationSource, theoremName).proposition;
  } catch {
    return null;
  }
  if (proposition.length > LADDER_MAX_PROPOSITION_CHARS) return null;

  for (const tactic of TACTIC_LADDER) {
    let candidate: string;
    try {
      candidate = fillObligation(obligationSource, tactic, theoremName);
    } catch {
      return null;
    }
    const result = await runner.check(
      composeLeanFile(availableDeclarations, candidate),
      { declarationName: theoremName },
    );
    if (result.status === 'ok' && result.certificate) {
      return { closedBy: tactic, leanSource: candidate };
    }
  }
  return null;
}

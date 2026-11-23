import {
  LEAN_UNAVAILABLE,
  fillObligation,
  isLeanDeclarationName,
  parseObligation,
  scanTrustViolations,
  stripLeanCommentsAndStrings,
  type LeanCheckResult,
  type LeanRunner,
} from '@lale/lean-runner';
import type { ChatToolSpec } from '@lale/translator';
import { formatDiagnostics, locate, type Workspace } from './workspace.js';
import { loadDeclarationIndex, searchDeclarations } from './mathlib-search.js';

// ---------------------------------------------------------------------------
// Agent tools
//
// Typed tools, not a shell. The service runs on the author's own machine, and
// the only thing the agent can do to it is write Lean into the workspace and
// ask the existing runner — with its trust scan, import allowlist and kernel
// certificate — to elaborate it. Everything here is advisory except `submit`,
// whose gate is the one place a proof is accepted.
// ---------------------------------------------------------------------------

export const MAX_TOOL_OUTPUT_CHARS = 12_000;
const MAX_LOOKUP_NAMES = 20;

export interface ToolContext {
  workspace: Workspace;
  runner: LeanRunner;
  checkTimeoutMs: number;
  /** Root holding Mathlib's `Mathlib/` sources, or null when search is unavailable. */
  mathlibRoot: string | null;
  /** Tools this agent was offered; a call to any other is refused. Default: all. */
  allowedTools?: ReadonlySet<string>;
  /** Extra conditions on an accepted proof (composition mode). */
  gateConstraints?: GateConstraints;
  /**
   * The kernel's rendering of `¬ P`, elaborated once without the helper
   * files, so a refutation is held to the statement as frozen.
   */
  refutationGoal?: string;
}

export interface GateConstraints {
  /** Reject a proof body longer than this many non-blank lines. */
  maxProofLines?: number;
  /** Reject when the workspace holds any helper file. */
  noHelperFiles?: boolean;
  /** Reject any automation tactic: the proof may only combine what is in scope. */
  glueOnly?: boolean;
}

/**
 * Tactics that prove new mathematics on their own. A composition that uses one
 * is supplying a piece of the argument the author's steps did not, which is
 * exactly the gap composition is there to find. Matched anywhere in the proof,
 * nested `by` blocks included, outside comments and strings.
 */
const AUTOMATION_TACTICS = [
  'simp', 'simp_all', 'simpa', 'dsimp', 'simp_arith', 'norm_num', 'norm_cast', 'push_cast', 'omega', 'linarith',
  'nlinarith', 'polyrith', 'positivity', 'aesop', 'decide', 'ring', 'ring_nf', 'field_simp', 'tauto', 'itauto',
  'gcongr', 'grind', 'linear_combination', 'abel', 'noncomm_ring', 'interval_cases', 'fin_cases', 'induction',
  'induction\'', 'exact?', 'apply?', 'rw?', 'simp?', 'hint', 'library_search', 'continuity', 'measurability',
  'fun_prop', 'bv_decide', 'nlinarith!', 'linarith!', 'slim_check', 'plausible',
];

export function findAutomationTactics(proof: string): string[] {
  const code = stripLeanCommentsAndStrings(proof);
  const found = new Set<string>();
  for (const tactic of AUTOMATION_TACTICS) {
    const escaped = tactic.replace(/[.*+?^${}()|[\]\\']/g, '\\$&');
    // Not part of a longer name, and not a qualified lemma name (Nat.decide_eq).
    if (new RegExp(`(?<![\\w.'])${escaped}(?![\\w'])`).test(code)) found.add(tactic);
  }
  return [...found];
}

/** File-writing tools; composition mode is offered none of them. */
export const HELPER_FILE_TOOLS = ['write_file', 'edit_file', 'read_file', 'delete_file', 'reorder_files'] as const;

export function toolsFor(allowed: ReadonlySet<string> | undefined): ChatToolSpec[] {
  return allowed ? AGENT_TOOLS.filter((t) => allowed.has(t.name)) : AGENT_TOOLS;
}

export type ToolControl =
  | { kind: 'continue' }
  | { kind: 'accepted'; leanSource: string }
  | { kind: 'giveUp'; report: string }
  | { kind: 'refuted'; leanSource: string; explanation: string }
  | { kind: 'environmentFault'; message: string };

export interface ToolOutcome {
  content: string;
  control: ToolControl;
}

const CONTINUE: ToolControl = { kind: 'continue' };

export const AGENT_TOOLS: ChatToolSpec[] = [
  {
    name: 'write_file',
    description: 'Create or overwrite a helper Lean file. Files are concatenated in order ahead of the theorem, so later files can use earlier ones. A new file goes last unless `after` names the file it should follow. Leading `import` lines are hoisted. Close every namespace/section you open.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'e.g. Growth.lean or Capacity/Defect.lean' },
        content: { type: 'string' },
        after: { type: 'string', description: 'Optional: existing file to place a NEW file after.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace one exact, unique occurrence of old_text in a helper file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a helper file with line numbers.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'delete_file',
    description: 'Delete a helper file (e.g. an abandoned approach).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'reorder_files',
    description: 'Set the concatenation order. Must list every helper file exactly once.',
    parameters: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } } },
      required: ['paths'],
    },
  },
  {
    name: 'set_proof',
    description: 'Set the tactic block that proves the frozen theorem (the text after `:= by`). You cannot change the statement itself.',
    parameters: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
  },
  {
    name: 'check',
    description: 'Elaborate the workspace with Lean. `sorry` is allowed here and reported, so you can scaffold. With `up_to`, checks only the helper files through that one (faster). Without it, also checks the theorem.',
    parameters: { type: 'object', properties: { up_to: { type: 'string' } } },
  },
  {
    name: 'probe',
    description: 'Elaborate scratch Lean after all helper files, without changing the workspace. Use it to test a lemma statement, inspect goals with `trace_state`, or ask `exact?`, `apply?`, `rw?`, `simp?` for suggestions (in an `example`). `sorry` allowed; #commands are not (use lookup).',
    parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  },
  {
    name: 'lookup',
    description: 'Print the exact types of up to 20 constants (Mathlib or your helpers), like #check.',
    parameters: {
      type: 'object',
      properties: { names: { type: 'array', items: { type: 'string' } } },
      required: ['names'],
    },
  },
  {
    name: 'search_mathlib',
    description: 'Find Mathlib declarations whose name or signature contains ALL the given literal terms (case-insensitive). Returns file:line and the declaration head.',
    parameters: {
      type: 'object',
      properties: {
        terms: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['terms'],
    },
  },
  {
    name: 'submit',
    description: 'Run the final clean-room check: no sorry, standard axioms only, the frozen statement unchanged. On success the run ends verified. On failure you get the reason and may continue.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'refute',
    description: 'Prove that the frozen statement is FALSE: give a tactic proof of its negation ¬ P. The harness builds the negated theorem from the frozen statement itself; your helper files may be used. If Lean accepts it under the same clean-room rules, the statement is certified false and the run ends. Use this as soon as you have a counterexample.',
    parameters: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Tactic block proving ¬ P (after `:= by`).' },
        explanation: { type: 'string', description: 'The counterexample or reason, in a sentence or two, for the author.' },
      },
      required: ['body', 'explanation'],
    },
  },
  {
    name: 'give_up',
    description: 'End the run without a proof. Report precisely what you proved, what remains, and why. May be refused if budget remains; if so, try a genuinely different approach.',
    parameters: { type: 'object', properties: { report: { type: 'string' } }, required: ['report'] },
  },
];

function cap(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…[truncated ${text.length - MAX_TOOL_OUTPUT_CHARS} chars]`
    : text;
}

function ok(content: string): ToolOutcome {
  return { content: cap(content), control: CONTINUE };
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`Argument "${key}" must be a string.`);
  return value;
}

function strArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error(`Argument "${key}" must be an array of strings.`);
  return value as string[];
}

export function workspaceSummary(ws: Workspace): string {
  const files = ws.paths.map((p) => `${p} (${ws.read(p)!.split('\n').length} lines)`);
  return `Files: ${files.join(', ') || '(none)'}; proof: ${ws.proof.trim() ? `${ws.proof.split('\n').length} lines` : '(not set)'}`;
}

/**
 * The Lean runner signals an environment fault (no toolchain, harness I/O)
 * with `blocked`, the same status a trust violation gets. Only the former
 * should stop the run; the latter is the agent's to fix.
 */
export function isEnvironmentFault(result: LeanCheckResult): boolean {
  return result.status === 'blocked'
    && result.trustViolations.length === 0
    && result.diagnostics.some((d) => d.message.startsWith(LEAN_UNAVAILABLE) || /Lean harness error/.test(d.message));
}

function sorryLocations(result: LeanCheckResult, segments: ReturnType<Workspace['compose']>['segments']): string[] {
  return result.diagnostics
    .filter((d) => /declaration uses 'sorry'/.test(d.message))
    .map((d) => locate(segments, d.line));
}

export async function executeTool(ctx: ToolContext, name: string, rawArguments: string): Promise<ToolOutcome> {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = rawArguments.trim() ? JSON.parse(rawArguments) : {};
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    args = parsed as Record<string, unknown>;
  } catch {
    return ok(`Error: arguments for ${name} are not a JSON object.`);
  }

  const ws = ctx.workspace;
  if (ctx.allowedTools && !ctx.allowedTools.has(name)) {
    return ok(`Error: ${name} is not available in this run. Available: ${[...ctx.allowedTools].join(', ')}.`);
  }
  try {
    switch (name) {
      case 'write_file': {
        const after = args['after'];
        ws.write(str(args, 'path'), str(args, 'content'), typeof after === 'string' && after ? after : undefined);
        return ok(`Wrote ${str(args, 'path')}. ${workspaceSummary(ws)}`);
      }
      case 'edit_file':
        ws.edit(str(args, 'path'), str(args, 'old_text'), str(args, 'new_text'));
        return ok(`Edited ${str(args, 'path')}.`);
      case 'read_file': {
        const content = ws.read(str(args, 'path'));
        if (content === undefined) return ok(`No file "${str(args, 'path')}". ${workspaceSummary(ws)}`);
        return ok(content.split('\n').map((line, i) => `${String(i + 1).padStart(4)}  ${line}`).join('\n'));
      }
      case 'delete_file':
        ws.delete(str(args, 'path'));
        return ok(`Deleted ${str(args, 'path')}. ${workspaceSummary(ws)}`);
      case 'reorder_files':
        ws.reorder(strArray(args, 'paths'));
        return ok(`Order: ${ws.paths.join(', ')}`);
      case 'set_proof':
        ws.setProof(str(args, 'body'));
        return ok('Proof body set. Run check to elaborate it.');
      case 'check':
        return await check(ctx, typeof args['up_to'] === 'string' && args['up_to'] ? args['up_to'] : undefined);
      case 'probe':
        return await probe(ctx, str(args, 'code'));
      case 'lookup':
        return await lookup(ctx, strArray(args, 'names'));
      case 'search_mathlib':
        return await search(ctx, strArray(args, 'terms'), typeof args['limit'] === 'number' ? args['limit'] : undefined);
      case 'submit':
        return await submit(ctx);
      case 'refute':
        return await refute(ctx, str(args, 'body'), str(args, 'explanation').trim());
      case 'give_up': {
        const report = str(args, 'report').trim();
        if (!report) return ok('Error: the report must say what was and was not proved.');
        return { content: 'Give-up request received.', control: { kind: 'giveUp', report } };
      }
      default:
        return ok(`Error: unknown tool "${name}".`);
    }
  } catch (error) {
    return ok(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function check(ctx: ToolContext, upTo: string | undefined): Promise<ToolOutcome> {
  const composition = ctx.workspace.compose(upTo === undefined ? {} : { upTo });
  const result = await ctx.runner.check(composition.source, {
    allowTrustViolations: ['sorry'],
    wallClockCapMs: ctx.checkTimeoutMs,
  });
  if (isEnvironmentFault(result)) return fault(result);
  const sorries = sorryLocations(result, composition.segments);
  const errors = result.diagnostics.filter((d) => d.kind === 'error').length;
  const lines = [
    `Status: ${result.status}${result.status === 'ok' ? '' : ` (${errors} error${errors === 1 ? '' : 's'})`} in ${Math.round(result.elapsedMs / 100) / 10}s`,
    sorries.length ? `sorry at: ${sorries.join(', ')}` : 'No sorry.',
    upTo === undefined && result.status === 'ok' && sorries.length === 0 && ctx.workspace.proof.trim()
      ? 'This looks ready to submit.'
      : '',
    formatDiagnostics(result.diagnostics.filter((d) => !/declaration uses 'sorry'/.test(d.message)), composition.segments),
  ];
  return ok(lines.filter(Boolean).join('\n'));
}

async function probe(ctx: ToolContext, code: string): Promise<ToolOutcome> {
  if (!code.trim()) return ok('Error: empty probe.');
  const composition = ctx.workspace.compose({ suffix: code });
  const result = await ctx.runner.check(composition.source, {
    allowTrustViolations: ['sorry'],
    wallClockCapMs: ctx.checkTimeoutMs,
  });
  if (isEnvironmentFault(result)) return fault(result);
  const probeSegment = composition.segments.find((s) => s.label === '<probe>');
  const inProbe = result.diagnostics.filter((d) =>
    d.line === undefined || !probeSegment
    || (d.line >= probeSegment.startLine && d.line < probeSegment.startLine + Math.max(1, probeSegment.lineCount)));
  const elsewhere = result.diagnostics.length - inProbe.length;
  return ok([
    `Status: ${result.status}`,
    elsewhere ? `(${elsewhere} diagnostics from helper files omitted; run check to see them)` : '',
    formatDiagnostics(inProbe, composition.segments),
  ].filter(Boolean).join('\n'));
}

async function lookup(ctx: ToolContext, names: string[]): Promise<ToolOutcome> {
  const valid = [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, MAX_LOOKUP_NAMES);
  const rejected = valid.filter((n) => !isLeanDeclarationName(n));
  const accepted = valid.filter((n) => isLeanDeclarationName(n));
  if (accepted.length === 0) return ok(`Error: no valid constant names${rejected.length ? ` (rejected: ${rejected.join(', ')})` : ''}.`);

  // The `#check` lines are harness-written from validated names, so `#` is
  // permitted for this run — but only after the agent's own text has passed
  // the full scan on its own, so the allowance cannot extend to it.
  const agentPart = ctx.workspace.compose({ includeTheorem: false });
  const agentViolations = scanTrustViolations(agentPart.source).filter((v) => v.name !== 'sorry');
  if (agentViolations.length) {
    return ok(`Error: helper files violate the trust policy (${agentViolations.map((v) => v.name).join(', ')}); fix them first.`);
  }
  const suffix = accepted.map((n) => `#check @${n}`).join('\n');
  const composition = ctx.workspace.compose({ suffix });
  const result = await ctx.runner.check(composition.source, {
    allowTrustViolations: ['sorry', 'commands'],
    wallClockCapMs: ctx.checkTimeoutMs,
  });
  if (isEnvironmentFault(result)) return fault(result);
  const probeSegment = composition.segments.find((s) => s.label === '<probe>')!;
  const out = accepted.map((n, i) => {
    const line = probeSegment.startLine + i;
    const hits = result.diagnostics.filter((d) => d.line === line).map((d) => d.message.trim());
    return `${n}: ${hits.join(' | ') || '(no output)'}`;
  });
  if (rejected.length) out.push(`Rejected (not constant names): ${rejected.join(', ')}`);
  return ok(out.join('\n'));
}

async function search(ctx: ToolContext, terms: string[], limit: number | undefined): Promise<ToolOutcome> {
  if (!ctx.mathlibRoot) return ok('Mathlib search is unavailable in this environment; use lookup and probe with exact?.');
  let index;
  try {
    index = await loadDeclarationIndex(ctx.mathlibRoot);
  } catch (error) {
    return ok(`Mathlib search is unavailable: ${String(error)}`);
  }
  const hits = searchDeclarations(index, terms, limit);
  if (hits.length === 0) return ok('No declarations contain all of those terms. Try fewer or more general terms.');
  return ok(hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join('\n'));
}

function fault(result: LeanCheckResult): ToolOutcome {
  const message = result.diagnostics.map((d) => d.message).join('\n');
  return { content: `Lean is unavailable: ${message}`, control: { kind: 'environmentFault', message } };
}

export interface GateVerdict {
  accepted: boolean;
  reason: string;
  leanSource: string | null;
  environmentFault: boolean;
}

/**
 * The clean-room check. Strictly the runner's defaults — no trust allowances —
 * plus three conditions of its own: a proof was given, the frozen header occurs
 * verbatim in what was checked, and the kernel's rendering of the theorem's
 * type equals the one recorded when the statement was frozen. The last is what
 * catches a helper file that changes how the statement elaborates (a new
 * instance, an `open`, a shadowing definition): the text is the same, the
 * proposition is not.
 */
export async function finalGate(
  ws: Workspace,
  runner: LeanRunner,
  checkTimeoutMs: number,
  constraints: GateConstraints = {},
): Promise<GateVerdict> {
  const reject = (reason: string): GateVerdict => ({ accepted: false, reason, leanSource: null, environmentFault: false });
  if (!ws.proof.trim()) return reject('No proof body is set; call set_proof first.');
  if (constraints.noHelperFiles && ws.paths.length > 0) {
    return reject('Rejected: this proof must use no helper files.');
  }
  const proofLines = ws.proof.split('\n').filter((line) => line.trim()).length;
  if (constraints.maxProofLines !== undefined && proofLines > constraints.maxProofLines) {
    return reject(`Rejected: the proof is ${proofLines} lines; at most ${constraints.maxProofLines} are allowed here. A longer argument means the steps do not yet carry the proof.`);
  }
  if (constraints.glueOnly) {
    const automation = findAutomationTactics(ws.proof);
    if (automation.length) {
      return reject(`Rejected: ${automation.join(', ')} prove${automation.length === 1 ? 's' : ''} new mathematics, and here the theorem must follow from the steps by logic alone (intro, exact, apply, refine, obtain, rcases, constructor, use, have, specialize, assumption, rfl). If the steps need more to reach the theorem, that is a gap in the argument: give_up and say what is missing.`);
    }
  }

  const composition = ws.compose();
  const headerText = parseObligation(ws.frozen.leanSource, ws.frozen.theoremName).header
    .split('\n').filter((line) => !/^\s*import\s/.test(line)).join('\n').trim();
  if (!composition.source.includes(headerText)) return reject('The frozen statement is not present verbatim.');

  const result = await runner.check(composition.source, {
    declarationName: ws.frozen.theoremName,
    wallClockCapMs: checkTimeoutMs,
  });
  if (isEnvironmentFault(result)) {
    return { accepted: false, reason: result.diagnostics.map((d) => d.message).join('\n'), leanSource: null, environmentFault: true };
  }
  if (result.status !== 'ok') {
    const violations = result.trustViolations.map((v) => v.name);
    return reject([
      `Rejected (${result.status}).`,
      violations.length ? `Trust policy: ${violations.join(', ')}.` : '',
      // The runner prepends one line (`import Lean`) when certifying.
      formatDiagnostics(result.diagnostics.map((d) => (d.line === undefined ? d : { ...d, line: d.line - 1 })), composition.segments),
    ].filter(Boolean).join('\n'));
  }
  if (!result.certificate) return reject('Rejected: no kernel certificate for the theorem.');
  if (result.certificate.normalizedGoalTerm !== ws.frozen.normalizedGoalTerm) {
    return reject('Rejected: the theorem elaborates to a different proposition than the frozen statement. A helper file changes how the statement is read (an instance, open, notation, or a definition shadowing a name it uses). Remove that interference.');
  }
  return { accepted: true, reason: 'Accepted.', leanSource: ws.acceptedSource(), environmentFault: false };
}

/**
 * The refutation gate: the same clean-room rules as `finalGate`, applied to
 * `¬ P`. The negated theorem is built from the frozen statement, and its
 * kernel rendering must equal `¬ P` as elaborated without the helper files.
 */
async function refute(ctx: ToolContext, body: string, explanation: string): Promise<ToolOutcome> {
  if (!body.trim()) return ok('Error: empty refutation.');
  if (!explanation) return ok('Error: say what the counterexample is.');
  const ws = ctx.workspace;
  const header = ws.refutationHeader();

  if (ctx.refutationGoal === undefined) {
    const bare = ws.compose({ includeTheorem: true, theoremText: header.text, omitFiles: true });
    const elaborated = await ctx.runner.check(bare.source, {
      allowTrustViolations: ['sorry'], declarationName: header.name, wallClockCapMs: ctx.checkTimeoutMs,
    });
    if (isEnvironmentFault(elaborated)) return fault(elaborated);
    if (elaborated.status !== 'ok' || !elaborated.certificate) {
      return ok(`The negated statement did not elaborate, so it cannot be refuted here: ${elaborated.diagnostics.map((d) => d.message).join('; ').slice(0, 800)}`);
    }
    ctx.refutationGoal = elaborated.certificate.normalizedGoalTerm;
  }

  let filled: string;
  try {
    filled = fillObligation(header.text, body, header.name);
  } catch (error) {
    return ok(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
  const composition = ws.compose({ includeTheorem: true, theoremText: filled });
  const result = await ctx.runner.check(composition.source, { declarationName: header.name, wallClockCapMs: ctx.checkTimeoutMs });
  if (isEnvironmentFault(result)) return fault(result);
  if (result.status !== 'ok' || !result.certificate) {
    const violations = result.trustViolations.map((v) => v.name);
    return ok([
      `Refutation rejected (${result.status}).`,
      violations.length ? `Trust policy: ${violations.join(', ')}.` : '',
      formatDiagnostics(result.diagnostics.map((d) => (d.line === undefined ? d : { ...d, line: d.line - 1 })), composition.segments),
    ].filter(Boolean).join('\n'));
  }
  if (result.certificate.normalizedGoalTerm !== ctx.refutationGoal) {
    return ok('Refutation rejected: with your helper files, the negated statement elaborates differently than the frozen one. Remove that interference.');
  }
  return {
    content: 'Refuted: Lean accepts the negation of the frozen statement.',
    control: {
      kind: 'refuted',
      explanation,
      leanSource: ws.compose({ includeTheorem: true, theoremText: filled, includeDependencies: false }).source,
    },
  };
}

async function submit(ctx: ToolContext): Promise<ToolOutcome> {
  const verdict = await finalGate(ctx.workspace, ctx.runner, ctx.checkTimeoutMs, ctx.gateConstraints);
  if (verdict.environmentFault) return { content: `Lean is unavailable: ${verdict.reason}`, control: { kind: 'environmentFault', message: verdict.reason } };
  if (verdict.accepted) return { content: 'Accepted by the clean-room check.', control: { kind: 'accepted', leanSource: verdict.leanSource! } };
  return ok(verdict.reason);
}

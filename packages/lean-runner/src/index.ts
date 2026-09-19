import { spawn } from 'node:child_process';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, totalmem } from 'node:os';
import { randomUUID } from 'node:crypto';
export {
  parseObligation,
  fillObligation,
  sameObligation,
  equivalenceObligation,
  fillEquivalence,
} from './obligation.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeanDiagnostic {
  kind: 'error' | 'warning' | 'info';
  message: string;
  line?: number;
  column?: number;
}

export interface TrustViolation {
  name: string;
}

export interface LeanCheckResult {
  status: 'ok' | 'error' | 'timeout' | 'blocked';
  diagnostics: LeanDiagnostic[];
  trustViolations: TrustViolation[];
  elapsedMs: number;
  stdout: string;
  stderr: string;
  certificate?: { declarationName: string; normalizedGoalTerm: string; axioms: string[] };
}

export interface LeanRunnerConfig {
  projectDir: string;
  wallClockCapMs?: number;
  memoryCap?: string;
  outputCapBytes?: number;
  command?: string;
  commandArgs?: string[];
}

export interface LeanCheckOptions {
  allowTrustViolations?: string[];
  declarationName?: string;
}

// ---------------------------------------------------------------------------
// Trust policy — static scan before execution
// ---------------------------------------------------------------------------

const TRUST_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'sorry', pattern: /\bsorry\b/ },
  { name: 'admit', pattern: /\badmit\b/ },
  { name: 'unsafe', pattern: /\bunsafe\b/ },
  { name: '#eval', pattern: /#eval\b/ },
  { name: 'native_decide', pattern: /\bnative_decide\b/ },
  { name: 'IO', pattern: /\bIO\b/ },
  { name: 'custom-axiom', pattern: /\baxiom\b/ },
  { name: 'opaque', pattern: /\bopaque\b/ },
  {
    // Anything that can run at elaboration time, reach outside the kernel, or
    // name the kernel's own escape hatches.
    name: 'metaprogramming',
    pattern: new RegExp(
      '\\b(?:'
      + ['run_tac', 'run_elab', 'run_cmd', 'elab', 'elab_rules', 'macro', 'macro_rules',
         'syntax', 'initialize', 'builtin_initialize', 'implemented_by', 'extern', 'Lean',
         'eval_expr', 'ofReduceBool', 'ofReduceNat', 'sorryAx'].join('|')
      + ')\\b',
    ),
  },
  // `#` covers every `#command`, including ones Lean has not shipped yet.
  { name: 'commands', pattern: /#|\b(?:set_option|attribute)\b/ },
  // `«...»` can spell a name the plain-identifier rules above would reject.
  { name: 'quoted-identifiers', pattern: /[«»]/ },
];

/** Only Lean's own libraries and Mathlib. Anything else is unvetted source. */
const APPROVED_IMPORT = /^(?:Mathlib|Std|Init)(?:\.[A-Za-z0-9_]+)*$/;

export function scanTrustViolations(source: string): TrustViolation[] {
  const codeOnlySource = stripLeanCommentsAndStrings(source);
  return TRUST_PATTERNS
    .filter(({ pattern }) => pattern.test(codeOnlySource))
    .map(({ name }) => ({ name }));
}

export function stripLeanCommentsAndStrings(source: string): string {
  let result = '';
  let index = 0;
  let blockCommentDepth = 0;

  while (index < source.length) {
    const current = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (blockCommentDepth > 0) {
      if (current === '/' && next === '-') {
        blockCommentDepth += 1;
        result += '  ';
        index += 2;
        continue;
      }
      if (current === '-' && next === '/') {
        blockCommentDepth -= 1;
        result += '  ';
        index += 2;
        continue;
      }
      result += current === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }

    if (current === '-' && next === '-') {
      result += '  ';
      index += 2;
      while (index < source.length && source[index] !== '\n') {
        result += ' ';
        index += 1;
      }
      continue;
    }

    if (current === '/' && next === '-') {
      blockCommentDepth = 1;
      result += '  ';
      index += 2;
      continue;
    }

    if (current === '"') {
      let closed = false;
      result += ' ';
      index += 1;
      while (index < source.length) {
        const ch = source[index] ?? '';
        if (ch === '\\') {
          result += ' ';
          if (index + 1 < source.length) result += source[index + 1] === '\n' ? '\n' : ' ';
          index += 2;
          continue;
        }
        result += ch === '\n' ? '\n' : ' ';
        index += 1;
        if (ch === '"') { closed = true; break; }
      }
      if (!closed) throw new Error('Unterminated Lean string');
      continue;
    }

    result += current;
    index += 1;
  }

  if (blockCommentDepth > 0) throw new Error('Unterminated Lean comment');
  return result;
}

// ---------------------------------------------------------------------------
// Diagnostic parser
// ---------------------------------------------------------------------------

// Preserve multiline goals and Windows paths. Never infer success from output alone.
// A Lean name: `.`-joined components, each starting with a Unicode letter or
// `_`. Admitting no quote or backslash is a security property, not a style
// choice — the name is interpolated into harness-owned Lean source below.
const LEAN_NAME_PART = String.raw`[\p{L}_][\p{L}\p{N}_']*`;
const LEAN_DECLARATION_NAME = new RegExp(`^${LEAN_NAME_PART}(?:\\.${LEAN_NAME_PART})*$`, 'u');

export function isLeanDeclarationName(name: string): boolean {
  return name.length <= 200 && LEAN_DECLARATION_NAME.test(name);
}

const LEAN_SIMPLE_NAME = new RegExp(`^${LEAN_NAME_PART}$`, 'u');

/**
 * An unqualified name — no dots. Theorem names stay atomic because the
 * obligation parser matches a single identifier after `theorem`, so a namespaced
 * one would fail to parse later instead of being rejected here.
 */
export function isLeanSimpleName(name: string): boolean {
  return name.length <= 200 && LEAN_SIMPLE_NAME.test(name);
}

// elan's installer only appends to the shell profile, so a desktop started
// from a shell that predates provisioning — or from a GUI launcher — inherits a
// PATH without it and every check dies with `spawn lake ENOENT`. The health
// probe and the provisioner both resolve it this way; the runner must match, or
// the UI reports Lean as available while every run fails.
const ELAN_BIN_DIR = join(homedir(), '.elan', 'bin');

// `import Mathlib` — which the formalizer prompt tells the model to use when
// unsure — needs more than 4 GB to elaborate: measured around 6 GB against
// Mathlib v4.33.1, where 4 GB aborts with `lean::memory_exception`. `-M` is a
// ceiling rather than an allocation, but stay under half of RAM so a smaller
// machine gets a clean Lean error instead of swapping.
function defaultMemoryCapKb(): string {
  const halfRamKb = Math.floor(totalmem() / 2 / 1024);
  return String(Math.max(4 * 1024 * 1024, Math.min(8 * 1024 * 1024, halfRamKb)));
}

function leanSpawnEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/API_KEY|TOKEN|SECRET|PASSWORD/i.test(key)),
  );
  const parts = (env['PATH'] ?? '').split(':').filter(Boolean);
  if (!parts.includes(ELAN_BIN_DIR)) parts.unshift(ELAN_BIN_DIR);
  env['PATH'] = parts.join(':');
  return env;
}

// `<path>:<line>:<col>: <kind>: <message>`. The leading `.*?` is lazy so a
// Windows drive letter does not eat the line number.
const DIAGNOSTIC_LINE = /^.*?:(\d+):(\d+): (error|warning|info): ?(.*)$/;

export function parseDiagnostics(output: string): LeanDiagnostic[] {
  const diagnostics: LeanDiagnostic[] = [];

  for (const line of output.split(/\r?\n/)) {
    const match = DIAGNOSTIC_LINE.exec(line);
    if (match) {
      diagnostics.push({
        kind: match[3] as LeanDiagnostic['kind'],
        message: match[4] ?? '',
        line: Number(match[1]),
        column: Number(match[2]),
      });
      continue;
    }

    // A goal state spans many lines and only the first carries a location, so
    // unlabelled text belongs to the diagnostic above it.
    const previous = diagnostics[diagnostics.length - 1];
    if (line.trim() && previous) previous.message += `\n${line}`;
  }

  return diagnostics;
}

export class LeanRunner {
  private readonly wallClockCapMs: number;
  private readonly outputCapBytes: number;

  constructor(private readonly config: LeanRunnerConfig) {
    this.wallClockCapMs = config.wallClockCapMs ?? 60_000;
    this.outputCapBytes = config.outputCapBytes ?? 1_000_000;
    // Interpolated into an argv entry below, so it admits digits and nothing else.
    if (config.memoryCap && !/^\d+$/.test(config.memoryCap)) throw new Error('Invalid memory cap');
  }

  /**
   * Checks one piece of Lean source, and is the only place untrusted source
   * reaches a toolchain. Three gates stand in front of that, in order: the
   * static trust scan, the import allowlist, and — once Lean has run — the
   * kernel certificate, which is what turns "Lean exited 0" into "Lean proved
   * this goal from these axioms". Every one of them fails closed.
   */
  async check(source: string, options: LeanCheckOptions = {}): Promise<LeanCheckResult> {
    const violations = this.scanSource(source, options.allowTrustViolations ?? []);
    if (typeof violations === 'string') return blockedResult(violations);
    if (violations.length > 0) {
      return {
        ...blockedResult(`Trust policy violation: ${violations.map((v) => v.name).join(', ')}`),
        trustViolations: violations,
      };
    }

    const name = options.declarationName;
    if (name !== undefined && !isLeanDeclarationName(name)) {
      return blockedResult('Invalid declaration name');
    }

    const nonce = randomUUID();
    const marker = `LALE_CERT_${nonce}:`;
    const checksDir = join(this.config.projectDir, 'Checks');
    const tmpFile = join(checksDir, `check_${nonce}.lean`);

    try {
      await mkdir(checksDir, { recursive: true });
      // The probe is harness-owned and appended only after the scan above, so
      // it cannot be what smuggles something past it.
      const probe = name === undefined ? '' : certificateProbe(name, nonce);
      const preamble = name === undefined ? '' : 'import Lean\n';
      await writeFile(tmpFile, `${preamble}${source}\n${probe}`, 'utf8');

      const result = await this.runLean(tmpFile);
      if (name === undefined || result.status !== 'ok') return result;
      return applyCertificate(result, marker, name, options.allowTrustViolations ?? []);
    } catch (error) {
      return blockedResult(`Lean harness error: ${String(error)}`);
    } finally {
      await unlink(tmpFile).catch(() => undefined);
    }
  }

  /**
   * The trust scan, plus the import allowlist. Returns the violations found, or
   * a message when the source could not be scanned at all — an unterminated
   * comment or string means the scanner cannot say what is code, so nothing is
   * assumed to be safe.
   */
  private scanSource(source: string, allowed: string[]): TrustViolation[] | string {
    try {
      const violations = scanTrustViolations(source).filter((v) => !allowed.includes(v.name));

      const code = stripLeanCommentsAndStrings(source);
      for (const match of code.matchAll(/^\s*import\s+(.+)$/gm)) {
        for (const module of match[1]!.trim().split(/\s+/)) {
          if (!APPROVED_IMPORT.test(module)) {
            violations.push({ name: `unapproved-import:${module}` });
          }
        }
      }

      return violations;
    } catch (error) {
      return String(error);
    }
  }

  private runLean(filePath: string): Promise<LeanCheckResult> {
    const startMs = Date.now();
    const memoryKb = Number(this.config.memoryCap ?? defaultMemoryCapKb());
    const memoryMb = Math.max(1, Math.floor(memoryKb / 1024));
    const args = [
      ...(this.config.commandArgs ?? ['env', 'lean']),
      `-M${memoryMb}`,
      '-DautoImplicit=false',
      '-DmaxHeartbeats=400000',
      filePath,
    ];

    return new Promise((resolve) => {
      const child = spawn(this.config.command ?? 'lake', args, {
        cwd: this.config.projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so `kill` below takes the grandchildren too.
        detached: process.platform !== 'win32',
        env: leanSpawnEnv(),
      });

      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let timedOut = false;
      let outputExceeded = false;
      let spawnError: Error | undefined;

      const kill = (): void => {
        if (child.pid && process.platform !== 'win32') {
          try {
            process.kill(-child.pid, 'SIGKILL');
            return;
          } catch {
            // Group already gone; fall through to the direct kill.
          }
        }
        child.kill('SIGKILL');
      };

      // Output is truncated at the cap rather than dropped, so whatever Lean
      // managed to say before overrunning is still available to diagnose it.
      const append = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
        const remaining = Math.max(0, this.outputCapBytes - bytes);
        bytes += chunk.length;
        const text = chunk.subarray(0, remaining).toString();
        if (stream === 'stdout') stdout += text;
        else stderr += text;
        if (bytes > this.outputCapBytes) {
          outputExceeded = true;
          kill();
        }
      };

      child.stdout.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
      child.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'));

      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, this.wallClockCapMs);

      child.on('error', (error) => { spawnError = error; });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const diagnostics = parseDiagnostics(`${stdout}\n${stderr}`);
        let status: LeanCheckResult['status'] = 'ok';

        if (timedOut) {
          status = 'timeout';
          diagnostics.push({
            kind: 'error',
            message: `Lean timed out after ${this.wallClockCapMs}ms`,
          });
        } else if (spawnError) {
          // The toolchain could not be run at all. That is an environment
          // fault, not a flaw in the checked source, so it is `blocked`:
          // callers stop the run instead of asking the model to try again.
          status = 'blocked';
          diagnostics.push({
            kind: 'error',
            message:
              `Failed to spawn Lean (${spawnError.message}). Check that Lean is provisioned `
              + `and that ${ELAN_BIN_DIR} is readable.`,
          });
        } else if (outputExceeded || signal !== null || code !== 0) {
          status = 'error';
          diagnostics.push({
            kind: 'error',
            message: outputExceeded
              ? 'Lean output limit exceeded'
              : `Lean exited with code ${code}, signal ${signal ?? 'none'}: ${stderr.slice(0, 2000)}`,
          });
        } else if (diagnostics.some((d) => d.kind === 'error')) {
          status = 'error';
        }

        resolve({
          status,
          diagnostics,
          trustViolations: [],
          elapsedMs: Date.now() - startMs,
          stdout,
          stderr,
        });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Kernel certificate
//
// Lean exiting 0 says the file elaborated. It does not say which declaration
// was produced, what goal it has, or what it leans on — a proof can elaborate
// cleanly and still rest on an axiom the author never sanctioned. The probe asks
// the kernel those questions directly, and the answer is what callers compare
// against the goal they froze.
// ---------------------------------------------------------------------------

const TRUSTED_AXIOMS = ['propext', 'Classical.choice', 'Quot.sound'];

function certificateProbe(declarationName: string, nonce: string): string {
  // Namespaced names must be rebuilt component by component: `mkSimple` on a
  // dotted string yields one atom containing a dot, which no constant has.
  // `isLeanDeclarationName` admits no quote or backslash, so each component is
  // safe to interpolate into the string literals here.
  const components = declarationName.split('.').map((part) => `"${part}"`).join(', ');
  return `
run_cmd do
  let declName := [${components}].foldl Lean.Name.mkStr Lean.Name.anonymous
  let info ← Lean.getConstInfo declName
  let axioms ← Lean.collectAxioms declName
  let payload := Lean.Json.mkObj [
    ("goal", Lean.Json.str (repr info.type).pretty),
    ("axioms", Lean.toJson (axioms.toList.map Lean.Name.toString))]
  Lean.logInfo ("LALE_CERT_${nonce}:" ++ payload.compress)
`;
}

function applyCertificate(
  result: LeanCheckResult,
  marker: string,
  declarationName: string,
  allowTrustViolations: string[],
): LeanCheckResult {
  const line = result.stdout.split('\n').find((candidate) => candidate.includes(marker));
  if (!line) {
    // Lean succeeded but the declaration is not there under that name, so there
    // is nothing to attest. Never treat that as a pass.
    return { ...result, status: 'blocked', diagnostics: [certificateError('Missing')] };
  }

  let payload: { goal: string; axioms: string[] };
  try {
    payload = JSON.parse(line.slice(line.indexOf(marker) + marker.length)) as typeof payload;
    if (
      typeof payload.goal !== 'string'
      || !Array.isArray(payload.axioms)
      || payload.axioms.some((axiom) => typeof axiom !== 'string')
    ) {
      throw new Error('Invalid certificate');
    }
  } catch {
    return { ...result, status: 'blocked', diagnostics: [certificateError('Invalid')] };
  }

  // `sorryAx` is admissible only where the caller asked for `sorry` — a frozen
  // statement header is supposed to carry one until the proposer fills it.
  const allowed = new Set(
    allowTrustViolations.includes('sorry') ? [...TRUSTED_AXIOMS, 'sorryAx'] : TRUSTED_AXIOMS,
  );
  const untrusted = payload.axioms.filter((axiom) => !allowed.has(axiom));
  if (untrusted.length > 0) {
    return {
      ...result,
      status: 'blocked',
      trustViolations: untrusted.map((name) => ({ name })),
      diagnostics: [
        { kind: 'error', message: `Untrusted proof axioms: ${untrusted.join(', ')}` },
      ],
    };
  }

  return {
    ...result,
    certificate: {
      declarationName,
      normalizedGoalTerm: payload.goal,
      axioms: payload.axioms,
    },
    // The marker is harness plumbing, not something a caller should see.
    diagnostics: result.diagnostics.filter((d) => !d.message.includes(marker)),
  };
}

function certificateError(kind: 'Missing' | 'Invalid'): LeanDiagnostic {
  return { kind: 'error', message: `${kind} kernel declaration certificate` };
}

function blockedResult(message: string): LeanCheckResult {
  return {
    status: 'blocked',
    diagnostics: [{ kind: 'error', message }],
    trustViolations: [],
    elapsedMs: 0,
    stdout: '',
    stderr: '',
  };
}

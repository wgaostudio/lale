import { spawn } from 'node:child_process';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
}

export interface LeanRunnerConfig {
  projectDir: string;
  wallClockCapMs?: number;
  memoryCap?: string;
}

export interface LeanCheckOptions {
  allowTrustViolations?: string[];
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
];

export function scanTrustViolations(source: string): TrustViolation[] {
  return TRUST_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(({ name }) => ({ name }));
}

// ---------------------------------------------------------------------------
// Diagnostic parser
// ---------------------------------------------------------------------------

// Lean outputs lines like: filename.lean:10:5: error: message
const DIAG_RE = /^[^:]+:(\d+):(\d+): (error|warning|info): (.+)$/;

function parseDiagnostics(output: string): LeanDiagnostic[] {
  const diagnostics: LeanDiagnostic[] = [];
  for (const line of output.split('\n')) {
    const match = DIAG_RE.exec(line.trim());
    if (match) {
      diagnostics.push({
        kind: match[3] as LeanDiagnostic['kind'],
        message: match[4] ?? '',
        line: Number.parseInt(match[1] ?? '0', 10),
        column: Number.parseInt(match[2] ?? '0', 10),
      });
    }
  }
  return diagnostics;
}

function hasErrors(diagnostics: LeanDiagnostic[]): boolean {
  return diagnostics.some((d) => d.kind === 'error');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class LeanRunner {
  private readonly projectDir: string;
  private readonly wallClockCapMs: number;
  private readonly memoryCap: string;

  constructor(config: LeanRunnerConfig) {
    this.projectDir = config.projectDir;
    this.wallClockCapMs = config.wallClockCapMs ?? 60_000;
    this.memoryCap = config.memoryCap ?? '4000000'; // 4 GB in KB for ulimit -v
  }

  async check(source: string, options: LeanCheckOptions = {}): Promise<LeanCheckResult> {
    const allowedViolations = new Set(options.allowTrustViolations ?? []);
    const trustViolations = scanTrustViolations(source).filter(
      (violation) => !allowedViolations.has(violation.name),
    );
    if (trustViolations.length > 0) {
      return {
        status: 'blocked',
        diagnostics: [
          {
            kind: 'error',
            message: `Trust policy violation: ${trustViolations.map((v) => v.name).join(', ')}`,
          },
        ],
        trustViolations,
        elapsedMs: 0,
        stdout: '',
        stderr: '',
      };
    }

    const checksDir = join(this.projectDir, 'Checks');
    await mkdir(checksDir, { recursive: true });
    const tmpFile = join(checksDir, `check_${randomUUID()}.lean`);

    try {
      await writeFile(tmpFile, source, 'utf8');
      return await this.runLean(tmpFile);
    } finally {
      unlink(tmpFile).catch(() => undefined);
    }
  }

  private runLean(filePath: string): Promise<LeanCheckResult> {
    const startMs = Date.now();

    // Use a shell wrapper so we can set ulimit for memory capping on Unix.
    // On Windows, ulimit is unavailable — we skip the memory cap there.
    const isWindows = process.platform === 'win32';
    const args = isWindows
      ? ['env', 'lean', filePath]
      : ['-c', `ulimit -v ${this.memoryCap} 2>/dev/null; exec lake env lean "$@"`, '--', filePath];
    const cmd = isWindows ? 'lake' : 'bash';

    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd: this.projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Put lean in its own process group so SIGKILL on timeout takes the
        // shell wrapper *and* the lake/lean grandchildren with it. Without
        // this, killing the bash wrapper can leave the actual lean process
        // running until the wall-clock cap means nothing.
        detached: true,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch { child.kill('SIGKILL'); }
        } else {
          child.kill('SIGKILL');
        }
      }, this.wallClockCapMs);

      child.on('close', () => {
        clearTimeout(timer);
        const elapsedMs = Date.now() - startMs;

        if (timedOut) {
          resolve({
            status: 'timeout',
            diagnostics: [{ kind: 'error', message: `Lean check timed out after ${this.wallClockCapMs}ms` }],
            trustViolations: [],
            elapsedMs,
            stdout,
            stderr,
          });
          return;
        }

        const combined = stdout + '\n' + stderr;
        const diagnostics = parseDiagnostics(combined);
        resolve({
          status: hasErrors(diagnostics) ? 'error' : 'ok',
          diagnostics,
          trustViolations: [],
          elapsedMs,
          stdout,
          stderr,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          status: 'error',
          diagnostics: [{ kind: 'error', message: `Failed to spawn lean: ${err.message}` }],
          trustViolations: [],
          elapsedMs: Date.now() - startMs,
          stdout,
          stderr,
        });
      });
    });
  }
}

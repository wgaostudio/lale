import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  ProvisionEvent,
  ProvisionStep,
  ProvisionStatus,
  ProvisionStateResponse,
} from '@lale/protocol';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface ProvisionState {
  provisionId: string | null;
  status: ProvisionStatus;
  leanVersion: string | null;
  mathlibRevision: string | null;
  projectDir: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  events: ProvisionEvent[];
  current: ChildProcess | null;
}

const state: ProvisionState = {
  provisionId: null,
  status: 'idle',
  leanVersion: null,
  mathlibRevision: null,
  projectDir: '',
  startedAt: null,
  finishedAt: null,
  error: null,
  events: [],
  current: null,
};

// ---------------------------------------------------------------------------
// SSE subscribers
// ---------------------------------------------------------------------------

type SseCallback = (chunk: string) => void;
const sseSubscribers = new Map<string, Set<SseCallback>>();

export function subscribeProvisionSse(provisionId: string, cb: SseCallback): () => void {
  let set = sseSubscribers.get(provisionId);
  if (!set) {
    set = new Set();
    sseSubscribers.set(provisionId, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) sseSubscribers.delete(provisionId);
  };
}

function broadcast(provisionId: string, eventName: string, data: unknown): void {
  const chunk = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const cb of sseSubscribers.get(provisionId) ?? []) cb(chunk);
}

function emit(
  step: ProvisionStep,
  level: ProvisionEvent['level'],
  message: string,
  payload?: Record<string, unknown>,
): void {
  if (!state.provisionId) return;
  const event: ProvisionEvent = {
    eventId: randomUUID(),
    provisionId: state.provisionId,
    timestamp: new Date().toISOString(),
    step,
    level,
    message,
    ...(payload !== undefined ? { payload } : {}),
  };
  state.events.push(event);
  broadcast(state.provisionId, 'provision_event', event);
}

// ---------------------------------------------------------------------------
// Project inspection
// ---------------------------------------------------------------------------

export interface ProvisionedProjectStatus {
  ready: boolean;
  leanVersion: string | null;
  mathlibRevision: string | null;
}

export async function inspectProvisionedProject(
  projectDir: string,
): Promise<ProvisionedProjectStatus> {
  const toolchainPath = join(projectDir, 'lean-toolchain');
  const lakefilePath = join(projectDir, 'lakefile.lean');
  const lakeBuildDir = join(projectDir, '.lake');

  if (!existsSync(toolchainPath) || !existsSync(lakefilePath) || !existsSync(lakeBuildDir)) {
    return {
      ready: false,
      leanVersion: existsSync(toolchainPath)
        ? (await safeRead(toolchainPath))?.trim() ?? null
        : null,
      mathlibRevision: existsSync(lakefilePath)
        ? extractMathlibRevision(await safeRead(lakefilePath) ?? '')
        : null,
    };
  }

  const toolchain = (await safeRead(toolchainPath)) ?? '';
  const lakefile = (await safeRead(lakefilePath)) ?? '';
  return {
    ready: true,
    leanVersion: toolchain.trim() || null,
    mathlibRevision: extractMathlibRevision(lakefile),
  };
}

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function extractMathlibRevision(lakefile: string): string | null {
  // Matches: ... @ "<revision>"
  const match = /mathlib[\s\S]*?@\s*"([^"]+)"/i.exec(lakefile);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Public state accessors
// ---------------------------------------------------------------------------

export async function getProvisionState(): Promise<ProvisionStateResponse> {
  const projectStatus = await inspectProvisionedProject(state.projectDir);
  return {
    protocolVersion: 1,
    provisionId: state.provisionId,
    status: state.status,
    leanVersion: state.leanVersion ?? projectStatus.leanVersion,
    mathlibRevision: state.mathlibRevision ?? projectStatus.mathlibRevision,
    projectDir: state.projectDir,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    error: state.error,
    projectReady: projectStatus.ready,
  };
}

export function getPastEvents(provisionId: string): ProvisionEvent[] {
  if (state.provisionId !== provisionId) return [];
  return state.events.slice();
}

export function isProvisioning(): boolean {
  return state.status === 'running';
}

export function defaultProjectDir(): string {
  return process.env['LALE_LEAN_PROJECT_DIR'] ?? join(homedir(), '.lale', 'lean-project');
}

export function initProjectDir(dir: string): void {
  state.projectDir = dir;
}

// ---------------------------------------------------------------------------
// Active-child tracking
// ---------------------------------------------------------------------------
//
// Long-running provisioning spawns (`elan toolchain install`, `lake update`,
// `lake exe cache get`) are started with `detached: true` so they get their
// own process group. That lets us kill the whole tree — including
// grandchildren like the actual lean/curl invocations elan and lake spawn —
// with a single `process.kill(-pid)`. Without it, SIGTERM to the desktop
// service leaves orphaned installers behind that take held locks with them.

const activeChildren = new Set<ChildProcess>();

function trackChild(child: ChildProcess): void {
  activeChildren.add(child);
  const drop = (): void => {
    activeChildren.delete(child);
  };
  child.once('close', drop);
  child.once('error', drop);
}

export function killActiveProvisionChildren(
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  for (const child of activeChildren) {
    if (child.pid === undefined || child.killed) continue;
    try {
      // Negative PID targets the process group, which we put the child in via
      // `detached: true`. Catches grandchildren too.
      process.kill(-child.pid, signal);
    } catch {
      // Group is already gone (process exited between iteration and signal);
      // fall back to a direct PID kill, ignore any failure there too.
      try {
        child.kill(signal);
      } catch {
        // Already dead.
      }
    }
  }
  activeChildren.clear();
}

// ---------------------------------------------------------------------------
// Process spawning with progress streaming
// ---------------------------------------------------------------------------

interface SpawnOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  // Hard upper bound on a single step; defaults to no timeout (some steps
  // legitimately take many minutes).
  timeoutMs?: number;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runStep(
  step: ProvisionStep,
  cmd: string,
  args: string[],
  opts: SpawnOpts = {},
): Promise<SpawnResult> {
  emit(step, 'info', `$ ${cmd} ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });
    state.current = child;
    trackChild(child);

    let stdout = '';
    let stderr = '';

    const lineHandler =
      (stream: 'stdout' | 'stderr') =>
      (chunk: Buffer): void => {
        const text = chunk.toString();
        if (stream === 'stdout') stdout += text;
        else stderr += text;
        for (const raw of text.split('\n')) {
          const line = raw.replace(/\r/g, '').trim();
          if (line) emit(step, stream === 'stderr' ? 'warning' : 'info', line, { stream });
        }
      };

    child.stdout.on('data', lineHandler('stdout'));
    child.stderr.on('data', lineHandler('stderr'));

    let timedOut = false;
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            emit(step, 'error', `Step timed out after ${opts.timeoutMs}ms`);
            // Group-kill so grandchildren (e.g. elan's curl, lake's spawned
            // lean) don't survive the timeout.
            if (child.pid !== undefined) {
              try { process.kill(-child.pid, 'SIGKILL'); }
              catch { child.kill('SIGKILL'); }
            } else {
              child.kill('SIGKILL');
            }
          }, opts.timeoutMs)
        : null;

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      state.current = null;
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      state.current = null;
      resolve({ exitCode: code ?? 0, stdout, stderr, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

function withElanPath(): NodeJS.ProcessEnv {
  const elanBin = join(homedir(), '.elan', 'bin');
  const existing = process.env['PATH'] ?? '';
  const parts = existing.split(':').filter(Boolean);
  if (!parts.includes(elanBin)) parts.unshift(elanBin);
  return { PATH: parts.join(':') };
}

// ---------------------------------------------------------------------------
// Lean project files
// ---------------------------------------------------------------------------

function lakefileContents(mathlibRevision: string): string {
  return `import Lake
open Lake DSL

package lale where
  -- Generated by lale desktop provisioning.

@[default_target]
lean_lib Lale where
  -- Empty library — Mathlib is pulled in for the auditor's checks at runtime.

require mathlib from git
  "https://github.com/leanprover-community/mathlib4.git" @ "${mathlibRevision}"
`;
}

function leanToolchainContents(leanVersion: string): string {
  const normalized = leanVersion.startsWith('leanprover/')
    ? leanVersion
    : `leanprover/lean4:${normalizeLeanVersionTag(leanVersion)}`;
  return `${normalized}\n`;
}

function normalizeLeanVersionTag(v: string): string {
  // Accept "4.15.0", "v4.15.0", or a full toolchain string.
  if (v.startsWith('v')) return v;
  if (/^\d/.test(v)) return `v${v}`;
  return v;
}

function lalePlaceholder(): string {
  return `-- Generated by lale desktop provisioning. Mathlib is loaded on demand by the auditor.
import Mathlib

namespace Lale
end Lale
`;
}

// ---------------------------------------------------------------------------
// Provisioning steps
// ---------------------------------------------------------------------------

async function detectElan(env: NodeJS.ProcessEnv): Promise<boolean> {
  emit('detectElan', 'info', 'Checking for elan');
  try {
    const result = await runStep('detectElan', 'elan', ['--version'], { env, timeoutMs: 10_000 });
    if (result.exitCode === 0) {
      emit('detectElan', 'info', 'elan already installed');
      return true;
    }
  } catch {
    // ENOENT — fall through to install.
  }
  emit('detectElan', 'info', 'elan not found on PATH');
  return false;
}

async function installElan(): Promise<void> {
  if (platform() === 'win32') {
    throw new Error(
      'Automatic elan install is not supported on Windows. Install elan manually from https://github.com/leanprover/elan and retry.',
    );
  }
  emit('installElan', 'info', 'Installing elan from the upstream installer script');

  // Use the official elan-init.sh installer. `--default-toolchain none` skips
  // installing a default toolchain — we install the project-pinned one explicitly.
  const installer =
    'curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh ' +
    '| sh -s -- -y --default-toolchain none';

  const result = await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn('bash', ['-c', installer], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    state.current = child;
    trackChild(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
      for (const line of c.toString().split('\n')) {
        if (line.trim()) emit('installElan', 'info', line.trim());
      }
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
      for (const line of c.toString().split('\n')) {
        if (line.trim()) emit('installElan', 'warning', line.trim());
      }
    });
    child.on('error', (err) => {
      state.current = null;
      reject(err);
    });
    child.on('close', (code) => {
      state.current = null;
      resolve({ exitCode: code ?? 0, stdout, stderr, timedOut: false });
    });
  });

  if (result.exitCode !== 0) {
    throw new Error(`elan installer exited with code ${result.exitCode}`);
  }
  emit('installElan', 'info', 'elan installed');
}

async function writeProject(
  projectDir: string,
  leanVersion: string,
  mathlibRevision: string,
): Promise<void> {
  emit('writeProject', 'info', `Writing project files to ${projectDir}`);
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'lean-toolchain'), leanToolchainContents(leanVersion), 'utf8');
  await writeFile(join(projectDir, 'lakefile.lean'), lakefileContents(mathlibRevision), 'utf8');
  await writeFile(join(projectDir, 'Lale.lean'), lalePlaceholder(), 'utf8');
  emit('writeProject', 'info', 'Project files written');
}

async function installToolchain(env: NodeJS.ProcessEnv, leanVersion: string): Promise<void> {
  const tag = leanVersion.startsWith('leanprover/')
    ? leanVersion
    : `leanprover/lean4:${normalizeLeanVersionTag(leanVersion)}`;
  emit('installToolchain', 'info', `Installing Lean toolchain ${tag}`);
  // 30 min cap — toolchain downloads are usually under 5 min but can stall.
  const result = await runStep('installToolchain', 'elan', ['toolchain', 'install', tag], {
    env,
    timeoutMs: 30 * 60_000,
  });
  if (result.exitCode === 0) return;
  // elan exits 1 with stderr `error: '<tag>' is already installed` when the
  // toolchain is present. That's a no-op success for our purposes (the
  // toolchain is on disk and usable), not an actual install failure.
  if (/is already installed/i.test(result.stderr) || /is already installed/i.test(result.stdout)) {
    emit('installToolchain', 'info', `${tag} already installed — skipping`);
    return;
  }
  throw new Error(`elan toolchain install exited with code ${result.exitCode}`);
}

async function lakeUpdate(env: NodeJS.ProcessEnv, projectDir: string): Promise<void> {
  emit('lakeUpdate', 'info', 'Fetching dependency manifest (lake update)');
  // 30 min cap — git clone of mathlib can be slow on a cold network.
  const result = await runStep('lakeUpdate', 'lake', ['update'], {
    cwd: projectDir,
    env,
    timeoutMs: 30 * 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`lake update exited with code ${result.exitCode}`);
  }
}

async function lakeCacheGet(env: NodeJS.ProcessEnv, projectDir: string): Promise<void> {
  emit(
    'lakeCacheGet',
    'info',
    'Pulling prebuilt Mathlib oleans from the community cache (lake exe cache get)',
  );
  // 60 min cap — the cache is large; honest upper bound on a slow link.
  const result = await runStep('lakeCacheGet', 'lake', ['exe', 'cache', 'get'], {
    cwd: projectDir,
    env,
    timeoutMs: 60 * 60_000,
  });
  if (result.exitCode !== 0) {
    // Documented fallback (§4): if community cache is unavailable we'd build
    // from source, which is hours. Surface this clearly rather than silently
    // grinding.
    throw new Error(
      `lake exe cache get exited with code ${result.exitCode}. ` +
        'The community Mathlib cache may not cover this revision. ' +
        'Fallback would require building Mathlib from source.',
    );
  }
}

async function verify(env: NodeJS.ProcessEnv, projectDir: string): Promise<void> {
  emit('verify', 'info', 'Verifying installation with `lake env lean --version`');
  const result = await runStep('verify', 'lake', ['env', 'lean', '--version'], {
    cwd: projectDir,
    env,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Verification failed: lake env lean --version exited with code ${result.exitCode}`);
  }
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export interface StartProvisionInput {
  leanVersion: string;
  mathlibRevision: string;
  projectDir: string;
  force?: boolean;
}

export interface StartProvisionResult {
  provisionId: string;
  alreadyReady: boolean;
}

export async function startProvision(
  input: StartProvisionInput,
): Promise<StartProvisionResult> {
  if (state.status === 'running') {
    throw new ProvisionAlreadyRunningError('Provisioning is already in progress');
  }

  const existing = await inspectProvisionedProject(input.projectDir);
  if (existing.ready && !input.force) {
    return {
      provisionId: state.provisionId ?? 'already-ready',
      alreadyReady: true,
    };
  }

  const provisionId = randomUUID();
  state.provisionId = provisionId;
  state.status = 'running';
  state.leanVersion = input.leanVersion;
  state.mathlibRevision = input.mathlibRevision;
  state.projectDir = input.projectDir;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.error = null;
  state.events = [];

  // Run asynchronously; the caller gets the id immediately.
  void runProvision(provisionId, input).catch((err: unknown) => {
    // Defensive — runProvision already handles errors internally.
    console.error('Unexpected provisioning error:', err);
  });

  return { provisionId, alreadyReady: false };
}

class ProvisionAlreadyRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisionAlreadyRunningError';
  }
}

export { ProvisionAlreadyRunningError };

async function runProvision(provisionId: string, input: StartProvisionInput): Promise<void> {
  const env = withElanPath();

  emit('start', 'info', `Provisioning Lean ${input.leanVersion} + Mathlib ${input.mathlibRevision}`);

  try {
    const elanPresent = await detectElan(env);
    if (!elanPresent) {
      await installElan();
    }

    await writeProject(input.projectDir, input.leanVersion, input.mathlibRevision);
    await installToolchain(env, input.leanVersion);
    await lakeUpdate(env, input.projectDir);
    await lakeCacheGet(env, input.projectDir);
    await verify(env, input.projectDir);

    state.status = 'ready';
    state.finishedAt = new Date().toISOString();
    emit('complete', 'info', 'Provisioning complete');
    broadcast(provisionId, 'complete', { provisionId, status: 'ready' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.status = 'failed';
    state.finishedAt = new Date().toISOString();
    state.error = message;
    emit('error', 'error', `Provisioning failed: ${message}`);
    broadcast(provisionId, 'complete', { provisionId, status: 'failed', error: message });
  }
}

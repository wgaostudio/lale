import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LeanRunner, parseDiagnostics } from '@lale/lean-runner';

// `LeanRunnerConfig.command` / `commandArgs` exist so the toolchain can be
// swapped, which makes the whole harness testable without Lean: a stub binary
// stands in for `lake env lean`, reads the file the runner wrote, and answers
// the way Lean would. What is under test is the harness — the trust gate, the
// certificate contract, the caps — not Lean itself.

interface Stub {
  /** What the stub prints to stdout. `$NONCE` becomes the run's real nonce. */
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Milliseconds to hang before exiting, for the wall-clock cap. */
  hangMs?: number;
  /** Bytes of filler to print, for the output cap. */
  floodBytes?: number;
}

function runnerWith(stub: Stub, config: Record<string, unknown> = {}): {
  runner: LeanRunner;
  projectDir: string;
  ran: () => boolean;
} {
  const projectDir = mkdtempSync(join(tmpdir(), 'lale-runner-'));
  const ranMarker = join(projectDir, 'stub-ran');
  const stubPath = join(projectDir, 'stub.cjs');

  writeFileSync(stubPath, `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(ranMarker)}, '1');
const file = process.argv[process.argv.length - 1];
const source = fs.readFileSync(file, 'utf8');
// The probe the harness appends carries the nonce a real Lean run would echo.
const nonce = (/LALE_CERT_([0-9a-f-]+)/.exec(source) || [])[1] || 'no-nonce';
const stub = ${JSON.stringify(stub)};
if (stub.floodBytes) process.stdout.write('x'.repeat(stub.floodBytes));
if (stub.stdout) process.stdout.write(String(stub.stdout).split('$NONCE').join(nonce) + '\\n');
if (stub.stderr) process.stderr.write(String(stub.stderr) + '\\n');
if (stub.hangMs) { setTimeout(() => process.exit(stub.exitCode || 0), stub.hangMs); }
else process.exit(stub.exitCode || 0);
`);

  return {
    projectDir,
    ran: () => readdirSync(projectDir).includes('stub-ran'),
    runner: new LeanRunner({
      projectDir,
      command: process.execPath,
      commandArgs: [stubPath],
      wallClockCapMs: 5_000,
      ...config,
    }),
  };
}

const cert = (goal: string, axioms: string[]): string =>
  `LALE_CERT_$NONCE:${JSON.stringify({ goal, axioms })}`;

const THEOREM = 'import Mathlib\ntheorem t : True := by trivial';

test('the trust gate runs before Lean does', async () => {
  for (const source of [
    'import Mathlib\ntheorem t : True := by sorry',
    'import Mathlib\naxiom cheat : False\ntheorem t : True := by trivial',
    'import Evil.Backdoor\ntheorem t : True := by trivial',
  ]) {
    const { runner, ran } = runnerWith({ stdout: cert('True', []) });
    const result = await runner.check(source, { declarationName: 't' });
    assert.equal(result.status, 'blocked', source);
    assert.ok(result.trustViolations.length > 0, source);
    // The point of a static gate is that the untrusted source never executes.
    assert.equal(ran(), false, `stub should not have run for: ${source}`);
  }
});

test('an unapproved import is named in the violation', async () => {
  const { runner } = await Promise.resolve(runnerWith({ stdout: cert('True', []) }));
  const result = await runner.check('import Evil.Backdoor\ntheorem t : True := by trivial', {
    declarationName: 't',
  });
  assert.deepEqual(result.trustViolations, [{ name: 'unapproved-import:Evil.Backdoor' }]);
});

test('a declaration name that is not a Lean name is refused before spawning', async () => {
  const { runner, ran } = runnerWith({ stdout: cert('True', []) });
  const result = await runner.check(THEOREM, { declarationName: 't"; run_cmd unsafeIO' });
  assert.equal(result.status, 'blocked');
  assert.match(result.diagnostics[0]!.message, /Invalid declaration name/);
  assert.equal(ran(), false);
});

test('a clean run returns the kernel certificate and hides the marker line', async () => {
  const { runner, projectDir } = runnerWith({ stdout: cert('∀ (n : Nat), n + 0 = n', ['propext']) });
  const result = await runner.check(THEOREM, { declarationName: 't' });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.certificate, {
    declarationName: 't',
    normalizedGoalTerm: '∀ (n : Nat), n + 0 = n',
    axioms: ['propext'],
  });
  // The marker is harness plumbing and must not surface as a diagnostic.
  assert.equal(result.diagnostics.some((d) => d.message.includes('LALE_CERT')), false);
  // The scratch file is cleaned up even on success.
  assert.deepEqual(readdirSync(join(projectDir, 'Checks')), []);
});

test('a proof leaning on an axiom outside the trusted three is rejected', async () => {
  const { runner } = runnerWith({ stdout: cert('True', ['propext', 'myBackdoor']) });
  const result = await runner.check(THEOREM, { declarationName: 't' });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.trustViolations, [{ name: 'myBackdoor' }]);
  assert.match(result.diagnostics.at(-1)!.message, /Untrusted proof axioms: myBackdoor/);
});

test('sorryAx counts as untrusted unless sorry was explicitly allowed', async () => {
  const withSorry = 'import Mathlib\ntheorem t : True := by sorry';

  const rejecting = runnerWith({ stdout: cert('True', ['sorryAx']) });
  const rejected = await rejecting.runner.check(withSorry, {
    declarationName: 't',
    allowTrustViolations: [],
  });
  assert.equal(rejected.status, 'blocked');

  // Statement formalization deliberately allows it: a frozen header is supposed
  // to carry `sorry` until the proposer fills it.
  const allowing = runnerWith({ stdout: cert('True', ['sorryAx']) });
  const allowed = await allowing.runner.check(withSorry, {
    declarationName: 't',
    allowTrustViolations: ['sorry'],
  });
  assert.equal(allowed.status, 'ok');
  assert.deepEqual(allowed.certificate?.axioms, ['sorryAx']);
});

test('a missing or malformed certificate fails closed, never open', async () => {
  const missing = runnerWith({ stdout: 'no certificate here' });
  const noCert = await missing.runner.check(THEOREM, { declarationName: 't' });
  assert.equal(noCert.status, 'blocked');
  assert.match(noCert.diagnostics.at(-1)!.message, /Missing kernel declaration certificate/);

  const malformed = runnerWith({ stdout: 'LALE_CERT_$NONCE:{not json' });
  const badCert = await malformed.runner.check(THEOREM, { declarationName: 't' });
  assert.equal(badCert.status, 'blocked');
  assert.match(badCert.diagnostics.at(-1)!.message, /Invalid kernel declaration certificate/);

  // Right shape, wrong types.
  const wrongTypes = runnerWith({ stdout: 'LALE_CERT_$NONCE:{"goal":1,"axioms":[]}' });
  const badTypes = await wrongTypes.runner.check(THEOREM, { declarationName: 't' });
  assert.equal(badTypes.status, 'blocked');
});

test('the wall-clock cap kills the process and reports a timeout', async () => {
  const { runner } = runnerWith({ hangMs: 10_000 }, { wallClockCapMs: 300 });
  const result = await runner.check(THEOREM, { declarationName: 't' });

  assert.equal(result.status, 'timeout');
  assert.match(result.diagnostics.at(-1)!.message, /Lean timed out after 300ms/);
});

test('output past the cap stops the run instead of buffering without bound', async () => {
  const { runner } = runnerWith({ floodBytes: 200_000 }, { outputCapBytes: 1_000 });
  const result = await runner.check(THEOREM, { declarationName: 't' });

  assert.equal(result.status, 'error');
  assert.ok(result.stdout.length <= 1_000);
  assert.match(result.diagnostics.at(-1)!.message, /Lean output limit exceeded/);
});

test('a toolchain that cannot be spawned is an environment fault, not a bad proof', async () => {
  const { projectDir } = runnerWith({});
  const runner = new LeanRunner({
    projectDir,
    command: join(projectDir, 'does-not-exist'),
    commandArgs: [],
  });
  const result = await runner.check(THEOREM, { declarationName: 't' });

  // `blocked`, not `error`: callers stop the run rather than asking the model
  // to repair source that was never the problem.
  assert.equal(result.status, 'blocked');
  assert.match(result.diagnostics.at(-1)!.message, /Failed to spawn Lean/);
});

test('a nonzero exit is reported with the stderr that explains it', async () => {
  const { runner } = runnerWith({ stderr: 'lake: unknown package', exitCode: 1 });
  const result = await runner.check(THEOREM, { declarationName: 't' });

  assert.equal(result.status, 'error');
  assert.match(result.diagnostics.at(-1)!.message, /exited with code 1.*unknown package/s);
});

test('an invalid memory cap is rejected at construction', () => {
  assert.throws(
    () => new LeanRunner({ projectDir: '/tmp', memoryCap: '1024; rm -rf /' }),
    /Invalid memory cap/,
  );
});

test('diagnostics keep multi-line goals attached to the error that owns them', () => {
  const parsed = parseDiagnostics(
    [
      '/p/Checks/c.lean:12:4: error: unsolved goals',
      '⊢ ∀ (n : Nat),',
      '  n + 0 = n',
      '/p/Checks/c.lean:3:0: warning: unused variable',
      'plain trailing noise',
    ].join('\n'),
  );

  assert.equal(parsed.length, 2);
  assert.deepEqual(
    { kind: parsed[0]!.kind, line: parsed[0]!.line, column: parsed[0]!.column },
    { kind: 'error', line: 12, column: 4 },
  );
  assert.equal(parsed[0]!.message, 'unsolved goals\n⊢ ∀ (n : Nat),\n  n + 0 = n');
  assert.equal(parsed[1]!.kind, 'warning');
  assert.equal(parsed[1]!.message, 'unused variable\nplain trailing noise');
});

test.after(() => {
  for (const dir of readdirSync(tmpdir()).filter((d) => d.startsWith('lale-runner-'))) {
    rmSync(join(tmpdir(), dir), { recursive: true, force: true });
  }
});

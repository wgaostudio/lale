import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { scanTrustViolations, type LeanCheckOptions, type LeanCheckResult, type LeanRunner } from '@lale/lean-runner';
import { ModelClient, fromWireChoice, toWireMessages, type ChatMessage, type ChatToolSpec, type TokenUsage } from '@lale/translator';
import { compactHistory, runAgentProver, type AgentEvent } from '../src/pipeline/agent/prover.js';
import { Workspace, locate } from '../src/pipeline/agent/workspace.js';
import { executeTool } from '../src/pipeline/agent/tools.js';
import { loadDeclarationIndex, searchDeclarations, clearMathlibSearchCache } from '../src/pipeline/agent/mathlib-search.js';

// No model request or Lean subprocess happens here: the model is a script of
// tool calls, and Lean is a fake that applies the real trust scan and answers
// from markers in the source.

const FROZEN = {
  leanSource: 'import Mathlib\nopen Nat\ntheorem target : ∀ n : Nat, n + 0 = n := by sorry',
  theoremName: 'target',
  normalizedGoalTerm: 'GOAL',
};
const PRICING = { prompt: 1e-6, completion: 4e-6 };

interface CheckCall { source: string; options: LeanCheckOptions }

function fakeRunner(opts: { environmentFault?: boolean } = {}): { runner: LeanRunner; calls: CheckCall[] } {
  const calls: CheckCall[] = [];
  const runner = {
    async check(source: string, options: LeanCheckOptions = {}): Promise<LeanCheckResult> {
      calls.push({ source, options });
      const base = { diagnostics: [], trustViolations: [], elapsedMs: 5, stdout: '', stderr: '' };
      if (opts.environmentFault) {
        return { ...base, status: 'blocked', diagnostics: [{ kind: 'error', message: 'Lean could not run: failed to spawn Lean (ENOENT).' }] };
      }
      // Lean accepts imports only at the start of a file.
      const firstCode = source.split('\n').findIndex((l) => l.trim() && !/^\s*import\s/.test(l));
      const lateImport = firstCode >= 0 && source.split('\n').slice(firstCode).some((l) => /^\s*import\s/.test(l));
      if (lateImport) {
        return { ...base, status: 'error', diagnostics: [{ kind: 'error', message: "invalid 'import' command, it must be used in the beginning of the file", line: 1 }] };
      }
      const violations = scanTrustViolations(source).filter((v) => !(options.allowTrustViolations ?? []).includes(v.name));
      if (violations.length) {
        return { ...base, status: 'blocked', trustViolations: violations,
          diagnostics: [{ kind: 'error', message: `Trust policy violation: ${violations.map((v) => v.name).join(', ')}` }] };
      }
      // The real runner prepends `import Lean` when certifying.
      const offset = options.declarationName ? 1 : 0;
      const lines = source.split('\n');
      const diagnostics: LeanCheckResult['diagnostics'] = [];
      lines.forEach((line, i) => {
        if (line.includes('BROKEN')) diagnostics.push({ kind: 'error', message: 'unknown identifier BROKEN', line: i + 1 + offset });
        if (/\bsorry\b/.test(line)) diagnostics.push({ kind: 'warning', message: "declaration uses 'sorry'", line: i + 1 + offset });
        const check = /^#check @(.+)$/.exec(line);
        if (check) diagnostics.push({ kind: 'info', message: `@${check[1]} : SomeType`, line: i + 1 + offset });
      });
      const status = diagnostics.some((d) => d.kind === 'error') ? 'error' : 'ok';
      return {
        ...base, status, diagnostics,
        ...(status === 'ok' && options.declarationName
          ? { certificate: { declarationName: options.declarationName, axioms: [],
              normalizedGoalTerm: source.includes('INTERFERE') ? 'OTHER' : 'GOAL' } }
          : {}),
      };
    },
  };
  return { runner: runner as unknown as LeanRunner, calls };
}

type Turn = Array<{ name: string; args: Record<string, unknown> }> | { text: string };

function scriptedClient(turns: Turn[], usagePerTurn: TokenUsage = { inputTokens: 1000, outputTokens: 500 }) {
  const seen: ChatMessage[][] = [];
  let index = 0;
  const client = {
    async chat(messages: ChatMessage[], _tools: ChatToolSpec[]) {
      seen.push(structuredClone(messages));
      const turn = turns[Math.min(index++, turns.length - 1)]!;
      if ('text' in turn) {
        return { message: { role: 'assistant' as const, content: turn.text }, finishReason: 'stop', reasoning: null, usage: usagePerTurn };
      }
      return {
        message: {
          role: 'assistant' as const, content: null,
          toolCalls: turn.map((call, i) => ({ id: `c${index}_${i}`, name: call.name, arguments: JSON.stringify(call.args) })),
        },
        finishReason: 'tool_calls', reasoning: 'thinking about it', usage: usagePerTurn,
      };
    },
  };
  return { client: client as unknown as ModelClient, seen };
}

const base = { frozen: FROZEN, dependencyDeclarations: '', pricing: PRICING, sleep: async () => {} };

test('agent writes a helper, proves the frozen theorem, and the gate accepts it', async () => {
  const { runner, calls } = fakeRunner();
  const { client } = scriptedClient([
    [{ name: 'write_file', args: { path: 'Helpers.lean', content: 'theorem helper (n : Nat) : n + 0 = n := rfl' } }],
    [{ name: 'set_proof', args: { body: 'intro n\nexact helper n' } }, { name: 'check', args: {} }],
    [{ name: 'submit', args: {} }],
  ]);
  const result = await runAgentProver({ ...base, client, runner, dependencyDeclarations: 'def dep : Nat := 0' });
  assert.equal(result.outcome, 'verified');
  assert.equal(result.stopReason, 'accepted');
  assert.equal(result.turns, 3);

  const gate = calls.at(-1)!;
  assert.equal(gate.options.declarationName, 'target');
  assert.deepEqual(gate.options.allowTrustViolations ?? [], [], 'the gate grants no trust allowances');
  assert.ok(gate.source.includes('theorem target : ∀ n : Nat, n + 0 = n := by\n  intro n\n  exact helper n'));
  assert.ok(gate.source.indexOf('theorem helper') < gate.source.indexOf('theorem target'));
  assert.ok(gate.source.includes('def dep'));

  assert.ok(result.acceptedLeanSource!.includes('theorem helper'));
  assert.ok(!result.acceptedLeanSource!.includes('def dep'), 'dependencies are stored separately');
  assert.ok(result.spentUsd > 0);
  assert.equal(result.workspace.files[0]!.path, 'Helpers.lean');
});

test('the gate rejects a sorry in a helper; the agent fixes it and continues', async () => {
  const { runner } = fakeRunner();
  const { client, seen } = scriptedClient([
    [{ name: 'write_file', args: { path: 'A.lean', content: 'theorem a : True := by sorry' } }, { name: 'set_proof', args: { body: 'simp' } }],
    [{ name: 'check', args: {} }],
    [{ name: 'submit', args: {} }],
    [{ name: 'write_file', args: { path: 'A.lean', content: 'theorem a : True := trivial' } }, { name: 'submit', args: {} }],
  ]);
  const result = await runAgentProver({ ...base, client, runner });
  assert.equal(result.outcome, 'verified');
  const toolReplies = seen[3]!.filter((m) => m.role === 'tool').map((m) => (m as { content: string }).content);
  assert.ok(toolReplies.some((c) => c.includes('sorry at: A.lean:1')), 'check locates the sorry by file and line');
  assert.ok(toolReplies.some((c) => c.includes('Trust policy: sorry')), 'submit says why it was rejected');
});

test('a helper that changes how the statement elaborates is rejected', async () => {
  const { runner } = fakeRunner();
  const { client } = scriptedClient([
    [{ name: 'write_file', args: { path: 'Evil.lean', content: '-- INTERFERE\ninstance : Inhabited Nat := ⟨1⟩' } },
     { name: 'set_proof', args: { body: 'simp' } }, { name: 'submit', args: {} }],
    { text: 'done?' }, { text: 'done?' }, { text: 'done?' },
  ]);
  const result = await runAgentProver({ ...base, client, runner });
  assert.equal(result.outcome, 'proofIncomplete');
  assert.equal(result.stopReason, 'stalled');
  assert.ok(result.transcript.some((t) => t.tool === 'submit' && t.output.includes('different proposition')));
});

test('a give-up below the floor is refused; above it, it ends the run with the report', async () => {
  const { runner } = fakeRunner();
  const events: AgentEvent[] = [];
  // $0.003 a turn; floor $0.005, so the second give-up (turn 2) is still refused.
  const { client, seen } = scriptedClient(
    [[{ name: 'give_up', args: { report: 'only the easy case' } }]],
    { inputTokens: 1000, outputTokens: 500 },
  );
  const result = await runAgentProver({
    ...base, client, runner, budget: { ceilingUsd: 1, floorUsd: 0.005 }, onEvent: (e) => events.push(e),
  });
  assert.equal(result.stopReason, 'gaveUp');
  assert.equal(result.outcome, 'proofIncomplete');
  assert.equal(result.report, 'only the easy case');
  assert.equal(events.filter((e) => e.type === 'pushback').length, 1);
  assert.equal(result.turns, 2);
  const pushback = seen[1]!.find((m) => m.role === 'tool') as { content: string };
  assert.match(pushback.content, /Give-up refused: \$0\.00 spent of the \$0\.01 minimum/);
});

test('the ceiling stops the run before a request could exceed it', async () => {
  const { runner } = fakeRunner();
  const { client, seen } = scriptedClient([[{ name: 'check', args: {} }]]);
  const result = await runAgentProver({
    ...base, client, runner, budget: { ceilingUsd: 0.2, floorUsd: 0 }, maxOutputTokensPerTurn: 32_768,
    pricing: { prompt: 1e-6, completion: 4e-6 },
  });
  // 32768 output tokens at $4/M is $0.13 a turn worst case; the first fits, a
  // second at $0.002 spent plus $0.13 also fits, and so on until it does not.
  assert.equal(result.stopReason, 'budget');
  assert.ok(result.spentUsd <= 0.2);
  assert.ok(seen.length >= 1);
});

test('an environment fault stops the run as verificationBlocked', async () => {
  const { runner } = fakeRunner({ environmentFault: true });
  const { client } = scriptedClient([[{ name: 'check', args: {} }, { name: 'check', args: {} }]]);
  const result = await runAgentProver({ ...base, client, runner });
  assert.equal(result.outcome, 'verificationBlocked');
  assert.equal(result.stopReason, 'environment');
});

test('a model error is retried, then reported as verificationBlocked', async () => {
  const { runner } = fakeRunner();
  let calls = 0;
  const client = { async chat() { calls++; throw new Error('503'); } } as unknown as ModelClient;
  const result = await runAgentProver({ ...base, client, runner });
  assert.equal(calls, 3);
  assert.equal(result.stopReason, 'modelError');
  assert.equal(result.outcome, 'verificationBlocked');
});

test('turn and deadline limits stop the run', async () => {
  const { runner } = fakeRunner();
  const { client } = scriptedClient([[{ name: 'check', args: { up_to: 'Nope.lean' } }]]);
  const byTurns = await runAgentProver({ ...base, client, runner, maxTurns: 4 });
  assert.equal(byTurns.stopReason, 'turns');
  assert.equal(byTurns.turns, 4);

  let clock = 0;
  const byClock = await runAgentProver({ ...base, client, runner, deadlineMs: 1000, now: () => (clock += 400) });
  assert.equal(byClock.stopReason, 'deadline');
});

test('compaction elides old tool output and file contents but keeps call ids paired', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  for (let i = 0; i < 6; i++) {
    messages.push({ role: 'assistant', content: null, toolCalls: [{ id: `id${i}`, name: 'write_file',
      arguments: JSON.stringify({ path: `F${i}.lean`, content: 'x'.repeat(1000) }) }] });
    messages.push({ role: 'tool', toolCallId: `id${i}`, content: `result ${i} ${'y'.repeat(1000)}` });
  }
  compactHistory(messages, 2);
  compactHistory(messages, 2);
  const tools = messages.filter((m) => m.role === 'tool') as Array<{ content: string; toolCallId: string }>;
  assert.equal(tools.filter((m) => m.content.startsWith('[elided]')).length, 4);
  assert.ok(!tools[0]!.content.startsWith('[elided] [elided]'), 'idempotent');
  assert.deepEqual(tools.map((m) => m.toolCallId), ['id0', 'id1', 'id2', 'id3', 'id4', 'id5']);
  const firstCall = (messages[2] as { toolCalls: Array<{ arguments: string }> }).toolCalls[0]!;
  assert.equal(JSON.parse(firstCall.arguments).path, 'F0.lean');
  const lastCall = (messages.at(-2) as { toolCalls: Array<{ arguments: string }> }).toolCalls[0]!;
  assert.ok(lastCall.arguments.includes('xxxx'), 'recent arguments are kept');
});

test('workspace: paths, ordering, edits, and line mapping', () => {
  const ws = new Workspace(FROZEN, 'import Mathlib.Data.Nat.Basic\ndef dep : Nat := 0');
  assert.throws(() => ws.write('../etc/passwd', 'x'), /Invalid file path/);
  assert.throws(() => ws.write('lower.lean', 'x'), /Invalid file path/);
  ws.write('B.lean', 'import Mathlib.Order.Basic\ntheorem b : True := trivial');
  ws.write('A.lean', 'theorem a : True := trivial', undefined);
  ws.reorder(['A.lean', 'B.lean']);
  ws.write('Mid.lean', 'theorem m : True := trivial', 'A.lean');
  assert.deepEqual(ws.paths, ['A.lean', 'Mid.lean', 'B.lean']);
  assert.throws(() => ws.reorder(['A.lean']), /exactly once/);
  ws.edit('Mid.lean', 'trivial', 'by trivial');
  assert.throws(() => ws.edit('Mid.lean', 'nothere', 'x'), /not found/);

  const { source, segments } = ws.compose();
  const lines = source.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['import Mathlib', 'import Mathlib.Data.Nat.Basic', 'import Mathlib.Order.Basic']);
  const midLine = lines.indexOf('theorem m : True := by trivial') + 1;
  assert.equal(locate(segments, midLine), 'Mid.lean:1');
  const bLine = lines.indexOf('theorem b : True := trivial') + 1;
  assert.equal(locate(segments, bLine), 'B.lean:1', 'hoisted imports do not shift file-local lines');
  assert.ok(source.trimEnd().endsWith('theorem target : ∀ n : Nat, n + 0 = n := by sorry'));

  const upTo = ws.compose({ upTo: 'Mid.lean' }).source;
  assert.ok(!upTo.includes('theorem b') && !upTo.includes('theorem target'));
});

test('lookup writes the #check itself and refuses when helper files carry commands', async () => {
  const { runner, calls } = fakeRunner();
  const ws = new Workspace(FROZEN, '');
  ws.write('A.lean', 'theorem a : True := trivial');
  const ctx = { workspace: ws, runner, checkTimeoutMs: 1000, mathlibRoot: null };
  const out = await executeTool(ctx, 'lookup', JSON.stringify({ names: ['Nat.add_zero', 'a', 'bad name!'] }));
  assert.match(out.content, /Nat\.add_zero: @Nat\.add_zero : SomeType/);
  assert.match(out.content, /Rejected \(not constant names\): bad name!/);
  assert.deepEqual(calls[0]!.options.allowTrustViolations, ['sorry', 'commands']);

  ws.write('A.lean', 'set_option maxHeartbeats 0\ntheorem a : True := trivial');
  const refused = await executeTool(ctx, 'lookup', JSON.stringify({ names: ['a'] }));
  assert.match(refused.content, /violate the trust policy \(commands\)/);
  assert.equal(calls.length, 1, 'no Lean run when the agent text fails the scan');
});

test('probe output is limited to the probe, and bad arguments are reported, not thrown', async () => {
  const { runner } = fakeRunner();
  const ws = new Workspace(FROZEN, '');
  ws.write('A.lean', 'theorem a : True := BROKEN');
  const ctx = { workspace: ws, runner, checkTimeoutMs: 1000, mathlibRoot: null };
  const out = await executeTool(ctx, 'probe', JSON.stringify({ code: 'example : True := by sorry' }));
  assert.match(out.content, /1 diagnostics from helper files omitted/);
  assert.match(out.content, /<probe>:1/);
  assert.match((await executeTool(ctx, 'probe', '{not json')).content, /not a JSON object/);
  assert.match((await executeTool(ctx, 'nope', '{}')).content, /unknown tool/);
});

test('Mathlib search indexes declaration heads and ranks name matches first', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lale-mathlib-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'Mathlib', 'Algebra'), { recursive: true });
  await writeFile(join(root, 'Mathlib', 'Algebra', 'Growth.lean'), [
    '/-- doc -/',
    '@[simp] theorem Nat.add_zero_growth (n : Nat) :',
    '    n + 0 = n := rfl',
    '',
    'lemma something_else (n : Nat) : growth n = n + 0 := sorry',
    'private def helper : Nat := 0',
  ].join('\n'));
  clearMathlibSearchCache();
  const index = await loadDeclarationIndex(root);
  assert.equal(index.length, 3);
  const hits = searchDeclarations(index, ['growth', 'n + 0']);
  assert.equal(hits[0]!.text.startsWith('@[simp] theorem Nat.add_zero_growth'), true);
  assert.equal(hits[0]!.file, 'Mathlib/Algebra/Growth.lean');
  assert.equal(hits[0]!.line, 2);
  assert.equal(hits.length, 2);
  assert.deepEqual(searchDeclarations(index, ['   ']), []);
});

test('chat wire format: tool calls and reasoning state round-trip', async () => {
  const parsed = fromWireChoice({
    finish_reason: 'tool_calls',
    message: { content: null, reasoning: 'r', reasoning_details: [{ type: 'reasoning.encrypted', data: 'abc' }],
      tool_calls: [{ id: 'x1', function: { name: 'check', arguments: '{}' } }, { function: { name: 7 } }] },
  });
  assert.equal(parsed.message.toolCalls!.length, 1);
  assert.equal(parsed.reasoning, 'r');
  const wire = toWireMessages([parsed.message, { role: 'tool', toolCallId: 'x1', content: 'ok' }]) as Array<Record<string, unknown>>;
  assert.deepEqual(wire[0]!['reasoning_details'], [{ type: 'reasoning.encrypted', data: 'abc' }]);
  assert.equal((wire[0]!['tool_calls'] as Array<{ id: string }>)[0]!.id, 'x1');
  assert.deepEqual(wire[1], { role: 'tool', tool_call_id: 'x1', content: 'ok' });

  let body: Record<string, unknown> = {};
  const fakeFetch = (async (_url: unknown, init?: { body?: unknown }) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      id: 'r', object: 'chat.completion', created: 0, model: 'm',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: [{ id: 't', type: 'function', function: { name: 'submit', arguments: '{}' } }] } }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const client = new ModelClient({ apiKey: 'k', baseURL: 'https://openrouter.ai/api/v1', modelId: 'openai/gpt-6.2-astra',
    reasoningEffort: 'high', fetch: fakeFetch });
  const reply = await client.chat([{ role: 'user', content: 'go' }], [{ name: 'submit', description: 'd', parameters: { type: 'object' } }], 1000);
  assert.equal(reply.message.toolCalls![0]!.name, 'submit');
  assert.deepEqual(reply.usage, { inputTokens: 12, outputTokens: 3 });
  assert.equal((body['tools'] as unknown[]).length, 1);
  assert.deepEqual(body['reasoning'], { effort: 'high' });
  assert.equal(body['max_tokens'], 1000);
});

test('composition mode offers no file tools, refuses them if called, and caps the proof length', async () => {
  const { runner } = fakeRunner();
  const offered: string[][] = [];
  const turns: Turn[] = [
    [{ name: 'write_file', args: { path: 'Sneaky.lean', content: 'theorem big : True := trivial' } }],
    [{ name: 'set_proof', args: { body: Array.from({ length: 5 }, () => 'skip').join('\n') } }, { name: 'submit', args: {} }],
    [{ name: 'set_proof', args: { body: 'exact step2' } }, { name: 'submit', args: {} }],
  ];
  let index = 0;
  const seen: ChatMessage[][] = [];
  const client = {
    async chat(messages: ChatMessage[], tools: ChatToolSpec[]) {
      offered.push(tools.map((t) => t.name));
      seen.push(structuredClone(messages));
      const turn = turns[index++] as Array<{ name: string; args: Record<string, unknown> }>;
      return { message: { role: 'assistant' as const, content: null,
        toolCalls: turn.map((c, i) => ({ id: `k${index}_${i}`, name: c.name, arguments: JSON.stringify(c.args) })) },
        finishReason: 'tool_calls', reasoning: null, usage: { inputTokens: 10, outputTokens: 10 } };
    },
  } as unknown as ModelClient;
  const result = await runAgentProver({
    ...base, client, runner,
    purpose: { kind: 'composition', steps: [{ leanName: 'step2', text: 'the conclusion' }], citations: [], maxProofLines: 3 },
  });
  assert.equal(result.outcome, 'verified');
  assert.ok(!offered[0]!.includes('write_file') && offered[0]!.includes('set_proof'));
  const replies = seen.flat().filter((m) => m.role === 'tool').map((m) => (m as { content: string }).content);
  assert.ok(replies.some((r) => r.includes('write_file is not available')));
  assert.ok(replies.some((r) => r.includes('the proof is 5 lines; at most 3')));
  assert.equal(result.workspace.files.length, 0);
  assert.match((seen[0]![0] as { content: string }).content, /follows from the author's proved steps/);
});

test('author-step prompts frame the step as the author asserts it, not as a free proof', async () => {
  const { runner } = fakeRunner();
  const { client, seen } = scriptedClient([[{ name: 'give_up', args: { report: 'gap: step 2 needs compactness' } }]]);
  const result = await runAgentProver({
    ...base, client, runner, budget: { ceilingUsd: 1, floorUsd: 0 },
    purpose: { kind: 'authorStep', index: 2, total: 3, claim: 'the set is bounded', sourceText: 'Clearly bounded.',
      earlierSteps: [{ leanName: 'step1', text: 'f is continuous' }],
      citations: [{ leanName: 'laleCite1', text: 'Heine–Borel' }] },
  });
  assert.equal(result.report, 'gap: step 2 needs compactness');
  const [system, user] = seen[0]! as Array<{ content: string }>;
  assert.match(system!.content, /check ONE step of the author's proof/);
  assert.doesNotMatch(system!.content, /hint, not a requirement/);
  assert.match(user!.content, /step 2 of 3\nthe set is bounded/);
  assert.match(user!.content, /`step1`: f is continuous/);
  assert.match(user!.content, /`laleCite1`: Heine–Borel/);
  assert.match(user!.content, /`LaleAux\.target`/);
});

test('a small ceiling shrinks each turn instead of refusing to start', async () => {
  // $40 per million output tokens: one 32k-token turn would be $1.31, over a
  // $0.50 ceiling. The agent must still run, on smaller turns.
  const { runner } = fakeRunner();
  const limits: number[] = [];
  const client = {
    async chat(_messages: ChatMessage[], _tools: ChatToolSpec[], maxTokens: number) {
      limits.push(maxTokens);
      const submit = limits.length === 1
        ? [{ id: 'a', name: 'set_proof', arguments: JSON.stringify({ body: 'simp' }) }, { id: 'b', name: 'submit', arguments: '{}' }]
        : [];
      return { message: { role: 'assistant' as const, content: null, toolCalls: submit }, finishReason: 'tool_calls', reasoning: null,
        usage: { inputTokens: 2000, outputTokens: 1500 } };
    },
  } as unknown as ModelClient;
  const result = await runAgentProver({
    ...base, client, runner, pricing: { prompt: 2e-6, completion: 40e-6 },
    budget: { ceilingUsd: 0.5, floorUsd: 0 },
  });
  assert.equal(result.outcome, 'verified');
  assert.ok(limits[0]! < 32_768 && limits[0]! >= 4096, `first turn limit ${limits[0]}`);

  // And when not even a minimal turn fits, it stops without a request.
  let calls = 0;
  const never = { async chat() { calls++; throw new Error('should not be called'); } } as unknown as ModelClient;
  const broke = await runAgentProver({ ...base, client: never, runner, pricing: { prompt: 2e-6, completion: 40e-6 }, budget: { ceilingUsd: 0.1, floorUsd: 0 } });
  assert.equal(broke.stopReason, 'budget');
  assert.equal(calls, 0);
});

test('a proof written but not submitted is checked when the run stops, and accepted if it holds', async () => {
  // The live case: a 5-line proof of Fermat's little theorem, one turn short of the budget.
  const { runner, calls } = fakeRunner();
  const { client } = scriptedClient([
    [{ name: 'set_proof', args: { body: 'intro n\nsimp' } }],
    [{ name: 'check', args: {} }],
  ]);
  const result = await runAgentProver({ ...base, client, runner, maxTurns: 2 });
  assert.equal(result.outcome, 'verified');
  assert.equal(result.stopReason, 'accepted');
  assert.equal(calls.at(-1)!.options.declarationName, 'target', 'through the same clean-room gate');
  assert.deepEqual(calls.at(-1)!.options.allowTrustViolations ?? [], []);
  assert.ok(result.transcript.some((t) => t.tool === 'submit (automatic, at stop)'));

  // A rejected one stays a failure, and says why.
  const sorryRun = await runAgentProver({
    ...base, runner, maxTurns: 1,
    client: scriptedClient([[{ name: 'set_proof', args: { body: 'sorry' } }]]).client,
  });
  assert.equal(sorryRun.outcome, 'proofIncomplete');
  assert.match(sorryRun.report!, /checked at stop and rejected/);

  // A cancelled run is not submitted on the user's behalf.
  const controller = new AbortController();
  const { runner: r2, calls: c2 } = fakeRunner();
  const cancelled = await runAgentProver({
    ...base, runner: r2, signal: controller.signal,
    client: { async chat() {
      controller.abort();
      return { message: { role: 'assistant' as const, content: null, toolCalls: [{ id: 'x', name: 'set_proof', arguments: '{"body":"simp"}' }] },
        finishReason: 'tool_calls', reasoning: null, usage: { inputTokens: 1, outputTokens: 1 } };
    } } as unknown as ModelClient,
  });
  assert.equal(cancelled.stopReason, 'aborted');
  assert.equal(c2.length, 0, 'no gate run after cancellation');
});

test('refute: a Lean-checked negation ends the run as refuted, whatever the floor', async () => {
  const { runner, calls } = fakeRunner();
  const { client } = scriptedClient([
    [{ name: 'refute', args: { body: 'intro h\nexact absurd (h 1) (by decide)', explanation: 'Fails at n = 1.' } }],
  ]);
  const result = await runAgentProver({ ...base, client, runner, budget: { ceilingUsd: 5, floorUsd: 4 } });
  assert.equal(result.outcome, 'refuted');
  assert.equal(result.stopReason, 'refuted');
  assert.equal(result.report, 'Fails at n = 1.');
  assert.equal(result.turns, 1, 'no give-up floor applies to a certified counterexample');
  const gate = calls.at(-1)!;
  assert.equal(gate.options.declarationName, 'target_refuted');
  assert.deepEqual(gate.options.allowTrustViolations ?? [], [], 'same clean-room rules as a proof');
  assert.match(gate.source, /theorem target_refuted : ¬ \(∀ n : Nat, n \+ 0 = n\) := by\n  intro h/);
  assert.match(result.refutationLeanSource!, /theorem target_refuted/);
});

test('refute: a helper that changes what the statement means cannot be used to refute it', async () => {
  const { runner } = fakeRunner();
  const { client, seen } = scriptedClient([
    [{ name: 'write_file', args: { path: 'Evil.lean', content: '-- INTERFERE' } },
     { name: 'refute', args: { body: 'simp', explanation: 'trust me' } }],
    { text: 'hm' }, { text: 'hm' }, { text: 'hm' },
  ]);
  const result = await runAgentProver({ ...base, client, runner });
  assert.notEqual(result.outcome, 'refuted');
  const replies = seen.flat().filter((m) => m.role === 'tool').map((m) => (m as { content: string }).content);
  assert.ok(replies.some((r) => r.includes('elaborates differently than the frozen one')));
});

test('composition: glue only, and refute is not offered', async () => {
  const { runner } = fakeRunner();
  const offered: string[][] = [];
  const turns = [
    [{ name: 'set_proof', args: { body: 'intro n\nexact ⟨step1 n, by positivity⟩' } }, { name: 'submit', args: {} }],
    [{ name: 'set_proof', args: { body: 'intro n\n-- simp would also work\nexact step1 n' } }, { name: 'submit', args: {} }],
  ];
  let i = 0;
  const seen: ChatMessage[][] = [];
  const client = {
    async chat(messages: ChatMessage[], tools: ChatToolSpec[]) {
      offered.push(tools.map((t) => t.name));
      seen.push(structuredClone(messages));
      const turn = turns[i++]!;
      return { message: { role: 'assistant' as const, content: null,
        toolCalls: turn.map((c, j) => ({ id: `g${i}_${j}`, name: c.name, arguments: JSON.stringify(c.args) })) },
        finishReason: 'tool_calls', reasoning: null, usage: { inputTokens: 10, outputTokens: 10 } };
    },
  } as unknown as ModelClient;
  const result = await runAgentProver({
    ...base, client, runner,
    purpose: { kind: 'composition', steps: [{ leanName: 'step1', text: 's' }], citations: [], maxProofLines: 30 },
  });
  assert.equal(result.outcome, 'verified', 'logic-only proof accepted, even with "simp" in a comment');
  assert.ok(!offered[0]!.includes('refute'));
  const replies = seen.flat().filter((m) => m.role === 'tool').map((m) => (m as { content: string }).content);
  assert.ok(replies.some((r) => /Rejected: positivity proves new mathematics/.test(r)), 'nested `by positivity` is caught');
});

test('findAutomationTactics: tactics anywhere, not names or comments', async () => {
  const { findAutomationTactics } = await import('../src/pipeline/agent/tools.js');
  assert.deepEqual(findAutomationTactics('exact ⟨h1, by nlinarith [sq_nonneg x]⟩'), ['nlinarith']);
  assert.deepEqual(findAutomationTactics('simp!\nexact?'), ['simp', 'exact?']);
  assert.deepEqual(findAutomationTactics('obtain ⟨k, hk⟩ := step1 a ha\nexact Nat.decide_eq_true hk -- omega'), []);
  assert.deepEqual(findAutomationTactics('have hsimp := step2\nexact hsimp'), []);
});

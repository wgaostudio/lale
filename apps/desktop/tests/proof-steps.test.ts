import assert from 'node:assert/strict';
import test from 'node:test';
import { containsObligation, scanTrustViolations, type LeanCheckOptions, type LeanCheckResult, type LeanRunner } from '@lale/lean-runner';
import type { ChatMessage, ModelClient } from '@lale/translator';
import { checkProofSkeleton, withPremises, type ProofSkeletonOptions } from '../src/pipeline/proof-steps.js';
import type { NormalizedClaimContext } from '../src/pipeline/context.js';
import { TACTIC_LADDER } from '../src/pipeline/tactics.js';

// The author-steps pipeline end to end, with every model and Lean faked:
// segmentation, citation and step statements, back-translation, the agent's
// tool calls, and Lean's verdicts are all scripted. What is under test is the
// orchestration — what gets frozen, assumed, proved, and composed.

const FROZEN = {
  leanSource: 'import Mathlib\ntheorem target : ∀ n : Nat, n + 0 = n := by sorry',
  theoremName: 'target',
  normalizedGoalTerm: 'GOAL(∀ n : Nat, n + 0 = n)',
};

const CONTEXT: NormalizedClaimContext = {
  targetClaimId: 'thm', targetLabel: 'thm:t', targetKind: 'theorem',
  statementText: 'For every n, n + 0 = n.', ambientContext: '',
  proofText: 'By the lemma of [X], n + 0 = n. Hence the claim.',
  resolvedDependencies: [], unresolvedDependencyLabels: [], parserIssues: [],
};

interface Scenario {
  citations?: Array<{ name: string; statement: string }>;
  steps: Array<{ claim: string; cites?: number[] }>;
  /** Theorem names the tactic ladder (or a composition tactic) can close. */
  ladderCloses?: Set<string>;
  /** Step claims whose first Lean statement reads back wrong. */
  misstatedOnce?: Set<string>;
  /** What the agent does, keyed by purpose. */
  agent?: { step?: 'prove' | 'giveUp'; composition?: 'prove' | 'giveUp'; citation?: 'prove' | 'giveUp' };
}

function goalOf(source: string, name: string): string | null {
  const match = new RegExp(`theorem ${name} : (.*?) := by`).exec(source);
  return match ? `GOAL(${match[1]})` : null;
}

function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`theorem ${name} :`);
  const after = source.slice(source.indexOf(':= by', start) + 5);
  const lines: string[] = [];
  for (const line of after.split('\n').slice(1)) {
    if (!line.startsWith('  ')) break;
    lines.push(line.trim());
  }
  return lines.join('\n') || after.split('\n')[0]!.trim();
}

function fakeRunner(scenario: Scenario) {
  const checks: Array<{ source: string; options: LeanCheckOptions }> = [];
  const runner = {
    async check(source: string, options: LeanCheckOptions = {}): Promise<LeanCheckResult> {
      checks.push({ source, options });
      const base = { diagnostics: [], trustViolations: [], elapsedMs: 1, stdout: '', stderr: '' };
      const violations = scanTrustViolations(source).filter((v) => !(options.allowTrustViolations ?? []).includes(v.name));
      if (violations.length) {
        return { ...base, status: 'blocked', trustViolations: violations, diagnostics: [{ kind: 'error', message: 'Trust policy violation' }] };
      }
      const name = options.declarationName;
      if (!name) return { ...base, status: 'ok' };
      const goal = goalOf(source, name);
      if (!goal) return { ...base, status: 'blocked', diagnostics: [{ kind: 'error', message: 'Missing kernel declaration certificate' }] };
      const body = bodyOf(source, name);
      const isLadderOrComposition = TACTIC_LADDER.includes(body) || /^(exact|intros|simpa)\b/.test(body);
      if (body !== 'sorry' && isLadderOrComposition && !scenario.ladderCloses?.has(name)) {
        return { ...base, status: 'error', diagnostics: [{ kind: 'error', message: `${body} failed`, line: 1 }] };
      }
      return { ...base, status: 'ok', certificate: { declarationName: name, normalizedGoalTerm: goal, axioms: [] } };
    },
  };
  return { runner: runner as unknown as LeanRunner, checks };
}

function fakeClients(scenario: Scenario) {
  const calls: string[] = [];
  let stepCounter = 0;
  const misstated = new Set<string>();
  const complete = async (system: string, user: string) => {
    let text: string;
    if (system.includes('proof analyst')) {
      calls.push('segment');
      text = JSON.stringify({
        citations: scenario.citations?.map((c) => ({ ...c, sourceText: 'by [X]' })) ?? [],
        steps: scenario.steps.map((s, i) => ({ claim: s.claim, sourceText: `sentence ${i + 1}`, uses: i ? [i] : [], cites: s.cites ?? [] })),
      });
    } else if (system.includes('ONE step')) {
      const claim = /## This step[^\n]*\n([^\n]+)/.exec(user)?.[1] ?? `step${stepCounter}`;
      const index = scenario.steps.findIndex((s) => user.includes(s.claim));
      calls.push(`stateStep:${index + 1}`);
      void claim;
      const name = `step${index + 1}`;
      text = JSON.stringify({ theoremName: name, leanSource: `import Mathlib\ntheorem ${name} : ∀ n : Nat, P${index + 1} n := by sorry` });
      stepCounter++;
    } else if (system.includes('autoformalization assistant')) {
      calls.push('stateCitation');
      text = JSON.stringify({ theoremName: 'cited', leanSource: 'import Mathlib\ntheorem cited : ∀ n : Nat, C n := by sorry' });
    } else if (system.includes('mathematical writing assistant')) {
      text = user.includes('P') ? `reads back: ${/theorem (\w+)/.exec(user)?.[1]}` : 'reads back';
    } else if (system.includes('proof step comparison')) {
      calls.push('compareStep');
      const thisStep = /## This step, in the author's words\n([^\n]*)/.exec(user)?.[1] ?? '';
      assert.match(user, /## Theorem being proved\nFor every n, n \+ 0 = n\./, 'the step is judged against the theorem');
      const stepClaim = scenario.steps.find((s) => s.claim === thisStep)?.claim;
      const wrong = stepClaim && scenario.misstatedOnce?.has(stepClaim) && !misstated.has(stepClaim);
      if (wrong) misstated.add(stepClaim!);
      text = JSON.stringify({ agreement: wrong ? 'disagree' : 'agree', explanation: wrong ? 'weaker than the step' : 'same' });
    } else if (system.includes('statement comparison')) {
      const stepClaim = scenario.steps.find((s) => user.includes(s.claim))?.claim;
      const wrong = stepClaim && scenario.misstatedOnce?.has(stepClaim) && !misstated.has(stepClaim);
      if (wrong) misstated.add(stepClaim!);
      text = JSON.stringify({ agreement: wrong ? 'disagree' : 'agree', explanation: wrong ? 'weaker than the step' : 'same' });
    } else if (system.includes('You propose Lean 4')) {
      calls.push('oneShot');
      text = JSON.stringify({ proofBody: 'exact proofOneShot' });
    } else {
      throw new Error(`Unexpected model call: ${system.slice(0, 60)}`);
    }
    return { text, usage: { inputTokens: 10, outputTokens: 10 } };
  };
  const client = { complete } as unknown as ModelClient;

  const agentPurposes: string[] = [];
  const agentClient = {
    async chat(messages: ChatMessage[]) {
      const first = (messages[1] as { content: string }).content;
      const purpose = first.includes('You are checking step') ? 'step' : first.includes('## Composition') ? 'composition' : 'citation';
      const turn = messages.filter((m) => m.role === 'assistant').length;
      if (turn === 0) agentPurposes.push(purpose);
      const action = scenario.agent?.[purpose as 'step'] ?? 'giveUp';
      const script = action === 'prove'
        ? [[['set_proof', { body: 'intro n\nexact helper n' }], ['submit', {}]]]
        : [[['give_up', { report: `cannot do the ${purpose}: missing link` }]]];
      const calls = script[Math.min(turn, script.length - 1)]!;
      return {
        message: { role: 'assistant' as const, content: null,
          toolCalls: calls.map(([name, args], i) => ({ id: `t${turn}_${i}`, name: name as string, arguments: JSON.stringify(args) })) },
        finishReason: 'tool_calls', reasoning: null, usage: { inputTokens: 1000, outputTokens: 100 },
      };
    },
  } as unknown as ModelClient;
  return { client, agentClient, calls, agentPurposes };
}

async function run(scenario: Scenario, withAgent = true) {
  const { runner, checks } = fakeRunner(scenario);
  const { client, agentClient, calls, agentPurposes } = fakeClients(scenario);
  const options: ProofSkeletonOptions = withAgent
    ? { agent: { client: agentClient, pricing: { prompt: 1e-6, completion: 4e-6 }, mathlibRoot: null,
        stepBudget: { ceilingUsd: 1, floorUsd: 0 } } }
    : {};
  const result = await checkProofSkeleton(client, client, client, runner, FROZEN, CONTEXT, 'test', 'test', options);
  return { result, checks, calls, agentPurposes };
}

test('author steps are proved by the agent and composed into the frozen theorem', async () => {
  const { result, agentPurposes } = await run({
    steps: [{ claim: 'first fact' }, { claim: 'the conclusion' }],
    ladderCloses: new Set(['target']),
    agent: { step: 'prove' },
  });
  assert.deepEqual(result.steps.map((s) => [s.status, s.proof.status, s.proof.closedBy]), [
    ['checked', 'proved', 'agent'], ['checked', 'proved', 'agent'],
  ]);
  assert.deepEqual(agentPurposes, ['step', 'step']);
  assert.equal(result.composition.status, 'proved');
  assert.deepEqual(result.composition.conditionalOn, []);
  assert.equal(result.composition.closedBy, 'exact target_step2');
  const source = result.composition.leanSource!;
  assert.ok(source.indexOf('theorem target_step1') < source.indexOf('theorem target_step2'));
  assert.ok(source.indexOf('theorem target_step2') < source.indexOf('theorem target :'));
  assert.ok(containsObligation(FROZEN.leanSource, source, 'target'), 'the frozen header survives verbatim');
  assert.ok(result.agentSpendUsd > 0);
});

test('a cited result is stated, screened, assumed, and makes the result conditional', async () => {
  const { result, checks } = await run({
    citations: [{ name: "Bergman's Gap Theorem", statement: 'No algebra has GK dimension strictly between 1 and 2.' }],
    steps: [{ claim: 'apply the gap theorem', cites: [1] }, { claim: 'the conclusion' }],
    ladderCloses: new Set(['target_givenCitations']),
    agent: { step: 'prove', citation: 'giveUp' },
  });
  const [citation] = result.citations;
  assert.equal(citation!.status, 'assumed');
  assert.equal(citation!.leanName, 'laleCite_target_1');
  assert.match(citation!.leanSource!, /def laleCite_target_1 : Prop := \(∀ n : Nat, C n\)/);
  assert.ok(checks.some((c) => c.options.declarationName === 'laleCite_target_1_refuted'), 'refutation was tried');

  assert.match(result.steps[0]!.leanSource!, /theorem target_step1 : laleCite_target_1 → \(∀ n : Nat, P1 n\)/, 'the citation is a premise of the step');
  assert.doesNotMatch(result.steps[1]!.leanSource!, /laleCite_target_1/);

  assert.equal(result.composition.status, 'proved');
  assert.deepEqual(result.composition.conditionalOn, ['laleCite_target_1']);
  assert.match(result.composition.obligation!, /theorem target_givenCitations : laleCite_target_1 → \(∀ n : Nat, n \+ 0 = n\)/);
  assert.ok(result.composition.leanSource!.startsWith('import Mathlib\nsection'), 'the citation prelude comes first');
  assert.ok(!scanTrustViolations(result.composition.leanSource!).length, 'no axioms, no sorry');
});

test('a citation Mathlib can prove is discharged, not assumed', async () => {
  const { result } = await run({
    citations: [{ name: 'a standard fact', statement: 'n + 0 = n' }],
    steps: [{ claim: 'the conclusion', cites: [1] }],
    ladderCloses: new Set(['laleCite_target_1_stmt', 'target']),
    agent: { step: 'prove' },
  });
  assert.equal(result.citations[0]!.status, 'discharged');
  assert.match(result.citations[0]!.leanSource!, /theorem laleCite_target_1_holds : laleCite_target_1/);
  assert.doesNotMatch(result.steps[0]!.leanSource!, /laleCite_target_1 →/, 'a discharged citation is not a premise');
  assert.deepEqual(result.composition.conditionalOn, []);
});

test('a citation Lean refutes is rejected, and the steps citing it are not checked', async () => {
  const { result, agentPurposes } = await run({
    citations: [{ name: 'a false lemma', statement: 'every n is 0' }],
    steps: [{ claim: 'apply it', cites: [1] }],
    ladderCloses: new Set(['laleCite_target_1_refuted']),
    agent: { step: 'prove' },
  });
  assert.equal(result.citations[0]!.status, 'rejected');
  assert.match(result.citations[0]!.reason, /refutes/);
  assert.equal(result.steps[0]!.proof.status, 'skipped');
  assert.match(result.steps[0]!.proof.diagnostics[0]!, /cited result 1 \(a false lemma\), which is rejected/);
  assert.deepEqual(agentPurposes, [], 'no agent ran on a step resting on a false premise');
  assert.equal(result.composition.status, 'skipped');
});

test("a step whose Lean statement does not read back as the author's is restated", async () => {
  const { result, calls } = await run({
    steps: [{ claim: 'the conclusion' }],
    misstatedOnce: new Set(['the conclusion']),
    ladderCloses: new Set(['target_step1', 'target']),
    agent: { step: 'prove' },
  });
  assert.deepEqual(calls.filter((c) => c.startsWith('stateStep')), ['stateStep:1', 'stateStep:1']);
  assert.equal(result.steps[0]!.status, 'checked');
  assert.equal(result.steps[0]!.proof.closedBy, 'rfl', 'the ladder runs before the agent');
});

test("an unprovable step carries the agent's account of the gap, and nothing is composed", async () => {
  const { result } = await run({
    steps: [{ claim: 'a step with a gap' }, { claim: 'the conclusion' }],
    agent: { step: 'giveUp' },
  });
  assert.equal(result.steps[0]!.proof.status, 'unproved');
  assert.equal(result.steps[0]!.proof.report, 'cannot do the step: missing link');
  assert.equal(result.composition.status, 'skipped');
});

test('steps that do not compose are reported as a gap at the end', async () => {
  const { result, agentPurposes } = await run({
    steps: [{ claim: 'first fact' }],
    agent: { step: 'prove', composition: 'giveUp' },
  });
  assert.equal(result.steps[0]!.proof.status, 'proved');
  assert.equal(result.composition.status, 'unproved');
  assert.equal(result.composition.report, 'cannot do the composition: missing link');
  assert.deepEqual(agentPurposes, ['step', 'composition']);
});

test('without an agent, steps get the one-shot prover and composition is left to the caller', async () => {
  const { result, calls } = await run({ steps: [{ claim: 'the conclusion' }] }, false);
  assert.ok(calls.includes('oneShot'));
  assert.equal(result.composition.status, 'skipped');
});

test('withPremises and containsObligation', () => {
  assert.equal(
    withPremises('import Mathlib\nopen Nat\ntheorem s : ∀ n, P n := by sorry', 's', ['laleCite_target_1', 'laleCite2']),
    'import Mathlib\nopen Nat\ntheorem s : laleCite_target_1 → laleCite2 → (∀ n, P n) := by sorry',
  );
  const frozen = 'import Mathlib\ntheorem t : True := by sorry';
  assert.ok(containsObligation(frozen, 'import Mathlib\ntheorem h : True := trivial\ntheorem t : True := by\n  exact h', 't'));
  assert.ok(!containsObligation(frozen, 'theorem t : False := by\n  exact h', 't'), 'a changed statement fails');
  assert.ok(!containsObligation(frozen, 'def t : Nat := 0\ntheorem t : True := by\n  trivial', 't'), 'a second declaration of the name fails');
  assert.ok(containsObligation(frozen, '-- theorem t : x\ntheorem t : True := by\n  trivial', 't'), 'comments do not count');
});

test('assumptions inherited from a cited claim become premises of every step and of the result', async () => {
  const scenario: Scenario = {
    steps: [{ claim: 'first fact' }, { claim: 'the conclusion' }],
    ladderCloses: new Set(['target_givenCitations']),
    agent: { step: 'prove' },
  };
  const { runner: r } = fakeRunner(scenario);
  const { client, agentClient } = fakeClients(scenario);
  const context: NormalizedClaimContext = {
    ...CONTEXT,
    resolvedDependencies: [{
      fingerprint: 'f', label: 'thm:three', kind: 'claim', statementText: 'Theorem 3', verified: true,
      leanDeclaration: 'def laleCite_three_1 : Prop := True\ntheorem three_givenCitations : laleCite_three_1 → Q := by exact x',
      assumes: [{ leanName: 'laleCite_three_1', name: 'Bergman', statement: 'no GK dim in (1,2)', from: 'thm:three' }],
    }],
  };
  const result = await checkProofSkeleton(client, client, client, r, FROZEN, context, 'test', 'test', {
    agent: { client: agentClient, pricing: { prompt: 1e-6, completion: 4e-6 }, mathlibRoot: null },
  });
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0]!.inheritedFrom, 'thm:three');
  assert.equal(result.citationPrelude, '', 'the definition lives in the dependency, not here');
  for (const s of result.steps) assert.match(s.leanSource!, /: laleCite_three_1 → \(/);
  assert.equal(result.composition.status, 'proved');
  assert.deepEqual(result.composition.conditionalOn, ['laleCite_three_1']);
});

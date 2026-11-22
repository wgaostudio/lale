import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseLatexDocument, PARSER_VERSION } from '@lale/document-parser';
import {
  AcceptedRunResponse,
  ProjectLookupResponse,
  ProverBudgetPreset,
  ProverModel,
  RunResult,
  type VerificationMode,
} from '@lale/protocol';
import { CHECK_ORDER, prepareTestCopy } from './research/smoktunowicz.js';

// ---------------------------------------------------------------------------
// Research end-to-end run: a whole paper, claim by claim
//
//   pnpm research -- --source <reading copy .tex> [--budget hard] [--model id]
//                    [--max-usd 150] [--only lem:3,thm:main] [--timeout-minutes 240]
//   pnpm research -- --source <reading copy .tex> --prepare-only
//
// --prepare-only writes the test copy and stops: no service, token or spend.
// Paste that file into an Overleaf project to run the same claims from the
// side panel.
//
// Live only: needs a running desktop service, LALE_DESKTOP_TOKEN, Lean, and
// credit on the OpenRouter key. Definitions are formalized; results go
// through Check proof steps, in dependency order, in one project, so each
// sees the ones before it. The spend cap is checked between claims — a claim
// already running is bounded by its own per-step ceilings, not by the cap.
// ---------------------------------------------------------------------------

const root = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const sourcePath = option('source');
if (!sourcePath) throw new Error('Pass --source <path to the reading copy .tex>.');
const budget = ProverBudgetPreset.parse(option('budget') ?? 'hard');
const model = option('model') ? ProverModel.parse(option('model')) : undefined;
const maxUsd = Number(option('max-usd') ?? '150');
const timeoutMinutes = Number(option('timeout-minutes') ?? '240');
const only = option('only')?.split(',').filter(Boolean);
if (!(maxUsd > 0) || !(timeoutMinutes > 0)) throw new Error('--max-usd and --timeout-minutes must be positive.');

const testCopy = prepareTestCopy(await readFile(sourcePath, 'utf8'));
const localDir = join(root, 'evals', 'research', 'smoktunowicz', 'local');
await mkdir(localDir, { recursive: true });
await writeFile(join(localDir, 'test-copy.tex'), testCopy);
const doc = parseLatexDocument(testCopy);
if (args.includes('--prepare-only')) {
  console.log(`Test copy: ${join(localDir, 'test-copy.tex')} (${doc.claims.length} claims). Check order: ${CHECK_ORDER.join(' ')}`);
  process.exit(0);
}

const token = process.env['LALE_DESKTOP_TOKEN'];
if (!token) throw new Error('Set LALE_DESKTOP_TOKEN to the local companion token.');
const base = process.env['LALE_DESKTOP_URL'] ?? 'http://127.0.0.1:8765';
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Desktop ${path} returned HTTP ${response.status}`);
  return response.json();
}

const project = ProjectLookupResponse.parse(await api('/v1/projects', {
  protocolVersion: 1, sourceKind: 'overleaf', overleafProjectId: `research-smoktunowicz-${randomUUID()}`,
  overleafUrl: null, documentFingerprint: doc.fingerprint, name: 'Research: Smoktunowicz 2006',
})).project!;

interface ClaimReport {
  label: string;
  mode: VerificationMode;
  runId?: string;
  outcome: string;
  minutes: number;
  agentSpendUsd: number;
  argument?: RunResult['argument'];
  diagnostics?: string[];
  error?: string;
}

const reports: ClaimReport[] = [];
let spent = 0;
for (const label of CHECK_ORDER) {
  if (only && !only.includes(label)) continue;
  if (spent >= maxUsd) {
    reports.push({ label, mode: 'proofSkeleton', outcome: 'skipped (spend cap reached)', minutes: 0, agentSpendUsd: 0 });
    continue;
  }
  const claim = doc.claims.find((c) => c.label === label);
  if (!claim) throw new Error(`Claim ${label} missing from the test copy`);
  const mode: VerificationMode = claim.kind === 'definition' ? 'formalizeOnly' : 'proofSkeleton';
  const start = Date.now();
  console.log(`→ ${label} (${mode})`);
  try {
    const accepted = AcceptedRunResponse.parse(await api('/v1/verify', {
      protocolVersion: 1, requestId: randomUUID(), projectId: project.id, claimId: claim.id,
      snapshot: { source: 'overleaf', projectId: project.overleafProjectId, documentText: testCopy,
        selectedText: null, url: null, capturedAt: new Date().toISOString() },
      parsedDocumentFingerprint: doc.fingerprint, parserVersion: PARSER_VERSION, mode,
      ...(mode === 'proofSkeleton' ? { prover: { budget, ...(model ? { model } : {}) } } : {}),
    }));
    let result: RunResult | null = null;
    while (Date.now() - start < timeoutMinutes * 60_000) {
      result = RunResult.parse(await api(`/v1/runs/${accepted.runId}`));
      if (result.status === 'finished' || result.status === 'cancelled') break;
      if (result.status === 'paused') {
        await api(`/v1/runs/${accepted.runId}/informal-audit/acknowledge`, { reason: 'Research run: continue to formal checking.' });
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    const done = result && (result.status === 'finished' || result.status === 'cancelled') ? result : null;
    const agentSpendUsd = done?.argument?.agentSpendUsd ?? 0;
    spent += agentSpendUsd;
    reports.push({
      label, mode, runId: accepted.runId, outcome: done?.outcome ?? 'timeout',
      minutes: Math.round((Date.now() - start) / 6000) / 10, agentSpendUsd,
      ...(done?.argument ? { argument: done.argument } : {}), ...(done ? { diagnostics: done.diagnostics } : {}),
    });
  } catch (error) {
    reports.push({ label, mode, outcome: 'error', minutes: Math.round((Date.now() - start) / 6000) / 10, agentSpendUsd: 0, error: String(error) });
  }
  const last = reports.at(-1)!;
  console.log(`  ${last.outcome}, ${last.minutes} min, $${last.agentSpendUsd.toFixed(2)} agent spend (total $${spent.toFixed(2)})`);
}

function summary(): string {
  const lines = [
    '# Smoktunowicz 2006, checked by lale', '',
    `Budget preset: ${budget}${model ? `, model ${model}` : ''}. Agent spend: $${spent.toFixed(2)} (cap $${maxUsd}).`,
    'Model-call spend outside the agent (formalization, faithfulness checks) is in each run log.', '',
    '| Claim | Mode | Outcome | Minutes | Agent $ |', '|---|---|---|---|---|',
    ...reports.map((r) => `| ${r.label} | ${r.mode} | ${r.outcome} | ${r.minutes} | ${r.agentSpendUsd.toFixed(2)} |`),
  ];
  for (const r of reports.filter((x) => x.argument)) {
    const a = r.argument!;
    lines.push('', `## ${r.label}`, '');
    for (const s of a.steps) {
      const state = s.status !== 'checked' ? `not stated (${s.status})` : s.proofStatus;
      lines.push(`${s.idx}. **${state}**${s.closedBy ? ` by ${s.closedBy}` : ''} — ${s.claim.replace(/\s+/g, ' ')}`);
      if (s.report) lines.push(`   - Prover: ${s.report.replace(/\s+/g, ' ')}`);
    }
    for (const c of a.citations) lines.push(`- Cited: ${c.name} — **${c.status}**${c.inheritedFrom ? ` (via ${c.inheritedFrom})` : ''}: ${c.reason}`);
    if (a.composition) lines.push(`- Composition: **${a.composition.status}**${a.composition.report ? ` — ${a.composition.report}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = join(root, 'reports', `research-smoktunowicz-${stamp}`);
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(`${reportPath}.json`, JSON.stringify({ budget, model: model ?? null, maxUsd, spent, reports }, null, 2));
await writeFile(`${reportPath}.md`, summary());
console.log(`Report: ${reportPath}.md`);

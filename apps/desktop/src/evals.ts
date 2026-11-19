import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseLatexDocument, PARSER_VERSION } from '@lale/document-parser';
import { AcceptedRunResponse, ProjectLookupResponse, RunResult } from '@lale/protocol';
import { judgeEvalCase, loadEvalCases, type EvalCase } from './eval-cases.js';

// Offline: validates the fixtures. With --live: runs them against a running
// desktop service, with paid model requests, and writes a report. `--only id,id`
// runs a subset; check proof steps cases can take many minutes each.

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cases = loadEvalCases(JSON.parse(await readFile(join(root, 'evals/claims/cases.json'), 'utf8')));
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex >= 0 ? new Set((process.argv[onlyIndex + 1] ?? '').split(',').filter(Boolean)) : null;
const selected = only ? cases.filter((c) => only.has(c.id)) : cases;
if (only && selected.length !== only.size) throw new Error(`Unknown case id in --only: ${[...only].filter((id) => !cases.some((c) => c.id === id)).join(', ')}`);

if (!process.argv.includes('--live')) {
  const steps = cases.filter((c) => c.mode === 'proofSkeleton').length;
  console.log(`${cases.length} fixtures valid (${steps} check proof steps). Use pnpm evals -- --live with LALE_DESKTOP_TOKEN to run paid model evaluations.`);
  process.exit(0);
}

const token = process.env['LALE_DESKTOP_TOKEN'];
if (!token) throw new Error('Set LALE_DESKTOP_TOKEN to the local companion token before live evaluations.');
const base = process.env['LALE_DESKTOP_URL'] ?? 'http://127.0.0.1:8765';
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Desktop ${path} returned HTTP ${response.status}`);
  return response.json();
}

async function runCase(fixture: EvalCase): Promise<Record<string, unknown>> {
  const start = Date.now();
  const doc = parseLatexDocument(fixture.latex);
  const project = ProjectLookupResponse.parse(await api('/v1/projects', { protocolVersion: 1, sourceKind: 'overleaf',
    overleafProjectId: `eval-${randomUUID()}`, overleafUrl: null, documentFingerprint: doc.fingerprint, name: `Evaluation: ${fixture.id}` }));
  const accepted = AcceptedRunResponse.parse(await api('/v1/verify', {
    protocolVersion: 1, requestId: randomUUID(), projectId: project.project!.id, claimId: fixture.claimId,
    snapshot: { source: 'overleaf', projectId: project.project!.overleafProjectId, documentText: fixture.latex,
      selectedText: null, url: null, capturedAt: new Date().toISOString() },
    parsedDocumentFingerprint: doc.fingerprint, parserVersion: PARSER_VERSION,
    mode: fixture.mode, ...(fixture.prover ? { prover: fixture.prover } : {}),
  }));
  let result: RunResult | null = null;
  while (Date.now() - start < fixture.timeoutMinutes * 60_000) {
    result = RunResult.parse(await api(`/v1/runs/${accepted.runId}`));
    if (result.status === 'finished' || result.status === 'cancelled') break;
    if (result.status === 'paused') {
      await api(`/v1/runs/${accepted.runId}/informal-audit/acknowledge`, { reason: 'Synthetic evaluation fixture: continue to formal kernel checking.' });
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const finished = result && (result.status === 'finished' || result.status === 'cancelled') ? result : null;
  const verdict = judgeEvalCase(fixture, finished);
  return {
    id: fixture.id, mode: fixture.mode, runId: accepted.runId, outcome: finished?.outcome ?? 'timeout', ...verdict,
    agentSpendUsd: finished?.argument?.agentSpendUsd ?? null, durationMs: Date.now() - start,
    argument: finished?.argument ?? null, diagnostics: finished?.diagnostics,
  };
}

const reports: Array<Record<string, unknown>> = [];
for (const fixture of selected) {
  try {
    reports.push(await runCase(fixture));
  } catch (error) {
    reports.push({ id: fixture.id, passed: false, falseAcceptance: false, failures: [String(error)] });
  }
  const last = reports.at(-1)!;
  console.log(`${last['passed'] ? 'PASS' : 'FAIL'} ${fixture.id}${(last['failures'] as string[]).length ? ` — ${(last['failures'] as string[]).join('; ')}` : ''}`);
}

const path = join(root, 'reports', `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await mkdir(join(root, 'reports'), { recursive: true });
await writeFile(path, JSON.stringify({ live: true, cases: reports }, null, 2));
console.table(reports.map((r) => ({ id: r['id'], outcome: r['outcome'], passed: r['passed'], falseAcceptance: r['falseAcceptance'],
  agentUsd: r['agentSpendUsd'], minutes: typeof r['durationMs'] === 'number' ? Math.round(r['durationMs'] / 6000) / 10 : null })));
console.log(`Report: ${path}`);
if (reports.some((r) => r['falseAcceptance'])) console.log('FALSE ACCEPTANCES — a false theorem passed. Treat as a release blocker.');
if (reports.some((r) => !r['passed'])) process.exitCode = 1;

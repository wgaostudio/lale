import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseLatexDocument, PARSER_VERSION } from '@lale/document-parser';
import { AcceptedRunResponse, ProjectLookupResponse, RunResult } from '@lale/protocol';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cases = JSON.parse(await readFile(join(root, 'evals/claims/cases.json'), 'utf8')) as Array<{ id: string; claimId: string; latex: string; expected: string[] }>;
const live = process.argv.includes('--live');
if (!live) {
  for (const fixture of cases) {
    const doc = parseLatexDocument(fixture.latex);
    if (!doc.claims.some(c => c.id === fixture.claimId)) throw new Error(`Fixture target missing: ${fixture.id}`);
  }
  console.log(`${cases.length} fixtures valid. Use pnpm evals -- --live with LALE_DESKTOP_TOKEN to run paid model evaluations.`);
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
const reports: Array<Record<string, unknown>> = [];
for (const fixture of cases) {
  const start = Date.now();
  try {
    const doc = parseLatexDocument(fixture.latex);
    const project = ProjectLookupResponse.parse(await api('/v1/projects', { protocolVersion: 1, sourceKind: 'overleaf', overleafProjectId: `eval-${randomUUID()}`, overleafUrl: null, documentFingerprint: doc.fingerprint, name: `Evaluation: ${fixture.id}` }));
    const accepted = AcceptedRunResponse.parse(await api('/v1/verify', { protocolVersion: 1, requestId: randomUUID(), projectId: project.project!.id, claimId: fixture.claimId,
      snapshot: { source: 'overleaf', projectId: project.project!.overleafProjectId, documentText: fixture.latex, selectedText: null, url: null, capturedAt: new Date().toISOString() }, parsedDocumentFingerprint: doc.fingerprint, parserVersion: PARSER_VERSION }));
    let result;
    while (Date.now() - start < 900000) {
      result = RunResult.parse(await api(`/v1/runs/${accepted.runId}`));
      if (result.status === 'finished' || result.status === 'cancelled') break;
      if (result.status === 'paused') {
        await api(`/v1/runs/${accepted.runId}/informal-audit/acknowledge`, { reason: 'Synthetic evaluation fixture: continue to formal kernel checking.' });
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const outcome = result?.outcome ?? 'timeout';
    reports.push({ id: fixture.id, runId: accepted.runId, outcome, passed: fixture.expected.includes(outcome), falseAcceptance: fixture.id === 'false-zero-one' && outcome === 'verified', durationMs: Date.now() - start, diagnostics: result?.diagnostics });
  } catch (error) { reports.push({ id: fixture.id, passed: false, error: String(error), durationMs: Date.now() - start }); }
}
const path = join(root, 'reports', `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await mkdir(join(root, 'reports'), { recursive: true });
await writeFile(path, JSON.stringify({ model: 'configured desktop provider', live: true, cases: reports }, null, 2));
console.table(reports.map(r => ({ id: r.id, outcome: r.outcome, passed: r.passed, durationMs: r.durationMs })));
console.log(`Report: ${path}`);
if (reports.some(r => !r.passed)) process.exitCode = 1;

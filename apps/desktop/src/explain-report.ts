import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Prints what happened in an eval or research report, case by case and step
// by step: outcome, diagnostics, each step's Lean statement and how it read
// back, why it failed, citations, composition.
//
//   pnpm explain                # the newest report in reports/
//   pnpm explain <report.json>  # a given one
//   pnpm explain -- --case steps-sound

const root = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2).filter((a) => a !== '--');
const caseIndex = args.indexOf('--case');
const onlyCase = caseIndex >= 0 ? args[caseIndex + 1] : undefined;
const explicit = args.find((a, i) => a.endsWith('.json') && args[i - 1] !== '--case');

async function newestReport(): Promise<string> {
  const dir = join(root, 'reports');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) throw new Error(`No reports in ${dir}`);
  return join(dir, files.at(-1)!);
}

const path = explicit ?? await newestReport();
const report = JSON.parse(await readFile(path, 'utf8')) as { cases?: unknown[]; reports?: unknown[] };
const entries = (report.cases ?? report.reports ?? []) as Array<Record<string, unknown>>;
const flat = (v: unknown, n = 400): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

console.log(`Report: ${path}\n`);
for (const entry of entries) {
  const id = String(entry['id'] ?? entry['label']);
  if (onlyCase && id !== onlyCase) continue;
  console.log(`== ${id}: ${entry['outcome']}${entry['passed'] === false ? ' (FAIL)' : ''}`);
  for (const f of (entry['failures'] as string[] | undefined) ?? []) console.log(`   expectation: ${f}`);
  for (const d of (entry['diagnostics'] as string[] | undefined) ?? []) console.log(`   log: ${flat(d, 600)}`);
  if (entry['error']) console.log(`   error: ${flat(entry['error'], 600)}`);
  const argument = entry['argument'] as Record<string, unknown> | null | undefined;
  if (!argument) { console.log(''); continue; }
  for (const s of argument['steps'] as Array<Record<string, unknown>>) {
    console.log(`   step ${s['idx']}: stated=${s['status']} proof=${s['proofStatus']}${s['closedBy'] ? ` by ${s['closedBy']}` : ''}${s['turns'] ? `, ${s['turns']} turns` : ''}`);
    console.log(`      author: ${flat(s['claim'])}`);
    if (s['leanStatement']) console.log(`      lean:   ${flat(s['leanStatement'])}`);
    if (s['backtranslation']) console.log(`      reads:  ${flat(s['backtranslation'])}`);
    for (const d of (s['diagnostics'] as string[] | undefined) ?? []) console.log(`      why:    ${flat(d, 600)}`);
    if (s['report']) console.log(`      prover: ${flat(s['report'], 800)}`);
  }
  for (const c of (argument['citations'] as Array<Record<string, unknown>>) ?? []) {
    console.log(`   cited ${c['name']}: ${c['status']} — ${flat(c['reason'])}`);
  }
  const comp = argument['composition'] as Record<string, unknown> | null;
  if (comp) console.log(`   composition: ${comp['status']}${comp['closedBy'] ? ` by ${comp['closedBy']}` : ''}${comp['report'] ? ` — ${flat(comp['report'], 600)}` : ''}`);
  console.log(`   agent spend: $${Number(argument['agentSpendUsd'] ?? 0).toFixed(2)}\n`);
}

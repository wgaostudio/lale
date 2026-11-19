import type { Database } from 'better-sqlite3';
import {
  ArgumentCitation,
  ArgumentComposition,
  ProverBudgetPreset,
  type ArgumentStep,
  type ProofArgument,
} from '@lale/protocol';

// ---------------------------------------------------------------------------
// The author's argument, as stored by a Check proof steps run
//
// Steps live in `proof_steps` (one row each, details in artifactsJson);
// citations and composition in `proof_arguments`. Both are written by the
// pipeline as JSON, so everything is read back through the protocol's own
// schemas: a row from an older build reports a field as absent rather than
// failing the side panel's parse.
// ---------------------------------------------------------------------------

function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ints = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const STEP_STATUSES = new Set(['pending', 'checked', 'failed', 'blocked']);
const PROOF_STATUSES = new Set(['proved', 'unproved', 'skipped']);

export function readProofArgument(db: Database, runId: string): ProofArgument | null {
  const stepRows = db
    .prepare('SELECT idx, sourceText, status, artifactsJson FROM proof_steps WHERE auditRunId = ? ORDER BY idx')
    .all(runId) as Array<{ idx: number; sourceText: string; status: string; artifactsJson: string }>;
  const argumentRow = db
    .prepare('SELECT citationsJson, compositionJson, agentSpendUsd FROM proof_arguments WHERE auditRunId = ?')
    .get(runId) as { citationsJson: string; compositionJson: string | null; agentSpendUsd: number } | undefined;
  if (stepRows.length === 0 && !argumentRow) return null;

  const steps: ArgumentStep[] = stepRows.map((row) => {
    const artifacts = record(parseJson(row.artifactsJson));
    const proof = record(artifacts['proof']);
    const cites = Array.isArray(artifacts['cites'])
      ? (artifacts['cites'] as unknown[]).map((c) => (typeof c === 'number' ? c : num(record(c)['idx']))).filter((c): c is number => c !== null)
      : [];
    const proofStatus = str(proof['status']);
    return {
      idx: row.idx,
      claim: str(artifacts['claim']) ?? row.sourceText,
      sourceText: row.sourceText,
      status: (STEP_STATUSES.has(row.status) ? row.status : 'blocked') as ArgumentStep['status'],
      proofStatus: (proofStatus && PROOF_STATUSES.has(proofStatus) ? proofStatus : 'skipped') as ArgumentStep['proofStatus'],
      closedBy: str(proof['closedBy']),
      uses: ints(artifacts['uses']),
      cites,
      leanStatement: str(artifacts['leanSource']),
      backtranslation: str(artifacts['backtranslation']),
      diagnostics: [...strings(artifacts['diagnostics']), ...strings(proof['diagnostics'])],
      report: str(proof['report']),
      spentUsd: num(proof['spentUsd']),
      turns: num(proof['turns']),
    };
  });

  const rawCitations = parseJson(argumentRow?.citationsJson);
  const citations = (Array.isArray(rawCitations) ? rawCitations : [])
    .map((c) => ArgumentCitation.safeParse(c).data)
    .filter((c): c is ArgumentCitation => c !== undefined);
  const compositionRecord = record(parseJson(argumentRow?.compositionJson));
  const composition = ArgumentComposition.safeParse(compositionRecord).data ?? null;

  return {
    steps,
    citations,
    composition,
    agentSpendUsd: argumentRow?.agentSpendUsd ?? 0,
    proverModel: str(compositionRecord['proverModel']),
    budget: ProverBudgetPreset.safeParse(compositionRecord['budget']).data ?? null,
  };
}

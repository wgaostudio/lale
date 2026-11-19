import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Mathlib declaration search
//
// Premise selection is the step the one-shot proposer never had: a model that
// half-remembers a lemma name guesses, Lean says "unknown identifier", and the
// attempt is spent. Here the agent can look first.
//
// The index is the head of every declaration in the Mathlib sources shipped in
// the Lean project — a few lines each, enough to show the name and most of the
// signature. It is built once per project directory and kept in memory.
// Queries are literal terms ANDed together, never a regular expression: a
// pattern from a model could backtrack long enough to stall the service.
// ---------------------------------------------------------------------------

const DECLARATION_HEAD = /^\s*(?:@\[[^\]]*\]\s*)?(?:(?:private|protected|noncomputable|nonrec)\s+)*(theorem|lemma|def|abbrev|instance|structure|class|inductive)\b/;
const HEAD_LINES = 4;
const HEAD_CHARS = 400;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_TERMS = 6;

export interface DeclarationEntry {
  file: string;
  line: number;
  kind: string;
  text: string;
}

export interface SearchHit extends DeclarationEntry {
  score: number;
}

const indexCache = new Map<string, Promise<DeclarationEntry[]>>();

export function mathlibSourceRoot(leanProjectDir: string): string {
  return join(leanProjectDir, '.lake', 'packages', 'mathlib');
}

export function clearMathlibSearchCache(): void {
  indexCache.clear();
}

/** Every declaration head under `root/Mathlib`, cached per root. */
export function loadDeclarationIndex(root: string): Promise<DeclarationEntry[]> {
  let pending = indexCache.get(root);
  if (!pending) {
    pending = buildIndex(root).catch((error) => {
      indexCache.delete(root);
      throw error;
    });
    indexCache.set(root, pending);
  }
  return pending;
}

async function buildIndex(root: string): Promise<DeclarationEntry[]> {
  const entries: DeclarationEntry[] = [];
  for await (const file of leanFiles(join(root, 'Mathlib'))) {
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    const display = relative(root, file).split(sep).join('/');
    for (let i = 0; i < lines.length; i++) {
      const match = DECLARATION_HEAD.exec(lines[i]!);
      if (!match) continue;
      const head: string[] = [];
      for (let j = i; j < Math.min(lines.length, i + HEAD_LINES); j++) {
        const line = lines[j]!;
        if (j > i && (line.trim() === '' || DECLARATION_HEAD.test(line))) break;
        head.push(line.trim());
        if (/:=|\bwhere\b/.test(line)) break;
      }
      entries.push({ file: display, line: i + 1, kind: match[1]!, text: head.join(' ').slice(0, HEAD_CHARS) });
    }
  }
  return entries;
}

async function* leanFiles(dir: string): AsyncGenerator<string> {
  const dirents = await readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    const path = join(dir, dirent.name);
    if (dirent.isDirectory()) yield* leanFiles(path);
    else if (dirent.isFile() && dirent.name.endsWith('.lean')) yield path;
  }
}

/**
 * Entries containing every term, case-insensitively. Ranked so that a term in
 * the declaration's own name beats one in its signature, and shorter heads
 * (more specific lemmas) beat longer ones.
 */
export function searchDeclarations(index: DeclarationEntry[], terms: string[], limit = DEFAULT_LIMIT): SearchHit[] {
  const needles = terms.map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, MAX_TERMS);
  if (needles.length === 0) return [];
  const cap = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
  const hits: SearchHit[] = [];
  for (const entry of index) {
    const haystack = entry.text.toLowerCase();
    if (!needles.every((n) => haystack.includes(n))) continue;
    const name = declarationName(entry.text).toLowerCase();
    let score = 0;
    for (const n of needles) if (name.includes(n)) score += 10;
    score -= entry.text.length / 100;
    hits.push({ ...entry, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, cap);
}

function declarationName(head: string): string {
  const match = /\b(?:theorem|lemma|def|abbrev|instance|structure|class|inductive)\s+([^\s:({[]+)/.exec(head);
  return match?.[1] ?? '';
}

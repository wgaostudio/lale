import { stripLeanCommentsAndStrings } from './index.js';

export interface FrozenObligation { name: string; preamble: string; proposition: string; header: string; proofBody: string }
/** A deliberately small input language. Unsupported Lean fails closed. */
export function parseObligation(source: string, expectedName?: string): FrozenObligation {
  const code = stripLeanCommentsAndStrings(source);
  const declarations = [...code.matchAll(/\b(?:theorem|lemma)\s+([A-Za-z][A-Za-z0-9_']*)\s*:/g)];
  if (declarations.length !== 1) throw new Error('Expected one theorem with ALL binders inside its closed proposition');
  const declaration = declarations[0]!;
  const name = declaration[1]!;
  if (expectedName && name !== expectedName) throw new Error('Theorem name does not match metadata');
  const preamble = source.slice(0, declaration.index);
  for (const line of code.slice(0, declaration.index).split('\n').map(x => x.trim()).filter(Boolean)) {
    if (!/^(?:import|open(?: scoped)?)\s+[A-Za-z0-9_.' ]+$/.test(line)) throw new Error('Theorem preamble may contain only imports and open commands');
  }
  const start = declaration.index! + declaration[0].length;
  let depth = 0, assignment = -1;
  for (let i = start; i < code.length - 1; i++) {
    if ('({['.includes(code[i]!)) depth++;
    if (')}]'.includes(code[i]!)) depth--;
    if (depth < 0) throw new Error('Unbalanced theorem statement');
    if (depth === 0 && code.slice(i, i + 2) === ':=') { assignment = i; break; }
  }
  if (assignment < 0 || !/^:=\s*by\b/.test(code.slice(assignment))) throw new Error('Expected := by');
  const proofStart = assignment + /^:=\s*by\b/.exec(code.slice(assignment))![0].length;
  const proposition = source.slice(start, assignment).trim();
  if (!proposition) throw new Error('Empty proposition');
  return { name, preamble, proposition, header: source.slice(0, proofStart), proofBody: source.slice(proofStart).trim() };
}
export function fillObligation(source: string, body: string, expectedName?: string): string {
  const obligation = parseObligation(source, expectedName);
  if (!body.trim()) throw new Error('Empty proof body');
  return `${obligation.header}\n${body.trim().split('\n').map(line => `  ${line}`).join('\n')}\n`;
}
export function sameObligation(frozen: string, accepted: string, name: string): boolean {
  try { return parseObligation(frozen, name).header === parseObligation(accepted, name).header; }
  catch { return false; }
}
/**
 * For an accepted proof that carries more than the theorem — helper lemmas,
 * the author's proved steps — `sameObligation` cannot apply: it parses a file
 * of exactly one theorem. This is its multi-declaration counterpart. The
 * frozen header, minus its imports (which a composed file hoists), must occur
 * verbatim, and nothing else may declare that name. The kernel certificate on
 * recheck is what pins the proposition; this pins the text.
 */
export function containsObligation(frozen: string, accepted: string, name: string): boolean {
  try {
    const header = parseObligation(frozen, name).header
      .split('\n').filter((line) => !/^\s*import\s/.test(line)).join('\n').trim();
    if (!header || !accepted.includes(header)) return false;
    const code = stripLeanCommentsAndStrings(accepted);
    const escaped = name.replace(/[.*+?^${}()|[\]\\']/g, '\\$&');
    const declarations = code.match(new RegExp(`\\b(?:theorem|lemma|def|abbrev|instance|axiom|opaque)\\s+${escaped}(?![A-Za-z0-9_'.])`, 'g'));
    return declarations?.length === 1;
  } catch {
    return false;
  }
}
export function equivalenceObligation(s1: string, s2: string): string {
  const a = parseObligation(s1), b = parseObligation(s2);
  const imports = new Set<string>();
  const opens = (prefix: string): string => prefix.split('\n').filter(line => {
    if (/^\s*import\s/.test(line)) { imports.add(line.trim()); return false; }
    return true;
  }).join('\n');
  const openA = opens(a.preamble), openB = opens(b.preamble);
  return `${[...imports].join('\n')}
section
${openA}
def laleRoundtripLeft : Prop := (${a.proposition})
end
section
${openB}
def laleRoundtripRight : Prop := (${b.proposition})
end
theorem laleRoundtrip : laleRoundtripLeft ↔ laleRoundtripRight := by sorry`;
}
/** This preamble is harness-generated, not model supplied. */
export function fillEquivalence(obligation: string, body: string): string {
  const marker = '\ntheorem laleRoundtrip : laleRoundtripLeft ↔ laleRoundtripRight := by';
  const offset = obligation.lastIndexOf(marker);
  if (offset < 0) throw new Error('Missing fixed equivalence obligation');
  return obligation.slice(0, offset) + '\n' + fillObligation(obligation.slice(offset + 1), body, 'laleRoundtrip');
}

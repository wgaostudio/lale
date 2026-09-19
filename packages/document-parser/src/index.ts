// 0.4.0 widened the fingerprint hash, so every value this module produces has
// changed; claims accepted under 0.3.0 do not match and have to be rerun.
export const PARSER_VERSION = '0.4.0';

export type TheoremKind =
  | 'theorem'
  | 'proposition'
  | 'claim'
  | 'lemma'
  | 'corollary'
  | 'definition'
  | 'postulate'
  | 'axiom';

export type DocumentIssueSeverity = 'info' | 'warning' | 'error';

export interface DocumentIssue {
  id: string;
  severity: DocumentIssueSeverity;
  message: string;
  line: number | null;
  claimId: string | null;
}

export interface ParsedProof {
  text: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
}

export interface ParsedClaim {
  id: string;
  kind: TheoremKind;
  label: string | null;
  title: string | null;
  statement: string;
  body: string;
  /**
   * Standing hypotheses the claim inherits from the prose around it: the
   * document's opening matter plus the lead paragraphs of every sectioning
   * unit enclosing the claim. Papers state things like "let G be a finite
   * simple graph" once, in running text, and every later environment relies on
   * it; without this the claim body alone is a weaker statement than the author
   * wrote.
   */
  ambientContext: string;
  proof: ParsedProof | null;
  dependencies: string[];
  dependents: string[];
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  fingerprint: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
  label: string;
}

export interface ParsedDocument {
  fingerprint: string;
  claims: ParsedClaim[];
  issues: DocumentIssue[];
  edges: DependencyEdge[];
  packages: {
    amsthm: boolean;
    amsmath: boolean;
    amssymb: boolean;
    hyperref: boolean;
  };
  theoremDefinitions: string[];
}

const CLAIM_KINDS: TheoremKind[] = [
  'theorem',
  'proposition',
  'claim',
  'lemma',
  'corollary',
  'definition',
  'postulate',
  'axiom',
];

export const PROOF_OPTIONAL_THEOREM_KINDS = [
  'definition',
  'postulate',
  'axiom',
] as const satisfies readonly TheoremKind[];

const PROOF_OPTIONAL_KINDS = new Set<TheoremKind>(PROOF_OPTIONAL_THEOREM_KINDS);
const BEGIN_RE = /\\begin\{([A-Za-z]+\*?)\}(\[[^\]]*\])?/g;
const REF_RE = /\\(?:ref|cref|Cref|autoref|eqref)\{([^}]+)\}/g;

export function isProofOptionalKind(kind: TheoremKind): boolean {
  return PROOF_OPTIONAL_KINDS.has(kind);
}

export function isVerifiableClaimKind(kind: TheoremKind): boolean {
  return !isProofOptionalKind(kind);
}

export function parseLatexDocument(source: string): ParsedDocument {
  const scanSource = maskLatexComments(source);
  const packages = detectPackages(scanSource);
  const theoremDefinitions = detectTheoremDefinitions(scanSource);
  const claims = parseClaims(source);
  attachAmbientContext(source, claims);
  // Fingerprint the complete mathematical context after attaching inherited
  // hypotheses. Both dependency reuse and extension staleness rely on this.
  for (const claim of claims) {
    claim.fingerprint = stableHash(JSON.stringify({
      kind: claim.kind,
      label: claim.label,
      statement: claim.statement,
      ambientContext: claim.ambientContext,
      proof: claim.proof?.text ?? null,
      dependencies: claim.dependencies,
    }));
  }
  const issues: DocumentIssue[] = [];

  addPackageIssues(packages, issues);
  addTheoremDefinitionIssues(theoremDefinitions, issues);
  addClaimIssues(claims, issues);

  const labels = new Map<string, ParsedClaim>();
  const claimsByLabel = new Map<string, ParsedClaim[]>();

  for (const claim of claims) {
    if (!claim.label) continue;
    const matchingClaims = claimsByLabel.get(claim.label) ?? [];
    matchingClaims.push(claim);
    claimsByLabel.set(claim.label, matchingClaims);
    if (!labels.has(claim.label)) {
      labels.set(claim.label, claim);
    }
  }

  for (const [label, matchingClaims] of claimsByLabel) {
    if (matchingClaims.length < 2) continue;
    labels.delete(label);
    for (const claim of matchingClaims) {
      issues.push({
        id: `duplicate-label:${label}:${claim.startLine}`,
        severity: 'error',
        message: `Duplicate label "${label}". Labels must identify one claim.`,
        line: claim.startLine,
        claimId: claim.id,
      });
    }
  }

  const edges: DependencyEdge[] = [];
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));

  for (const claim of claims) {
    for (const dependency of claim.dependencies) {
      const matchingClaims = claimsByLabel.get(dependency) ?? [];
      if (matchingClaims.length > 1) {
        issues.push({
          id: `ambiguous-ref:${claim.id}:${dependency}`,
          severity: 'error',
          message: `Reference "${dependency}" is ambiguous because multiple claims use that label.`,
          line: claim.startLine,
          claimId: claim.id,
        });
        continue;
      }

      const target = labels.get(dependency);
      if (!target) {
        issues.push({
          id: `unresolved-ref:${claim.id}:${dependency}`,
          severity: 'warning',
          message: `Reference "${dependency}" does not resolve to a labeled claim in this document.`,
          line: claim.startLine,
          claimId: claim.id,
        });
        continue;
      }

      if (target.id === claim.id) continue;
      edges.push({ from: claim.id, to: target.id, label: dependency });
    }
  }

  for (const edge of edges) {
    const target = claimById.get(edge.to);
    if (target && !target.dependents.includes(edge.from)) target.dependents.push(edge.from);
  }

  addCycleIssues(claims, edges, issues);

  return {
    fingerprint: stableHash(source),
    claims,
    issues,
    edges,
    packages,
    theoremDefinitions,
  };
}

function parseClaims(source: string): ParsedClaim[] {
  const claims: ParsedClaim[] = [];
  const lineStarts = computeLineStarts(source);
  const scanSource = maskLatexComments(source);
  BEGIN_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = BEGIN_RE.exec(scanSource))) {
    const rawEnvName = match[1];
    const envName = rawEnvName?.replace(/\*$/, '') as TheoremKind | undefined;
    if (!rawEnvName || !envName || !isClaimKind(envName)) continue;

    const beginStart = match.index;
    const bodyStart = BEGIN_RE.lastIndex;
    const end = findEnvironmentEnd(scanSource, rawEnvName, bodyStart);
    if (!end) continue;

    const rawBody = source.slice(bodyStart, end.start);
    const title = match[2] ? match[2].slice(1, -1).trim() : null;
    const label = extractLabel(rawBody);
    const proof = findAdjacentProof(source, scanSource, end.end, lineStarts);
    const dependencyText = `${rawBody}\n${proof?.text ?? ''}`;
    const dependencies = unique(extractRefs(dependencyText).filter((ref) => ref !== label));
    const bodyEnd = proof?.endOffset ?? end.end;
    const statement = cleanLatexStatement(rawBody);
    const id = uniqueClaimId(label ?? `${envName}:${claims.length + 1}`, claims);

    claims.push({
      id,
      kind: envName,
      label,
      title,
      statement,
      body: rawBody.trim(),
      ambientContext: '',
      proof,
      dependencies,
      dependents: [],
      startLine: lineForOffset(lineStarts, beginStart),
      endLine: lineForOffset(lineStarts, bodyEnd),
      startOffset: beginStart,
      endOffset: bodyEnd,
      fingerprint: '', // Assigned once ambient context has been attached.
    });

    BEGIN_RE.lastIndex = end.end;
  }

  return claims;
}

// ---------------------------------------------------------------------------
// Ambient context (standing hypotheses carried by the surrounding prose)
// ---------------------------------------------------------------------------

interface SectionHeading {
  level: number;
  /** Offset of the `\\section`-style command itself. */
  commandStart: number;
  /** Offset just past the heading command. */
  contentStart: number;
}

const SECTION_LEVELS: Record<string, number> = {
  part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4,
};
const SECTION_RE = /\\(part|chapter|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\{/g;

// Per sectioning unit, and for the whole assembled context. A section lead is
// normally a paragraph or two; these bounds only stop a pathological document
// from crowding out the claim itself.
const MAX_AMBIENT_PART_CHARS = 2000;
const MAX_AMBIENT_CHARS = 8000;

function attachAmbientContext(source: string, claims: ParsedClaim[]): void {
  if (claims.length === 0) return;

  const scanSource = maskLatexComments(source);
  const headings = parseSectionHeadings(scanSource);
  // Claim and proof spans are supplied to the model separately, as the target
  // or as resolved dependencies; repeating them here would just cost tokens.
  const claimSpans = claims.map((claim) => [claim.startOffset, claim.endOffset] as const);
  const documentStart = documentBodyStart(scanSource);

  for (const claim of claims) {
    const parts: string[] = [];

    // Opening matter: global conventions stated before any sectioning command.
    const firstHeading = headings.find((heading) => heading.commandStart >= documentStart);
    const preambleEnd = Math.min(firstHeading?.commandStart ?? source.length, claim.startOffset);
    addAmbientPart(parts, source, documentStart, preambleEnd, claimSpans);

    // Lead prose of every sectioning unit enclosing the claim, outermost first.
    // Outermost matters most: "let G be a finite simple graph" is typically
    // stated once under \section, while the claim sits under a \subsection.
    // Each part opens with its own heading, so the model sees which unit the
    // hypotheses belong to.
    for (const heading of enclosingHeadings(headings, claim.startOffset)) {
      const next = headings.find((other) => other.commandStart > heading.commandStart);
      const end = Math.min(next?.commandStart ?? source.length, claim.startOffset);
      addAmbientPart(parts, source, heading.commandStart, end, claimSpans);
    }

    claim.ambientContext = parts.join('\n\n').slice(0, MAX_AMBIENT_CHARS).trim();
  }
}

function parseSectionHeadings(scanSource: string): SectionHeading[] {
  const headings: SectionHeading[] = [];
  SECTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SECTION_RE.exec(scanSource))) {
    const level = SECTION_LEVELS[match[1] ?? ''];
    if (level === undefined) continue;
    const braced = readBracedGroup(scanSource, SECTION_RE.lastIndex - 1);
    if (!braced) continue;
    headings.push({ level, commandStart: match.index, contentStart: braced.end });
    SECTION_RE.lastIndex = braced.end;
  }
  return headings;
}

/** The chain of sectioning units containing `offset`, outermost first. */
function enclosingHeadings(headings: SectionHeading[], offset: number): SectionHeading[] {
  const stack: SectionHeading[] = [];
  for (const heading of headings) {
    if (heading.contentStart > offset) break;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) stack.pop();
    stack.push(heading);
  }
  return stack;
}

function addAmbientPart(
  parts: string[],
  source: string,
  start: number,
  end: number,
  claimSpans: ReadonlyArray<readonly [number, number]>,
): void {
  if (end <= start) return;
  const text = cleanAmbientProse(removeSpans(source.slice(start, end), start, claimSpans));
  if (text) parts.push(text.slice(0, MAX_AMBIENT_PART_CHARS));
}

/** Drops claim and proof environments that fall inside `[offset, offset + text.length)`. */
function removeSpans(
  text: string,
  offset: number,
  spans: ReadonlyArray<readonly [number, number]>,
): string {
  let result = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    const localStart = start - offset;
    const localEnd = end - offset;
    if (localEnd <= 0 || localStart >= text.length) continue;
    result += text.slice(cursor, Math.max(cursor, localStart));
    cursor = Math.max(cursor, localEnd);
  }
  return result + text.slice(cursor);
}

function cleanAmbientProse(source: string): string {
  return maskLatexComments(source)
    .replace(/\\label\{[^}]+\}/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function documentBodyStart(scanSource: string): number {
  const match = /\\begin\{document\}/.exec(scanSource);
  return match ? match.index + match[0].length : 0;
}

function readBracedGroup(source: string, openIndex: number): { text: string; end: number } | null {
  if (source[openIndex] !== '{') return null;
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { text: source.slice(openIndex + 1, i), end: i + 1 };
    }
  }
  return null;
}

function detectPackages(source: string): ParsedDocument['packages'] {
  return {
    amsthm: hasUsePackage(source, 'amsthm'),
    amsmath: hasUsePackage(source, 'amsmath'),
    amssymb: hasUsePackage(source, 'amssymb'),
    hyperref: hasUsePackage(source, 'hyperref'),
  };
}

function hasUsePackage(source: string, packageName: string): boolean {
  const re = new RegExp(`\\\\usepackage(?:\\[[^\\]]*\\])?\\{[^}]*\\b${packageName}\\b[^}]*\\}`);
  return re.test(source);
}

function detectTheoremDefinitions(source: string): string[] {
  const definitions = new Set<string>();
  const re = /\\newtheorem\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    if (match[1]) definitions.add(match[1]);
  }
  return [...definitions].sort();
}

function addPackageIssues(
  packages: ParsedDocument['packages'],
  issues: DocumentIssue[],
): void {
  for (const [name, present] of Object.entries(packages)) {
    if (!present) {
      issues.push({
        id: `missing-package:${name}`,
        severity: name === 'hyperref' ? 'info' : 'warning',
        message: `Recommended package missing: \\usepackage{${name}}.`,
        line: null,
        claimId: null,
      });
    }
  }
}

function addTheoremDefinitionIssues(definitions: string[], issues: DocumentIssue[]): void {
  for (const kind of CLAIM_KINDS) {
    if (!definitions.includes(kind)) {
      issues.push({
        id: `missing-newtheorem:${kind}`,
        severity: 'info',
        message: `Recommended theorem environment not declared: \\newtheorem{${kind}}{...}.`,
        line: null,
        claimId: null,
      });
    }
  }
}

function addClaimIssues(claims: ParsedClaim[], issues: DocumentIssue[]): void {
  for (const claim of claims) {
    if (!claim.label) {
      issues.push({
        id: `missing-label:${claim.id}`,
        severity: 'warning',
        message: `${capitalize(claim.kind)} at line ${claim.startLine} is missing a \\label{...}.`,
        line: claim.startLine,
        claimId: claim.id,
      });
    }

    if (!claim.proof && isVerifiableClaimKind(claim.kind)) {
      issues.push({
        id: `missing-proof:${claim.id}`,
        severity: 'warning',
        message: `${claim.label ?? capitalize(claim.kind)} has no immediately adjacent proof block.`,
        line: claim.startLine,
        claimId: claim.id,
      });
    }
  }
}

function addCycleIssues(
  claims: ParsedClaim[],
  edges: DependencyEdge[],
  issues: DocumentIssue[],
): void {
  const adjacency = new Map<string, string[]>();
  for (const claim of claims) adjacency.set(claim.id, []);
  for (const edge of edges) adjacency.get(edge.from)?.push(edge.to);

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string, path: string[]): void {
    if (visiting.has(id)) {
      issues.push({
        id: `dependency-cycle:${id}`,
        severity: 'error',
        message: `Dependency cycle detected: ${[...path, id].join(' -> ')}.`,
        line: claims.find((claim) => claim.id === id)?.startLine ?? null,
        claimId: id,
      });
      return;
    }
    if (visited.has(id)) return;

    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) visit(next, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  }

  for (const claim of claims) visit(claim.id, []);
}

function findEnvironmentEnd(
  source: string,
  envName: string,
  from: number,
): { start: number; end: number } | null {
  const escapedEnvName = escapeRegExp(envName);
  const boundaryRe = new RegExp(`\\\\(?:begin|end)\\{${escapedEnvName}\\}`, 'g');
  boundaryRe.lastIndex = from;

  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = boundaryRe.exec(source))) {
    const token = match[0] ?? '';
    if (token.startsWith('\\begin')) depth += 1;
    else depth -= 1;

    if (depth === 0) {
      return { start: match.index, end: boundaryRe.lastIndex };
    }
  }

  return null;
}

function findAdjacentProof(
  source: string,
  scanSource: string,
  from: number,
  lineStarts: number[],
): ParsedProof | null {
  const next = scanSource.slice(from);
  const skipped = next.match(/^(?:\s|%[^\n]*(?:\n|$))*/)?.[0].length ?? 0;
  const beginOffset = from + skipped;
  const beginMatch = scanSource.slice(beginOffset).match(/^\\begin\{proof\}(\[[^\]]*\])?/);
  if (!beginMatch) return null;

  const bodyStart = beginOffset + beginMatch[0].length;
  const end = findEnvironmentEnd(scanSource, 'proof', bodyStart);
  if (!end) return null;

  return {
    text: source.slice(bodyStart, end.start).trim(),
    startLine: lineForOffset(lineStarts, beginOffset),
    endLine: lineForOffset(lineStarts, end.end),
    startOffset: beginOffset,
    endOffset: end.end,
  };
}

function extractLabel(source: string): string | null {
  return maskLatexComments(source).match(/\\label\{([^}]+)\}/)?.[1] ?? null;
}

function extractRefs(source: string): string[] {
  const refs: string[] = [];
  const scanSource = maskLatexComments(source);
  REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REF_RE.exec(scanSource))) {
    const labels = match[1]?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
    refs.push(...labels);
  }
  return refs;
}

function cleanLatexStatement(source: string): string {
  return maskLatexComments(source)
    .replace(/\\label\{[^}]+\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function maskLatexComments(source: string): string {
  let result = '';
  let escapedBackslashes = 0;
  let inComment = false;

  for (const ch of source) {
    if (inComment) {
      if (ch === '\n') {
        inComment = false;
        escapedBackslashes = 0;
        result += '\n';
      } else {
        result += ' ';
      }
      continue;
    }

    if (ch === '%' && escapedBackslashes % 2 === 0) {
      inComment = true;
      result += ' ';
      escapedBackslashes = 0;
      continue;
    }

    result += ch;
    escapedBackslashes = ch === '\\' ? escapedBackslashes + 1 : 0;
  }

  return result;
}

function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineForOffset(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = lineStarts[mid] ?? 0;
    const next = lineStarts[mid + 1] ?? Number.POSITIVE_INFINITY;
    if (offset >= start && offset < next) return mid + 1;
    if (offset < start) high = mid - 1;
    else low = mid + 1;
  }
  return lineStarts.length;
}

// FNV-1a, 128-bit, over UTF-16 code units. Everything else in the system
// fingerprints with SHA-256, but this module runs in a content script as well as
// on the desktop, where `node:crypto` does not exist and Web Crypto is async —
// and `parseLatexDocument` is synchronous by contract. So: not SHA-256, but wide
// enough to be a fingerprint. The 32-bit version this replaces gave 8 hex digits
// for a value that decides whether a cached proof may be reused and whether a
// dependent claim goes stale; birthday collisions arrive at ~2^16 distinct
// claims, which is not a comfortable margin for either decision.
const FNV_OFFSET_BASIS_128 = 0x6c62272e07bb014262b821756295c58dn;
const FNV_PRIME_128 = 0x0000000001000000000000000000013bn;
const UINT128_MASK = (1n << 128n) - 1n;

function stableHash(input: string): string {
  let hash = FNV_OFFSET_BASIS_128;
  for (let index = 0; index < input.length; index++) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * FNV_PRIME_128) & UINT128_MASK;
  }
  return hash.toString(16).padStart(32, '0');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isClaimKind(value: string): value is TheoremKind {
  return CLAIM_KINDS.includes(value as TheoremKind);
}

function uniqueClaimId(baseId: string, existingClaims: ParsedClaim[]): string {
  if (!existingClaims.some((claim) => claim.id === baseId)) return baseId;

  let suffix = 2;
  let candidate = `${baseId}#${suffix}`;
  while (existingClaims.some((claim) => claim.id === candidate)) {
    suffix += 1;
    candidate = `${baseId}#${suffix}`;
  }
  return candidate;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

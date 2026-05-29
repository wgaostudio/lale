export const PARSER_VERSION = '0.1.0';

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
const BEGIN_RE = /\\begin\{([A-Za-z*]+)\}(\[[^\]]*\])?/g;
const REF_RE = /\\(?:ref|cref|Cref|autoref|eqref)\{([^}]+)\}/g;

export function isProofOptionalKind(kind: TheoremKind): boolean {
  return PROOF_OPTIONAL_KINDS.has(kind);
}

export function isVerifiableClaimKind(kind: TheoremKind): boolean {
  return !isProofOptionalKind(kind);
}

export function parseLatexDocument(source: string): ParsedDocument {
  const packages = detectPackages(source);
  const theoremDefinitions = detectTheoremDefinitions(source);
  const claims = parseClaims(source);
  const issues: DocumentIssue[] = [];

  addPackageIssues(packages, issues);
  addTheoremDefinitionIssues(theoremDefinitions, issues);
  addClaimIssues(claims, issues);

  const labels = new Map<string, ParsedClaim>();
  const duplicateLabels = new Set<string>();

  for (const claim of claims) {
    if (!claim.label) continue;
    if (labels.has(claim.label)) {
      duplicateLabels.add(claim.label);
    } else {
      labels.set(claim.label, claim);
    }
  }

  for (const label of duplicateLabels) {
    const claim = labels.get(label);
    issues.push({
      id: `duplicate-label:${label}`,
      severity: 'error',
      message: `Duplicate label "${label}". Labels must identify one claim.`,
      line: claim?.startLine ?? null,
      claimId: claim?.id ?? null,
    });
  }

  const edges: DependencyEdge[] = [];
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));

  for (const claim of claims) {
    for (const dependency of claim.dependencies) {
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
  BEGIN_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = BEGIN_RE.exec(source))) {
    const envName = match[1]?.replace(/\*$/, '') as TheoremKind | undefined;
    if (!envName || !isClaimKind(envName)) continue;

    const beginStart = match.index;
    const bodyStart = BEGIN_RE.lastIndex;
    const end = findEnvironmentEnd(source, envName, bodyStart);
    if (!end) continue;

    const rawBody = source.slice(bodyStart, end.start);
    const title = match[2] ? match[2].slice(1, -1).trim() : null;
    const label = extractLabel(rawBody);
    const proof = findAdjacentProof(source, end.end);
    const dependencyText = `${rawBody}\n${proof?.text ?? ''}`;
    const dependencies = unique(extractRefs(dependencyText).filter((ref) => ref !== label));
    const bodyEnd = proof?.endOffset ?? end.end;
    const statement = cleanLatexStatement(rawBody);
    const id = label ?? `${envName}:${claims.length + 1}`;

    claims.push({
      id,
      kind: envName,
      label,
      title,
      statement,
      body: rawBody.trim(),
      proof,
      dependencies,
      dependents: [],
      startLine: lineForOffset(lineStarts, beginStart),
      endLine: lineForOffset(lineStarts, bodyEnd),
      startOffset: beginStart,
      endOffset: bodyEnd,
      fingerprint: stableHash(
        JSON.stringify({
          kind: envName,
          label,
          statement,
          proof: proof?.text ?? null,
          dependencies,
        }),
      ),
    });

    BEGIN_RE.lastIndex = end.end;
  }

  return claims;
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
  const endPattern = `\\end{${envName}}`;
  const start = source.indexOf(endPattern, from);
  if (start === -1) return null;
  return { start, end: start + endPattern.length };
}

function findAdjacentProof(source: string, from: number): ParsedProof | null {
  const lineStarts = computeLineStarts(source);
  const next = source.slice(from);
  const skipped = next.match(/^(?:\s|%[^\n]*(?:\n|$))*/)?.[0].length ?? 0;
  const beginOffset = from + skipped;
  const beginMatch = source.slice(beginOffset).match(/^\\begin\{proof\}(\[[^\]]*\])?/);
  if (!beginMatch) return null;

  const bodyStart = beginOffset + beginMatch[0].length;
  const end = findEnvironmentEnd(source, 'proof', bodyStart);
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
  return source.match(/\\label\{([^}]+)\}/)?.[1] ?? null;
}

function extractRefs(source: string): string[] {
  const refs: string[] = [];
  REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REF_RE.exec(source))) {
    const labels = match[1]?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
    refs.push(...labels);
  }
  return refs;
}

function cleanLatexStatement(source: string): string {
  return source
    .replace(/\\label\{[^}]+\}/g, '')
    .replace(/%[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isClaimKind(value: string): value is TheoremKind {
  return CLAIM_KINDS.includes(value as TheoremKind);
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

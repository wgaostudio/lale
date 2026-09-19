import type { ParsedDocument } from '@lale/document-parser';

// ---------------------------------------------------------------------------
// Audit graph node types (§3.3)
// ---------------------------------------------------------------------------

export type AuditNodeKind =
  | 'claim'
  | 'proof'
  | 'definition'
  | 'axiom'
  | 'postulate'
  | 'externalRef';

export interface AuditNode {
  id: string;
  kind: AuditNodeKind;
  label: string | null;
  statementText: string;
  proofText: string | null;
  startLine: number;
  endLine: number;
}

/**
 * Nodes only. Dependency traversal reads `ParsedClaim.dependencies` directly —
 * the parser has already resolved labels to claims and reported the ambiguous
 * and unresolved ones as issues, so a second edge list here was built on every
 * run and never read.
 */
export interface AuditGraph {
  nodes: Map<string, AuditNode>;
}

// ---------------------------------------------------------------------------
// Normalized claim context (§3.6)
// ---------------------------------------------------------------------------

export interface ResolvedDependency {
  fingerprint: string;
  label: string;
  kind: AuditNodeKind;
  statementText: string;
  leanDeclaration: string | null;
  verified: boolean;
}

export interface NormalizedClaimContext {
  targetClaimId: string;
  targetLabel: string | null;
  targetKind: string;
  statementText: string;
  /** Standing hypotheses from the prose around the claim (see ParsedClaim). */
  ambientContext: string;
  proofText: string | null;
  resolvedDependencies: ResolvedDependency[];
  unresolvedDependencyLabels: string[];
  parserIssues: string[];
}

// ---------------------------------------------------------------------------
// Build audit graph from ParsedDocument (§3.3)
// ---------------------------------------------------------------------------

export function buildAuditGraph(doc: ParsedDocument): AuditGraph {
  const nodes = new Map<string, AuditNode>();

  for (const claim of doc.claims) {
    const kind: AuditNodeKind =
      claim.kind === 'definition'
        ? 'definition'
        : claim.kind === 'axiom'
          ? 'axiom'
          : claim.kind === 'postulate'
            ? 'postulate'
            : 'claim';

    nodes.set(claim.id, {
      id: claim.id,
      kind,
      label: claim.label,
      statementText: claim.statement,
      proofText: claim.proof?.text ?? null,
      startLine: claim.startLine,
      endLine: claim.endLine,
    });
  }

  return { nodes };
}

// ---------------------------------------------------------------------------
// Select reachable context (§3.4)
// ---------------------------------------------------------------------------

export function selectReachableContext(
  graph: AuditGraph,
  targetId: string,
  doc: ParsedDocument,
): NormalizedClaimContext {
  const targetNode = graph.nodes.get(targetId);
  const targetClaim = doc.claims.find((c) => c.id === targetId);

  if (!targetNode || !targetClaim) {
    throw new Error(`Target claim not found: ${targetId}`);
  }

  // DFS produces a true dependency-first order; reversing BFS is not a
  // topological sort for diamonds and cross edges.
  const reachableLabels: string[] = [];
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(label: string): void {
    if (visiting.has(label) || label === targetClaim!.label) throw new Error(`Dependency cycle at ${label}`);
    if (visited.has(label)) return;
    visiting.add(label);
    const matches = doc.claims.filter(c => c.label === label);
    if (matches.length > 1) throw new Error(`Ambiguous dependency: ${label}`);
    for (const child of matches[0]?.dependencies ?? []) visit(child);
    visiting.delete(label);
    visited.add(label);
    reachableLabels.push(label);
  }
  for (const label of targetClaim.dependencies) visit(label);

  const resolvedDependencies: ResolvedDependency[] = [];
  const unresolvedDependencyLabels: string[] = [];

  for (const label of reachableLabels) {
    const depNode = findNodeByLabel(graph, label);
    if (depNode) {
      resolvedDependencies.push({
        fingerprint: doc.claims.find(c => c.label === label)!.fingerprint,
        label,
        kind: depNode.kind,
        statementText: depNode.statementText,
        leanDeclaration: null,
        verified: false,
      });
    } else {
      unresolvedDependencyLabels.push(label);
    }
  }

  const parserIssues = doc.issues
    .filter((issue) => issue.claimId === targetId || issue.claimId === null)
    .map((issue) => issue.message);

  return {
    targetClaimId: targetId,
    targetLabel: targetClaim.label,
    targetKind: targetClaim.kind,
    statementText: targetClaim.statement,
    ambientContext: targetClaim.ambientContext,
    proofText: targetClaim.proof?.text ?? null,
    resolvedDependencies,
    unresolvedDependencyLabels,
    parserIssues,
  };
}

function findNodeByLabel(graph: AuditGraph, label: string): AuditNode | undefined {
  for (const node of graph.nodes.values()) {
    if (node.label === label) return node;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Format dependency declarations for model prompts
// ---------------------------------------------------------------------------

export function formatDependencyDeclarations(deps: ResolvedDependency[]): string {
  if (deps.length === 0) return '';
  return deps
    .map((d) =>
      d.leanDeclaration
        ? d.leanDeclaration
        : `-- ${d.label}: ${d.statementText.replace(/\r?\n/g, '\n-- ')}`,
    )
    .join('\n');
}

// ---------------------------------------------------------------------------
// Claim fingerprinting helpers (used to build the cache key)
// ---------------------------------------------------------------------------

export function buildEnvironmentFingerprint(
  context: NormalizedClaimContext,
  leanVersion: string,
  mathlibRevision: string,
): string {
  // Stable representation of the claim's mathematical environment.
  return JSON.stringify({
    leanVersion,
    mathlibRevision,
    // Ambient hypotheses are part of what the claim means, so editing them must
    // invalidate cached results for the claims that inherit them.
    ambientContext: context.ambientContext,
    deps: context.resolvedDependencies.map((d) => ({
      label: d.label,
      statementText: d.statementText,
      fingerprint: d.fingerprint,
      leanDeclaration: d.leanDeclaration,
    })),
    unresolvedDeps: context.unresolvedDependencyLabels,
  });
}

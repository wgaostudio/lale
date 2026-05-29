import type { ParsedClaim, ParsedDocument } from '@lale/document-parser';

// ---------------------------------------------------------------------------
// Audit graph node/edge types (§3.3)
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

export type EdgeKind = 'explicitRef' | 'proofAttachment' | 'context' | 'external';
export type TrustStatus = 'unverified' | 'verified' | 'trusted' | 'missing' | 'stale';

export interface AuditEdge {
  fromId: string;
  toId: string;
  kind: EdgeKind;
  label?: string;
  trustStatus: TrustStatus;
}

export interface AuditGraph {
  nodes: Map<string, AuditNode>;
  edges: AuditEdge[];
}

// ---------------------------------------------------------------------------
// Normalized claim context (§3.6)
// ---------------------------------------------------------------------------

export interface ResolvedDependency {
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

  const edges: AuditEdge[] = doc.edges.map((e) => ({
    fromId: e.from,
    toId: e.to,
    kind: 'explicitRef',
    label: e.label,
    trustStatus: 'unverified',
  }));

  return { nodes, edges };
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

  // BFS upstream (follow explicitRef edges backward).
  const reachable = new Set<string>();
  const queue = [...targetClaim.dependencies];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (reachable.has(next)) continue;
    reachable.add(next);
    const node = findNodeByLabel(graph, next);
    if (node) {
      const claim = doc.claims.find((c) => c.id === node.id);
      if (claim) queue.push(...claim.dependencies);
    }
  }

  const resolvedDependencies: ResolvedDependency[] = [];
  const unresolvedDependencyLabels: string[] = [];

  for (const label of targetClaim.dependencies) {
    const depNode = findNodeByLabel(graph, label);
    if (depNode) {
      resolvedDependencies.push({
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
        : `-- ${d.label}: ${d.statementText}`,
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
    deps: context.resolvedDependencies.map((d) => ({
      label: d.label,
      statementText: d.statementText,
    })),
    unresolvedDeps: context.unresolvedDependencyLabels,
  });
}

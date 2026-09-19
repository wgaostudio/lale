import type { ParsedClaim, ParsedDocument } from '@lale/document-parser';

export type UpstreamPlanItem =
  | { type: 'claim'; claim: ParsedClaim; viaLabel: string; direct: boolean }
  | { type: 'unresolved'; label: string; direct: boolean };

/**
 * Post-order walk of the dependency labels reachable from `target`, so the
 * returned list is already in the order things have to be verified: a claim
 * never appears before something it depends on. Cycles are cut by `path`, and a
 * claim reached both directly and transitively keeps the `direct` flag.
 */
export function buildUpstreamPlan(
  target: ParsedClaim,
  document: ParsedDocument | null,
): UpstreamPlanItem[] {
  if (!document) return [];

  const claimsById = new Map(document.claims.map((claim) => [claim.id, claim]));
  const claimsByLabel = new Map<string, ParsedClaim>();
  for (const claim of document.claims) {
    if (claim.label) claimsByLabel.set(claim.label, claim);
  }

  const plan: UpstreamPlanItem[] = [];
  const claimItemById = new Map<string, Extract<UpstreamPlanItem, { type: 'claim' }>>();
  const unresolvedByLabel = new Map<string, Extract<UpstreamPlanItem, { type: 'unresolved' }>>();
  const visited = new Set<string>();

  const resolve = (label: string): ParsedClaim | null =>
    claimsByLabel.get(label) ?? claimsById.get(label) ?? null;

  const visit = (label: string, direct: boolean, path: Set<string>): void => {
    const dependency = resolve(label);
    if (!dependency) {
      const existing = unresolvedByLabel.get(label);
      if (existing) {
        if (direct) existing.direct = true;
        return;
      }
      const item: Extract<UpstreamPlanItem, { type: 'unresolved' }> = {
        type: 'unresolved',
        label,
        direct,
      };
      unresolvedByLabel.set(label, item);
      plan.push(item);
      return;
    }

    if (dependency.id === target.id) return;
    if (path.has(dependency.id)) return;

    const existing = claimItemById.get(dependency.id);
    if (existing) {
      if (direct) existing.direct = true;
      return;
    }

    if (!visited.has(dependency.id)) {
      path.add(dependency.id);
      for (const childLabel of dependency.dependencies) {
        visit(childLabel, false, path);
      }
      path.delete(dependency.id);
      visited.add(dependency.id);
    }

    const item: Extract<UpstreamPlanItem, { type: 'claim' }> = {
      type: 'claim',
      claim: dependency,
      viaLabel: label,
      direct,
    };
    claimItemById.set(dependency.id, item);
    plan.push(item);
  };

  const path = new Set<string>([target.id]);
  for (const label of target.dependencies) {
    visit(label, true, path);
  }

  return plan;
}

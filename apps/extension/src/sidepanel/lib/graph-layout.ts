import type { ParsedClaim, ParsedDocument } from '@lale/document-parser';

/**
 * One claim per row, with dependency edges drawn as vertical lanes in a left
 * gutter — the layout `git log --graph` uses. A layered top-to-bottom graph is
 * as wide as its widest layer, which a document with several independent roots
 * blows past immediately; here width is bounded by how many dependency chains
 * are open at once (typically three or four) and depth costs vertical space,
 * which a side panel has for free.
 */
export interface GraphRow {
  claim: ParsedClaim;
  /** Lane this claim's node sits in. */
  lane: number;
  /** Lanes whose lines pass this row untouched. */
  through: number[];
  /** Lanes arriving from above that terminate here (prerequisites merging in). */
  incoming: number[];
  /** Lanes leaving downward toward claims that depend on this one. */
  outgoing: number[];
  /**
   * Edges touching this claim that no lane was available to draw, or that run
   * backwards through a dependency cycle. Surfaced in the row so the gutter is
   * never quietly incomplete.
   */
  bundled: number;
}

export interface GraphLayout {
  rows: GraphRow[];
  laneCount: number;
  omitted: number;
}

/** Past this the gutter stops being readable; the claim list is the better tool. */
const MAX_NODES = 40;
/**
 * Hard ceiling on gutter width. A claim that thirty others cite would otherwise
 * open thirty lanes and squeeze the labels out of a side panel; past this the
 * overflow is counted on the row instead, and the claim's own detail view lists
 * every dependency exactly.
 */
const MAX_LANES = 5;

/**
 * Topological order that prefers to continue the chain it is already on: when
 * emitting a claim frees a dependent, that dependent goes to the front of the
 * queue. Ordering strictly by depth instead would emit every root first, which
 * forces a lane to stay open from the root all the way down to its dependent
 * and makes the gutter far wider than it needs to be.
 *
 * A cycle leaves claims that never become ready; the least-blocked one is
 * released to break the deadlock. The parser reports cycles as issues.
 */
function topologicalOrder(
  claims: ParsedClaim[],
  dependenciesOf: Map<string, Set<string>>,
  dependentsOf: Map<string, Set<string>>,
): ParsedClaim[] {
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const unsatisfied = new Map<string, number>(
    claims.map((claim) => [claim.id, dependenciesOf.get(claim.id)?.size ?? 0]),
  );

  const ready = claims
    .filter((claim) => (unsatisfied.get(claim.id) ?? 0) === 0)
    .map((claim) => claim.id);

  const emitted = new Set<string>();
  const order: ParsedClaim[] = [];

  while (order.length < claims.length) {
    if (ready.length === 0) {
      const stuck = claims
        .filter((claim) => !emitted.has(claim.id))
        .sort((a, b) => (unsatisfied.get(a.id) ?? 0) - (unsatisfied.get(b.id) ?? 0))[0];
      if (!stuck) break;
      ready.push(stuck.id);
    }

    const id = ready.shift();
    if (id == null || emitted.has(id)) continue;
    emitted.add(id);

    const claim = byId.get(id);
    if (claim) order.push(claim);

    const freed: string[] = [];
    for (const dependentId of dependentsOf.get(id) ?? []) {
      if (emitted.has(dependentId)) continue;
      const left = (unsatisfied.get(dependentId) ?? 0) - 1;
      unsatisfied.set(dependentId, left);
      if (left <= 0) freed.push(dependentId);
    }
    ready.unshift(...freed);
  }

  return order;
}

export function layoutGraph(document: ParsedDocument | null): GraphLayout | null {
  if (!document || document.claims.length === 0) return null;

  const claims = document.claims.slice(0, MAX_NODES);
  const omitted = document.claims.length - claims.length;
  const included = new Set(claims.map((claim) => claim.id));

  // edge.from depends on edge.to, so `to` is the prerequisite and has to appear
  // above `from` for the gutter to read downward.
  const dependenciesOf = new Map<string, Set<string>>();
  const dependentsOf = new Map<string, Set<string>>();
  for (const edge of document.edges) {
    if (!included.has(edge.from) || !included.has(edge.to)) continue;
    if (edge.from === edge.to) continue;
    const dependencies = dependenciesOf.get(edge.from);
    if (dependencies) dependencies.add(edge.to);
    else dependenciesOf.set(edge.from, new Set([edge.to]));
    const dependents = dependentsOf.get(edge.to);
    if (dependents) dependents.add(edge.from);
    else dependentsOf.set(edge.to, new Set([edge.from]));
  }

  const ordered = topologicalOrder(claims, dependenciesOf, dependentsOf);

  const rowIndexOf = new Map(ordered.map((claim, index) => [claim.id, index]));

  // lanes[i] holds the id of the claim that lane i is currently running toward,
  // or null when the lane is free to reuse.
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let laneCount = 0;

  // Number of edges that could not be given a lane, keyed by the claim at the
  // lower end. Prerequisites are always emitted first, so by the time a row is
  // built its tally is final.
  const undrawnInto = new Map<string, number>();
  const bump = (id: string): void => {
    undrawnInto.set(id, (undrawnInto.get(id) ?? 0) + 1);
  };

  /** Index of a reusable lane, or -1 when the ceiling has been reached. */
  const firstFreeLane = (): number => {
    const index = lanes.indexOf(null);
    if (index !== -1) return index;
    if (lanes.length < MAX_LANES) {
      lanes.push(null);
      return lanes.length - 1;
    }
    return -1;
  };

  for (const claim of ordered) {
    const incoming: number[] = [];
    lanes.forEach((target, index) => {
      if (target === claim.id) incoming.push(index);
    });

    let lane: number;
    if (incoming.length > 0) {
      lane = Math.min(...incoming);
    } else {
      const free = firstFreeLane();
      // With every lane spoken for, the node shares the last one rather than
      // evicting its reservation — evicting would strand the line an earlier
      // row already drew heading into it. Sharing just puts the dot on top of a
      // passing line; any edge this claim then needs is counted as undrawn.
      lane = free !== -1 ? free : MAX_LANES - 1;
    }

    // Lanes carrying unrelated chains past this row, captured before the
    // arriving ones are released.
    const through: number[] = [];
    lanes.forEach((target, index) => {
      if (target != null && !incoming.includes(index)) through.push(index);
    });

    // Only lanes that terminate here are released. When this claim is sharing
    // an occupied lane, that lane's reservation belongs to another chain and
    // must survive — clearing it would strand the line running into it.
    for (const index of incoming) lanes[index] = null;

    // Every dependent needs its own line down from this claim, so two
    // prerequisites feeding one claim show as two lanes converging on it.
    const dependents = [...(dependentsOf.get(claim.id) ?? [])]
      .filter((id) => (rowIndexOf.get(id) ?? -1) > (rowIndexOf.get(claim.id) ?? -1))
      .sort((a, b) => (rowIndexOf.get(a) ?? 0) - (rowIndexOf.get(b) ?? 0));

    const outgoing: number[] = [];
    for (const dependentId of dependents) {
      // Reuse this claim's own lane for the nearest dependent so the common
      // case draws as a straight line rather than a needless sidestep.
      const target = lanes[lane] == null ? lane : firstFreeLane();
      if (target === -1) {
        bump(dependentId);
        continue;
      }
      lanes[target] = dependentId;
      outgoing.push(target);
    }

    // Dependents already emitted are back edges through a cycle; there is no
    // downward lane to draw them in.
    const backEdges = [...(dependentsOf.get(claim.id) ?? [])].filter(
      (id) => (rowIndexOf.get(id) ?? -1) <= (rowIndexOf.get(claim.id) ?? -1),
    ).length;

    laneCount = Math.max(laneCount, lanes.length, lane + 1);
    rows.push({
      claim,
      lane,
      through,
      incoming,
      outgoing,
      bundled: (undrawnInto.get(claim.id) ?? 0) + backEdges,
    });
  }

  return { rows, laneCount, omitted };
}

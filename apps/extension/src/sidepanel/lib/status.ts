/**
 * Status vocabulary. Colour in this UI only ever means verification state, so
 * every tone decision funnels through here rather than being spelled out at
 * call sites.
 */
import { isVerifiableClaimKind, type ParsedClaim } from '@lale/document-parser';
import type { Tone } from '@lale/ui';
import type { ClaimRuntimeState, ExtensionState, InformalAuditState } from '../../shared/messages';

export function isVerifiableClaim(claim: ParsedClaim): boolean {
  return isVerifiableClaimKind(claim.kind);
}

export function shortLabel(claim: ParsedClaim): string {
  return claim.label ?? `${claim.kind} ${claim.startLine}`;
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function statusTone(status: string): Tone {
  if (status === 'formalized' || status === 'verified' || status === 'verifiedByOverride') return 'ok';
  if (status === 'failed' || status === 'blocked') return 'bad';
  if (status === 'pending') return 'idle';
  return 'warn';
}

/** Work actively in flight — drives the pulsing status dot. */
export function isRunning(status: string): boolean {
  return status === 'checking';
}

export function formatDocumentItemStatus(claim: ParsedClaim, status: string): string {
  if (isVerifiableClaim(claim)) {
    if (status === 'verifiedByOverride') return 'override verified';
    if (status === 'checking') return 'checking';
    return status;
  }
  if (status === 'checking') return 'formalizing';
  if (status === 'formalized') return 'formalized';
  if (status === 'failed') return 'formalization failed';
  if (status === 'blocked') return 'formalization blocked';
  if (status === 'verifiedByOverride') return 'override accepted';
  if (status === 'stale') return 'stale';
  return 'needs formalization';
}

export function formatRunPhase(phase: NonNullable<ClaimRuntimeState['phase']>): string {
  switch (phase) {
    case 'parseSnapshot':
      return 'parsing snapshot';
    case 'buildGraph':
      return 'building dependency graph';
    case 'selectContext':
      return 'selecting context';
    case 'informalAudit':
      return 'running informal advisory';
    case 'formalizeStatement':
      return 'formalizing statement';
    case 'faithfulness':
      return 'checking faithfulness';
    case 'freezeHeader':
      return 'freezing Lean header';
    case 'proofSteps':
      return "checking the proof's steps";
    case 'proposerAttempt':
      return 'proposing a proof';
    case 'finalGate':
      return 'running final gate';
    case 'complete':
      return 'complete';
  }
}

export function formatRuntimeStage(
  claim: ParsedClaim,
  runtime: ClaimRuntimeState | undefined,
): string {
  if (runtime?.phase && runtime.phase !== 'complete') return formatRunPhase(runtime.phase);
  if (runtime?.lastMessage) return runtime.lastMessage;

  const status = runtime?.status ?? 'pending';
  if (status === 'formalized' || status === 'verified' || status === 'verifiedByOverride') {
    return 'ready for downstream use';
  }
  if (status === 'failed') return 'failed before stage was recorded';
  if (status === 'stale') return 'stale; rerun required';
  if (status === 'checking') return 'queued';
  return isVerifiableClaim(claim) ? 'not started' : 'not formalized';
}

export function formatRunEventLine(event: ExtensionState['latestRunEvents'][number]): string {
  const payload = (event.payload ?? null) as Record<string, unknown> | null;
  const rawDiagnostics = payload?.['diagnostics'];
  const diagnostics = Array.isArray(rawDiagnostics)
    ? rawDiagnostics.filter((item): item is string => typeof item === 'string')
    : [];
  const firstDiagnostic = diagnostics[0];
  const detail = firstDiagnostic ? ` — ${firstDiagnostic}` : '';
  return `[${event.phase}] ${event.level}: ${event.message}${detail}`;
}

export function formatVerdict(verdict: InformalAuditState['verdict']): string {
  switch (verdict) {
    case 'noObviousIssue':
      return 'No obvious issue';
    case 'possibleTypo':
      return 'Possible typo';
    case 'possibleGap':
      return 'Possible gap in proof';
    case 'possibleContradiction':
      return 'Possible contradiction';
    case 'possibleClaimProofMismatch':
      return 'Possible claim/proof mismatch';
    case 'uncertain':
      return 'Uncertain';
    default:
      return 'Advisory';
  }
}

export function projectSubtitle(current: ExtensionState): string {
  return (
    current.desktopProject?.name ??
    current.projectContext?.projectId ??
    'Overleaf project not detected'
  );
}

export function findRuntime(
  current: ExtensionState,
  claimId: string,
): ClaimRuntimeState | undefined {
  return current.claimStates.find((item) => item.claimId === claimId);
}

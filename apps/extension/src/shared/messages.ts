import type { ParsedDocument } from '@lale/document-parser';
import type {
  AcceptedRunResponse,
  VerificationMode,
  DesktopProject,
  ExtensionClaimStatus,
  HealthResponse,
  InformalAuditVerdict,
  OverleafDocumentSnapshot,
  OverleafProjectContext,
  ProviderConfigSummary,
  ProvisionEvent,
  ProvisionStateResponse,
  RunEvent,
  RunPhase,
  VerificationOutcome,
} from '@lale/protocol';

/**
 * What the panel shows for one model role. An alias rather than a second
 * declaration: the wire shape is the protocol's, and a local copy of it only
 * typechecks against the desktop until one of the two gains a field.
 */
export type ProviderConfigInfo = ProviderConfigSummary;

export type DesktopConnectionStatus = 'unknown' | 'connected' | 'offline';
export type DesktopAuthStatus = 'unknown' | 'authorized' | 'unauthorized';
export type ProjectLinkStatus = 'unknown' | 'linked' | 'notLinked';

export interface ClaimRuntimeState {
  claimId: string;
  status: ExtensionClaimStatus;
  runId: string | null;
  phase: RunPhase | null;
  lastMessage: string | null;
  outcome: VerificationOutcome | null;
  updatedAt: string | null;
}

export type InformalAuditStatus = 'pending' | 'noObviousIssue' | 'warning' | 'paused' | 'failed';

export interface InformalAuditState {
  runId: string;
  claimId: string;
  status: InformalAuditStatus;
  verdict: InformalAuditVerdict | null;
  confidence: 'low' | 'medium' | 'high' | null;
  findings: string[];
  paused: boolean;
  overridden: boolean;
  overrideReason: string | null;
  overriddenAt: string | null;
  message: string | null;
}

export interface ExtensionState {
  desktopStatus: DesktopConnectionStatus;
  desktopAuthStatus: DesktopAuthStatus;
  hasBearerToken: boolean;
  desktopHealth: HealthResponse | null;
  projectContext: OverleafProjectContext | null;
  projectStatus: ProjectLinkStatus;
  desktopProject: DesktopProject | null;
  snapshot: OverleafDocumentSnapshot | null;
  parsedDocument: ParsedDocument | null;
  claimStates: ClaimRuntimeState[];
  activeRunId: string | null;
  latestRunEvents: RunEvent[];
  latestAcceptedRun: AcceptedRunResponse | null;
  informalAudit: InformalAuditState | null;
  formalizerConfig: ProviderConfigInfo | null;
  /** Proof generation — the deepest reasoning and the largest share of spend. */
  proposerConfig: ProviderConfigInfo | null;
  auxiliaryConfig: ProviderConfigInfo | null;
  // One OpenRouter key backs all three model roles.
  hasOpenRouterKey: boolean;
  provision: ProvisionStateResponse | null;
  // Most recent provisioning log lines for live progress. Capped to keep
  // chrome.storage payloads small.
  provisionEvents: ProvisionEvent[];
  error: string | null;
  updatedAt: string;
}

export type ContentToBackgroundMessage =
  | { type: 'content.projectDetected'; project: OverleafProjectContext }
  | {
      type: 'content.snapshotCaptured';
      snapshot: OverleafDocumentSnapshot;
      parsedDocument: ParsedDocument;
    }
  | { type: 'content.captureFailed'; reason: string };

export type SidepanelToBackgroundMessage =
  | { type: 'sidepanel.getState' }
  | { type: 'sidepanel.refreshDesktop' }
  | { type: 'sidepanel.createProject' }
  | { type: 'sidepanel.verifyClaim'; claimId: string; mode?: VerificationMode }
  | { type: 'sidepanel.jumpToSource'; claimId: string }
  | { type: 'sidepanel.acknowledgeInformalAudit'; runId: string; reason: string }
  | { type: 'sidepanel.requestPairing' }
  | { type: 'sidepanel.setBearerToken'; token: string }
  | { type: 'sidepanel.clearBearerToken' }
  | { type: 'sidepanel.startProvision'; force?: boolean }
  | { type: 'sidepanel.setOpenRouterKey'; key: string }
  | { type: 'sidepanel.clearOpenRouterKey' };

export type BackgroundToContentMessage = { type: 'content.jumpToSource'; startOffset: number };

export type BackgroundBroadcastMessage = { type: 'state.updated'; state: ExtensionState };

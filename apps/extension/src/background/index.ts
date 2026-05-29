import {
  AcceptedRunResponse,
  CreateProjectRequest,
  HealthResponse,
  InformalAuditVerdict,
  ProjectLookupRequest,
  ProjectLookupResponse,
  ProvisionEvent,
  ProvisionStateResponse,
  RunEvent,
  VerificationRequest,
} from '@lale/protocol';
import { PARSER_VERSION } from '@lale/document-parser';
import type { ParsedClaim } from '@lale/document-parser';
import type {
  AuxiliaryConfigInfo,
  BackgroundBroadcastMessage,
  BackgroundToContentMessage,
  ClaimRuntimeState,
  ContentToBackgroundMessage,
  ExtensionState,
  FormalizerOption,
  InformalAuditState,
  SidepanelToBackgroundMessage,
} from '../shared/messages';

const DESKTOP_URL = 'http://127.0.0.1:8765';
const STATE_STORAGE_KEY = 'lale.extensionState';

const BEARER_TOKEN_STORAGE_KEY = 'lale.bearerToken';
const MAX_PROVISION_EVENTS = 80;
const MAX_RUN_EVENTS = 120;

async function getBearerToken(): Promise<string | null> {
  const stored = await chrome.storage.local.get(BEARER_TOKEN_STORAGE_KEY).catch(() => ({}));
  return (stored as Record<string, unknown>)[BEARER_TOKEN_STORAGE_KEY] as string | null ?? null;
}

async function writeBearerToken(token: string | null): Promise<void> {
  if (token === null) {
    await chrome.storage.local.remove(BEARER_TOKEN_STORAGE_KEY).catch(() => undefined);
    return;
  }
  await chrome.storage.local
    .set({ [BEARER_TOKEN_STORAGE_KEY]: token })
    .catch(() => undefined);
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { 'content-type': 'application/json', authorization: `Bearer ${token}` } : { 'content-type': 'application/json' };
}

let state: ExtensionState = {
  desktopStatus: 'unknown',
  desktopAuthStatus: 'unknown',
  hasBearerToken: false,
  desktopHealth: null,
  projectContext: null,
  projectStatus: 'unknown',
  desktopProject: null,
  snapshot: null,
  parsedDocument: null,
  claimStates: [],
  activeRunId: null,
  latestRunEvents: [],
  latestAcceptedRun: null,
  informalAudit: null,
  formalizerOptions: null,
  auxiliaryConfig: null,
  provision: null,
  provisionEvents: [],
  error: null,
  updatedAt: new Date().toISOString(),
};

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

void restoreState();

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  void handleMessage(message, sender.tab?.id ?? null)
    .then((response) => sendResponse({ ok: true, response }))
    .catch((error: unknown) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );

  return true;
});

async function handleMessage(message: unknown, tabId: number | null): Promise<unknown> {
  if (isContentMessage(message)) {
    await handleContentMessage(message);
    return state;
  }

  if (isSidepanelMessage(message)) {
    return handleSidepanelMessage(message, tabId);
  }

  return null;
}

async function handleContentMessage(message: ContentToBackgroundMessage): Promise<void> {
  if (message.type === 'content.projectDetected') {
    await setState({
      projectContext: message.project,
      error: null,
    });
    await refreshDesktopState();
    return;
  }

  if (message.type === 'content.captureFailed') {
    await setState({ error: message.reason });
    return;
  }

  await setState({
    snapshot: message.snapshot,
    parsedDocument: message.parsedDocument,
    claimStates: deriveClaimStates(message.parsedDocument.claims),
    error: null,
  });
  await refreshProjectLookup();
}

async function handleSidepanelMessage(
  message: SidepanelToBackgroundMessage,
  tabId: number | null,
): Promise<unknown> {
  switch (message.type) {
    case 'sidepanel.getState':
      await refreshDesktopState();
      return state;
    case 'sidepanel.refreshDesktop':
      await refreshDesktopState();
      return state;
    case 'sidepanel.createProject':
      await createProject();
      return state;
    case 'sidepanel.verifyClaim':
      await verifyClaim(message.claimId);
      return state;
    case 'sidepanel.jumpToSource':
      await jumpToSource(message.claimId, tabId);
      return state;
    case 'sidepanel.acknowledgeInformalAudit':
      await acknowledgeInformalAudit(message.runId, message.reason);
      return state;
    case 'sidepanel.setBearerToken':
      await applyBearerToken(message.token);
      return state;
    case 'sidepanel.clearBearerToken':
      await applyBearerToken(null);
      return state;
    case 'sidepanel.startProvision':
      await startProvisionRun(message.force ?? false);
      return state;
    case 'sidepanel.switchFormalizer':
      await switchFormalizer(message.configId, message.optionKey);
      return state;
    case 'sidepanel.setNamedKey':
      await setNamedProviderKey(message.provider, message.key);
      return state;
    case 'sidepanel.clearNamedKey':
      await clearNamedProviderKey(message.provider);
      return state;
  }
}

async function refreshDesktopState(): Promise<void> {
  const token = await getBearerToken();
  const hasBearerToken = token !== null && token.length > 0;

  try {
    const response = await fetch(`${DESKTOP_URL}/v1/health`, {
      headers: authHeaders(token),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = HealthResponse.parse(await response.json());
    await setState({
      desktopStatus: 'connected',
      desktopHealth: health,
      hasBearerToken,
      error: null,
    });

    // Probe authentication and refresh provision state in one round trip.
    // /v1/provision is auth-required and cheap; a 401 here is the definitive
    // "your token is invalid" signal that /v1/health (public) can't give us.
    await refreshProvisionState(token);

    if (state.desktopAuthStatus !== 'unauthorized') {
      await refreshProjectLookup();
      await refreshProviderConfigs(token);
    }
  } catch (error) {
    await setState({
      desktopStatus: 'offline',
      desktopAuthStatus: 'unknown',
      desktopHealth: null,
      hasBearerToken,
      projectStatus: 'unknown',
      desktopProject: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function refreshProvisionState(token: string | null): Promise<void> {
  if (!token) {
    await setState({ desktopAuthStatus: 'unknown', provision: null });
    return;
  }

  try {
    const response = await fetch(`${DESKTOP_URL}/v1/provision`, {
      headers: authHeaders(token),
    });
    if (response.status === 401) {
      await setState({ desktopAuthStatus: 'unauthorized', provision: null });
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const provision = ProvisionStateResponse.parse(await response.json());
    await setState({ desktopAuthStatus: 'authorized', provision });
  } catch {
    // Network or parse error — leave auth status as-is.
  }
}

async function refreshProjectLookup(): Promise<void> {
  if (state.desktopStatus !== 'connected') return;
  if (!state.projectContext && !state.snapshot) return;

  const token = await getBearerToken();
  const request: ProjectLookupRequest = {
    protocolVersion: 1,
    sourceKind: 'overleaf',
    overleafProjectId: state.snapshot?.projectId ?? state.projectContext?.projectId ?? null,
    overleafUrl: state.snapshot?.url ?? state.projectContext?.url ?? null,
    documentFingerprint: state.parsedDocument?.fingerprint ?? null,
  };

  try {
    const response = await fetch(`${DESKTOP_URL}/v1/projects/lookup`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const lookup = ProjectLookupResponse.parse(await response.json());
    const claimStates = state.parsedDocument
      ? mergeDesktopClaimStatuses(
          state.parsedDocument.claims,
          state.claimStates,
          lookup.claimStatuses,
        )
      : state.claimStates;
    await setState({
      projectStatus: lookup.status === 'linked' ? 'linked' : 'notLinked',
      desktopProject: lookup.project,
      claimStates,
    });
  } catch {
    await setState({ projectStatus: 'unknown', desktopProject: null });
  }
}

async function createProject(): Promise<void> {
  if (!state.parsedDocument) throw new Error('No parsed document available.');

  const token = await getBearerToken();
  const request: CreateProjectRequest = {
    protocolVersion: 1,
    sourceKind: 'overleaf',
    overleafProjectId: state.snapshot?.projectId ?? state.projectContext?.projectId ?? null,
    overleafUrl: state.snapshot?.url ?? state.projectContext?.url ?? null,
    documentFingerprint: state.parsedDocument.fingerprint,
    name: projectNameFromContext(),
  };

  const response = await fetch(`${DESKTOP_URL}/v1/projects`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`Desktop app returned HTTP ${response.status}`);

  const lookup = ProjectLookupResponse.parse(await response.json());
  await setState({
    projectStatus: lookup.status === 'linked' ? 'linked' : 'notLinked',
    desktopProject: lookup.project,
    error: null,
  });
}

async function verifyClaim(claimId: string): Promise<void> {
  if (!state.snapshot || !state.parsedDocument) {
    throw new Error('No document snapshot available.');
  }

  const claim = state.parsedDocument.claims.find((item) => item.id === claimId);
  if (!claim) throw new Error(`Document item not found: ${claimId}`);
  await setState({
    claimStates: updateClaimRuntime(state.claimStates, claimId, {
      status: 'checking',
      runId: null,
      phase: null,
      lastMessage: 'Submitting verification request',
      outcome: null,
      updatedAt: new Date().toISOString(),
    }),
    activeRunId: null,
    latestRunEvents: [],
    latestAcceptedRun: null,
    informalAudit: null,
  });

  const token = await getBearerToken();
  const request: VerificationRequest = {
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
    projectId: state.desktopProject?.id ?? null,
    claimId,
    snapshot: state.snapshot,
    parsedDocumentFingerprint: state.parsedDocument.fingerprint,
    parserVersion: PARSER_VERSION,
  };

  const response = await fetch(`${DESKTOP_URL}/v1/verify`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Desktop app returned HTTP ${response.status}`);
  }

  const accepted = AcceptedRunResponse.parse(await response.json());
  await setState({
    activeRunId: accepted.runId,
    latestAcceptedRun: accepted,
    claimStates: updateClaimRuntime(state.claimStates, claimId, {
      status: 'checking',
      runId: accepted.runId,
      phase: 'parseSnapshot',
      lastMessage: 'Run accepted by desktop',
      outcome: null,
      updatedAt: new Date().toISOString(),
    }),
  });

  // Subscribe to SSE run events.
  subscribeToRunEvents(accepted.runId, claimId, token);
}

function subscribeToRunEvents(runId: string, claimId: string, token: string | null): void {
  const url = `${DESKTOP_URL}/v1/runs/${runId}/events`;

  // EventSource doesn't support custom headers; we append token as a query param.
  // The server should also accept it there as a fallback.
  const urlWithToken = token ? `${url}?token=${encodeURIComponent(token)}` : url;

  // Fallback: use fetch-based SSE since EventSource can't set headers.
  void (async () => {
    try {
      const sseResponse = await fetch(urlWithToken, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });

      if (!sseResponse.ok || !sseResponse.body) {
        console.error('[lale] run stream request failed', {
          runId,
          claimId,
          status: sseResponse.status,
        });
        await setState({
          claimStates: updateClaimRuntime(state.claimStates, claimId, {
            status: 'failed',
            runId,
            phase: null,
            lastMessage: `Run stream returned HTTP ${sseResponse.status}`,
            outcome: null,
            updatedAt: new Date().toISOString(),
          }),
        });
        return;
      }

      const reader = sseResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';

        for (const chunk of lines) {
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
          const eventLine = chunk.split('\n').find((l) => l.startsWith('event:'));

          if (!dataLine) continue;
          const data = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
          const eventName = eventLine?.slice(6).trim() ?? 'run_event';

          if (eventName === 'run_event') {
            const event = RunEvent.safeParse(data);
            if (event.success) {
              console.debug('[lale] run event', {
                runId,
                claimId,
                phase: event.data.phase,
                level: event.data.level,
                message: event.data.message,
                payload: event.data.payload,
              });
              const nextEvents = [...state.latestRunEvents, event.data];
              if (nextEvents.length > MAX_RUN_EVENTS) {
                nextEvents.splice(0, nextEvents.length - MAX_RUN_EVENTS);
              }
              const patch: Partial<ExtensionState> = {
                latestRunEvents: nextEvents,
                claimStates: updateClaimRuntime(state.claimStates, claimId, {
                  status: 'checking',
                  runId,
                  phase: event.data.phase,
                  lastMessage: event.data.message,
                  outcome: null,
                  updatedAt: event.data.timestamp,
                }),
              };
              if (event.data.phase === 'informalAudit') {
                patch.informalAudit = updateInformalAudit(
                  state.informalAudit,
                  runId,
                  claimId,
                  event.data,
                );
              }
              await setState(patch);
            }
          } else if (eventName === 'complete') {
            const outcome = data['outcome'] as string | undefined;
            const claimStatus = outcomeToClaimStatus(outcome);
            console.info('[lale] run complete', { runId, claimId, outcome, claimStatus });
            await setState({
              activeRunId: null,
              claimStates: updateClaimRuntime(state.claimStates, claimId, {
                status: claimStatus,
                runId,
                phase: 'complete',
                lastMessage: outcome ? `Run finished: ${outcome}` : 'Run finished',
                outcome: parseOutcome(outcome),
                updatedAt: new Date().toISOString(),
              }),
            });
            return;
          } else if (eventName === 'error') {
            console.error('[lale] run stream error', { runId, claimId, data });
            await setState({
              activeRunId: null,
              claimStates: updateClaimRuntime(state.claimStates, claimId, {
                status: 'failed',
                runId,
                phase: null,
                lastMessage: 'Run stream error',
                outcome: null,
                updatedAt: new Date().toISOString(),
              }),
            });
            return;
          }
        }
      }
    } catch (error) {
      console.error('[lale] failed to consume run stream', { runId, claimId, error });
      await setState({
        claimStates: updateClaimRuntime(state.claimStates, claimId, {
          status: 'failed',
          runId,
          phase: null,
          lastMessage: error instanceof Error ? error.message : String(error),
          outcome: null,
          updatedAt: new Date().toISOString(),
        }),
      });
    }
  })();
}

function outcomeToClaimStatus(outcome: string | undefined): ExtensionClaimStatus {
  if (outcome === 'formalized') return 'formalized';
  if (outcome === 'verified') return 'verified';
  if (outcome === 'dependencyMissing' || outcome === 'verificationBlocked') return 'blocked';
  if (outcome === undefined) return 'pending';
  return 'failed';
}

type ExtensionClaimStatus = 'pending' | 'formalized' | 'verified' | 'verifiedByOverride' | 'stale' | 'blocked' | 'failed' | 'timedOut' | 'checking';

function parseOutcome(outcome: string | undefined): ClaimRuntimeState['outcome'] {
  switch (outcome) {
    case 'formalized':
    case 'verified':
    case 'malformedClaim':
    case 'malformedProof':
    case 'claimContradicted':
    case 'proofContradicted':
    case 'proofIncomplete':
    case 'proofDoesNotSupportClaim':
    case 'formalizationUnfaithful':
    case 'dependencyMissing':
    case 'verificationBlocked':
      return outcome;
    default:
      return null;
  }
}

async function jumpToSource(claimId: string, senderTabId: number | null): Promise<void> {
  const claim = state.parsedDocument?.claims.find((item) => item.id === claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);

  const tabId = senderTabId ?? (await activeOverleafTabId());
  if (tabId == null) throw new Error('No active Overleaf tab found.');

  const message: BackgroundToContentMessage = {
    type: 'content.jumpToSource',
    startOffset: claim.startOffset,
  };
  await chrome.tabs.sendMessage(tabId, message);
}

async function activeOverleafTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs.find((tab) => tab.url?.startsWith('https://www.overleaf.com/project/'))?.id ?? null;
}

async function setState(patch: Partial<ExtensionState>): Promise<void> {
  state = { ...state, ...patch, updatedAt: new Date().toISOString() };
  await chrome.storage.session.set({ [STATE_STORAGE_KEY]: state }).catch(() => undefined);
  const broadcast: BackgroundBroadcastMessage = { type: 'state.updated', state };
  chrome.runtime.sendMessage(broadcast).catch(() => undefined);
}

async function restoreState(): Promise<void> {
  const stored = await chrome.storage.session.get(STATE_STORAGE_KEY).catch(() => ({}));
  const restored = (stored as Record<string, unknown>)[STATE_STORAGE_KEY] as ExtensionState | undefined;
  if (restored) state = restored;
}

function deriveClaimStates(claims: ParsedClaim[]): ClaimRuntimeState[] {
  const previous = new Map(state.claimStates.map((claimState) => [claimState.claimId, claimState]));
  return claims.map((claim) => normalizeClaimRuntime(claim.id, previous.get(claim.id)));
}

function mergeDesktopClaimStatuses(
  claims: ParsedClaim[],
  current: ClaimRuntimeState[],
  statuses: ProjectLookupResponse['claimStatuses'],
): ClaimRuntimeState[] {
  if (statuses.length === 0) return current.map((claimState) => normalizeClaimRuntime(claimState.claimId, claimState));

  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const byLabel = new Map<string, ParsedClaim>();
  for (const claim of claims) {
    if (claim.label) byLabel.set(claim.label, claim);
  }

  let next = current.map((claimState) => normalizeClaimRuntime(claimState.claimId, claimState));
  for (const status of statuses) {
    const claim = byId.get(status.claimId)
      ?? (status.label ? byLabel.get(status.label) : undefined)
      ?? byLabel.get(status.claimId);
    if (!claim) continue;

    const previous = next.find((claimState) => claimState.claimId === claim.id);
    if (!status.runId && previous?.runId) continue;

    next = updateClaimRuntime(next, claim.id, {
      status: status.status,
      runId: status.runId,
      phase: status.phase,
      lastMessage: status.message,
      outcome: status.outcome,
      updatedAt: status.updatedAt,
    });
  }

  return next;
}

function normalizeClaimRuntime(
  claimId: string,
  previous?: Partial<ClaimRuntimeState>,
): ClaimRuntimeState {
  return {
    claimId,
    status: previous?.status ?? 'pending',
    runId: previous?.runId ?? null,
    phase: previous?.phase ?? null,
    lastMessage: previous?.lastMessage ?? null,
    outcome: previous?.outcome ?? null,
    updatedAt: previous?.updatedAt ?? null,
  };
}

function updateClaimRuntime(
  claims: ClaimRuntimeState[],
  claimId: string,
  patch: Partial<Omit<ClaimRuntimeState, 'claimId'>>,
): ClaimRuntimeState[] {
  let found = false;
  const updated = claims.map((claim) => {
    if (claim.claimId !== claimId) return normalizeClaimRuntime(claim.claimId, claim);
    found = true;
    return { ...normalizeClaimRuntime(claimId, claim), ...patch };
  });

  if (!found) {
    updated.push({ ...normalizeClaimRuntime(claimId), ...patch });
  }

  return updated;
}

function updateInformalAudit(
  previous: InformalAuditState | null,
  runId: string,
  claimId: string,
  event: RunEvent,
): InformalAuditState {
  const base: InformalAuditState = previous && previous.runId === runId
    ? previous
    : {
        runId,
        claimId,
        status: 'pending',
        verdict: null,
        confidence: null,
        findings: [],
        paused: false,
        overridden: false,
        overrideReason: null,
        overriddenAt: null,
        message: null,
      };

  const payload = (event.payload ?? null) as Record<string, unknown> | null;

  if (event.level === 'error') {
    return { ...base, status: 'failed', message: event.message };
  }

  const verdict = parseInformalVerdict(payload?.['verdict']);
  const confidence = parseConfidence(payload?.['confidence']);
  const findings = parseFindings(payload?.['findings']);
  const paused = parseBoolean(payload?.['paused']);
  const overridden = parseBoolean(payload?.['overridden']);
  const overrideReason = parseString(payload?.['overrideReason']);
  const overriddenAt = parseString(payload?.['overriddenAt']);
  const merged: InformalAuditState = {
    ...base,
    paused: paused ?? base.paused,
    overridden: overridden ?? base.overridden,
    overrideReason: overrideReason ?? base.overrideReason,
    overriddenAt: overriddenAt ?? base.overriddenAt,
  };

  if (merged.paused) {
    return {
      ...merged,
      status: 'paused',
      verdict: verdict ?? merged.verdict,
      confidence: confidence ?? merged.confidence,
      findings: findings ?? merged.findings,
      message: event.message,
    };
  }

  if (overridden) {
    return {
      ...merged,
      status: merged.status === 'paused' ? 'warning' : merged.status,
      verdict: verdict ?? merged.verdict,
      confidence: confidence ?? merged.confidence,
      findings: findings ?? merged.findings,
      message: event.message,
    };
  }

  // The pipeline emits a specific "No obvious issues found" info event when
  // the verdict is `noObviousIssue` (no payload). Detect both that and the
  // payload-carrying advisory event.
  if (verdict === 'noObviousIssue' || /no obvious issues/i.test(event.message)) {
    return {
      ...merged,
      status: 'noObviousIssue',
      verdict: 'noObviousIssue',
      confidence: confidence ?? merged.confidence,
      findings: findings ?? merged.findings,
      message: event.message,
    };
  }

  if (verdict || event.level === 'warning') {
    return {
      ...merged,
      status: 'warning',
      verdict: verdict ?? merged.verdict,
      confidence: confidence ?? merged.confidence,
      findings: findings ?? merged.findings,
      message: event.message,
    };
  }

  return { ...merged, message: event.message };
}

function parseInformalVerdict(value: unknown): InformalAuditState['verdict'] {
  const parsed = InformalAuditVerdict.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseConfidence(value: unknown): InformalAuditState['confidence'] {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  return null;
}

function parseFindings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  return null;
}

function parseString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

async function applyBearerToken(token: string | null): Promise<void> {
  const cleaned = token === null ? null : token.trim();
  await writeBearerToken(cleaned && cleaned.length > 0 ? cleaned : null);
  // Reset auth-derived state so the next refresh re-derives it cleanly.
  await setState({
    hasBearerToken: cleaned !== null && cleaned.length > 0,
    desktopAuthStatus: 'unknown',
    provision: null,
    error: null,
  });
  await refreshDesktopState();
}

async function startProvisionRun(force: boolean): Promise<void> {
  const token = await getBearerToken();
  if (!token) throw new Error('Connect to desktop first — paste the bearer token.');

  const response = await fetch(`${DESKTOP_URL}/v1/provision`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ protocolVersion: 1, force }),
  });

  if (response.status === 401) {
    await setState({ desktopAuthStatus: 'unauthorized' });
    throw new Error('Bearer token rejected by desktop.');
  }
  if (response.status === 409) {
    // Already running — pick up the existing state and stream.
    await refreshProvisionState(token);
    if (state.provision?.provisionId && state.provision.status === 'running') {
      subscribeToProvisionEvents(state.provision.provisionId, token);
    }
    return;
  }
  if (!response.ok) throw new Error(`Desktop app returned HTTP ${response.status}`);

  const body = (await response.json()) as { provisionId?: string; alreadyReady?: boolean };
  if (!body.provisionId) throw new Error('Desktop did not return a provisionId.');

  await setState({ provisionEvents: [] });
  await refreshProvisionState(token);

  if (!body.alreadyReady) {
    subscribeToProvisionEvents(body.provisionId, token);
  }
}

function subscribeToProvisionEvents(provisionId: string, token: string | null): void {
  const url = `${DESKTOP_URL}/v1/provision/${provisionId}/events`;

  void (async () => {
    try {
      const sseResponse = await fetch(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!sseResponse.ok || !sseResponse.body) {
        await refreshProvisionState(token);
        return;
      }

      const reader = sseResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';

        for (const chunk of chunks) {
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
          const eventLine = chunk.split('\n').find((l) => l.startsWith('event:'));
          if (!dataLine) continue;

          const data = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
          const eventName = eventLine?.slice(6).trim() ?? 'provision_event';

          if (eventName === 'provision_event') {
            const parsed = ProvisionEvent.safeParse(data);
            if (parsed.success) {
              const next = [...state.provisionEvents, parsed.data];
              if (next.length > MAX_PROVISION_EVENTS) {
                next.splice(0, next.length - MAX_PROVISION_EVENTS);
              }
              await setState({ provisionEvents: next });
            }
          } else if (eventName === 'complete') {
            await refreshProvisionState(token);
            // A completed provision changes Lean availability — re-check health.
            await refreshDesktopState();
            return;
          }
        }
      }

      // Stream ended without a complete frame — re-sync state.
      await refreshProvisionState(token);
    } catch {
      await refreshProvisionState(token);
    }
  })();
}

async function refreshProviderConfigs(token: string | null): Promise<void> {
  if (!token) {
    await setState({ formalizerOptions: null, auxiliaryConfig: null });
    return;
  }
  try {
    const response = await fetch(`${DESKTOP_URL}/v1/provider-configs`, {
      headers: authHeaders(token),
    });
    if (!response.ok) return;
    const data = (await response.json()) as {
      formalizerOptions: FormalizerOption[];
      auxiliaryConfig: AuxiliaryConfigInfo | null;
    };
    await setState({ formalizerOptions: data.formalizerOptions, auxiliaryConfig: data.auxiliaryConfig });
  } catch {
    // leave as-is on network error
  }
}

async function switchFormalizer(configId: string, optionKey: 'novita' | 'featherless'): Promise<void> {
  const token = await getBearerToken();
  const response = await fetch(`${DESKTOP_URL}/v1/provider-configs/${configId}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ optionKey }),
  });
  if (!response.ok) throw new Error(`Desktop app returned HTTP ${response.status}`);
  await refreshProviderConfigs(token);
}

async function setNamedProviderKey(provider: string, key: string): Promise<void> {
  const token = await getBearerToken();
  const response = await fetch(`${DESKTOP_URL}/v1/provider-keys/${encodeURIComponent(provider)}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({ key }),
  });
  if (!response.ok) throw new Error(`Desktop app returned HTTP ${response.status}`);
  await refreshProviderConfigs(token);
}

async function clearNamedProviderKey(provider: string): Promise<void> {
  const token = await getBearerToken();
  const response = await fetch(`${DESKTOP_URL}/v1/provider-keys/${encodeURIComponent(provider)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!response.ok) throw new Error(`Desktop app returned HTTP ${response.status}`);
  await refreshProviderConfigs(token);
}

async function acknowledgeInformalAudit(runId: string, reason: string): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error('Acknowledgement reason is required.');

  const token = await getBearerToken();
  const response = await fetch(`${DESKTOP_URL}/v1/runs/${runId}/informal-audit/acknowledge`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ reason: trimmed }),
  });
  if (!response.ok) {
    throw new Error(`Desktop app returned HTTP ${response.status}`);
  }

  if (!state.informalAudit || state.informalAudit.runId !== runId) return;
  await setState({
    informalAudit: {
      ...state.informalAudit,
      status: state.informalAudit.status === 'paused' ? 'warning' : state.informalAudit.status,
      paused: false,
      overridden: true,
      overrideReason: trimmed,
      overriddenAt: new Date().toISOString(),
    },
  });
}

function projectNameFromContext(): string {
  return state.snapshot?.projectId
    ? `Overleaf ${state.snapshot.projectId}`
    : state.projectContext?.projectId
      ? `Overleaf ${state.projectContext.projectId}`
      : 'Overleaf project';
}

function isContentMessage(message: unknown): message is ContentToBackgroundMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { type?: unknown }).type === 'string' &&
    (message as { type: string }).type.startsWith('content.')
  );
}

function isSidepanelMessage(message: unknown): message is SidepanelToBackgroundMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { type?: unknown }).type === 'string' &&
    (message as { type: string }).type.startsWith('sidepanel.')
  );
}

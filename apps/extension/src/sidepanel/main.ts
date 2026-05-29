import {
  isVerifiableClaimKind,
  type ParsedClaim,
  type ParsedDocument,
  type DocumentIssue,
} from '@lale/document-parser';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import type {
  AuxiliaryConfigInfo,
  BackgroundBroadcastMessage,
  ClaimRuntimeState,
  ExtensionState,
  FormalizerOption,
  InformalAuditState,
} from '../shared/messages';

let state: ExtensionState | null = null;
let selectedClaimId: string | null = null;
// Sidepanel-local: whether the inline acknowledgement form is expanded for the
// current advisory. Not part of ExtensionState — it's transient UI state.
let overrideFormOpen = false;
let overrideReasonDraft = '';
// Settings drawer + connect-screen transient state.
let view: 'main' | 'settings' = 'main';
let connectTokenDraft = '';
let keyDrafts: Record<string, string> = {};

const appRoot = document.querySelector<HTMLElement>('#app');
if (!appRoot) throw new Error('Missing #app root');
const root: HTMLElement = appRoot;

installStyles();
void loadState();

chrome.runtime.onMessage.addListener((message: BackgroundBroadcastMessage) => {
  if (message.type === 'state.updated') {
    state = message.state;
    render();
  }
});

async function loadState(): Promise<void> {
  const result = await sendMessage({ type: 'sidepanel.getState' });
  if (result?.ok && result.response) {
    state = result.response as ExtensionState;
  }
  render();
}

function render(): void {
  if (!state) {
    root.innerHTML = `<section class="empty"><h1>lale</h1><p>Loading extension state.</p></section>`;
    return;
  }

  // Force the connect view whenever we lack a usable token. The user can't
  // do anything meaningful until they paste one in.
  if (!state.hasBearerToken || state.desktopAuthStatus === 'unauthorized') {
    root.innerHTML = renderConnectView(state);
    bindActions();
    return;
  }

  if (view === 'settings') {
    root.innerHTML = renderSettingsView(state);
    bindActions();
    return;
  }

  const selected = selectedClaim(state.parsedDocument, selectedClaimId);

  root.innerHTML = `
    <header class="topbar">
      <div>
        <h1>lale</h1>
        <p>${projectSubtitle(state)}</p>
      </div>
      <div class="topbar-actions">
        <button class="icon-button" data-action="open-settings" title="Settings" aria-label="Settings">
          <span class="icon-glyph">⚙</span>
        </button>
        <button class="icon-button" data-action="refresh" title="Refresh desktop status" aria-label="Refresh desktop status">
          <span class="icon-glyph refresh-glyph">↻</span>
        </button>
      </div>
    </header>

    ${renderStatusStrip(state)}
    ${renderProvisionCallout(state)}
    ${renderProjectAction(state)}

    ${
      selected
        ? renderClaimDetail(selected, state)
        : `
          ${renderIssues(state.parsedDocument?.issues ?? [])}
          ${renderGraph(state.parsedDocument)}
          ${renderClaimList(state)}
        `
    }
  `;

  bindActions();
}

function renderConnectView(current: ExtensionState): string {
  const isUnauthorized = current.hasBearerToken && current.desktopAuthStatus === 'unauthorized';
  const desktopReachable = current.desktopStatus === 'connected';

  return `
    <header class="topbar">
      <div>
        <h1>lale</h1>
        <p>Connect to the desktop service</p>
      </div>
    </header>
    <section class="panel">
      <div class="panel-title">Bearer token required</div>
      <p>
        The lale desktop service prints a one-time connection token to its terminal on
        first run. Paste it below to authorize this extension.
      </p>
      <p class="muted snippet">
        Look for: <code>Extension connection token (paste into extension settings)</code>
      </p>
      <label class="field-label" for="connect-token">Token</label>
      <textarea
        class="token-input"
        id="connect-token"
        data-action="connect-input"
        rows="3"
        placeholder="Paste connection token"
        spellcheck="false"
        autocapitalize="off"
        autocorrect="off"
        autocomplete="off"
      >${escapeHtml(connectTokenDraft)}</textarea>
      <div class="actions">
        <button
          data-action="connect-save"
          ${connectTokenDraft.trim() ? '' : 'disabled'}
        >Connect</button>
      </div>
      <div class="connect-status">
        <span class="pill ${desktopReachable ? 'ok' : 'warn'}">
          Desktop ${desktopReachable ? 'reachable' : current.desktopStatus}
        </span>
        ${isUnauthorized ? `<span class="pill bad">Token rejected</span>` : ''}
      </div>
      ${current.error && !desktopReachable ? `<p class="muted">${escapeHtml(current.error)}</p>` : ''}
    </section>
  `;
}

function renderSettingsView(current: ExtensionState): string {
  return `
    <header class="topbar">
      <div>
        <h1>Settings</h1>
        <p class="muted">Extension and desktop configuration</p>
      </div>
      <button data-action="close-settings">Done</button>
    </header>
    <section class="panel">
      <div class="panel-title">Desktop connection</div>
      <div class="advisory-row">
        <span class="pill ${current.desktopAuthStatus === 'authorized' ? 'ok' : 'warn'}">
          ${current.desktopAuthStatus === 'authorized' ? 'Authorized' : 'Unverified'}
        </span>
        <span class="muted">Token stored locally; never sent off-device.</span>
      </div>
      <div class="actions">
        <button data-action="clear-token">Clear token</button>
      </div>
    </section>
    ${renderProviderKeysPanel(current)}
    ${renderProvisionPanel(current)}
  `;
}

function renderProviderKeysPanel(current: ExtensionState): string {
  const { formalizerOptions, auxiliaryConfig } = current;
  if (!formalizerOptions && !auxiliaryConfig) return '';

  return `
    <section class="panel">
      <div class="panel-title">Model API Keys</div>
      <p class="muted advisory-note">Bring your own keys. Model requests go to the selected provider or host; review their data retention policy before use.</p>
      ${formalizerOptions ? renderFormalizerSection(formalizerOptions) : ''}
      ${auxiliaryConfig ? renderAuxiliaryKeyRow(auxiliaryConfig) : ''}
    </section>
  `;
}

function renderFormalizerSection(options: FormalizerOption[]): string {
  return `
    <div class="key-section-head">Formalizer</div>
    <p class="muted advisory-note">Handles statement and proof formalization.</p>
    <div class="radio-group">
      ${options.map((option) => renderFormalizerOption(option)).join('')}
    </div>
  `;
}

function renderFormalizerOption(option: FormalizerOption): string {
  const draft = keyDrafts[option.optionKey] ?? '';
  return `
    <div class="radio-option ${option.active ? 'active' : ''}">
      <label class="radio-label">
        <input
          type="radio"
          name="formalizer"
          value="${escapeHtml(option.optionKey)}"
          data-action="switch-formalizer"
          data-config-id="${escapeHtml(option.configId)}"
          data-option-key="${escapeHtml(option.optionKey)}"
          ${option.active ? 'checked' : ''}
        >
        <span class="radio-text">
          <strong>${escapeHtml(option.label)}</strong>
          <small class="muted">via ${escapeHtml(option.provider)}</small>
        </span>
        <span class="pill ${option.hasKey ? 'ok' : 'warn'}">${option.hasKey ? 'Key set' : 'No key'}</span>
      </label>
      <div class="key-input-row">
        <input
          type="password"
          class="key-input"
          data-action="key-input"
          data-provider="${escapeHtml(option.optionKey)}"
          placeholder="${option.hasKey ? 'Replace existing key' : 'Paste API key'}"
          value="${escapeHtml(draft)}"
          autocomplete="new-password"
          spellcheck="false"
        />
        <button
          data-action="save-named-key"
          data-provider="${escapeHtml(option.optionKey)}"
          ${draft.trim() ? '' : 'disabled'}
        >Save</button>
        ${option.hasKey ? `<button data-action="clear-named-key" data-provider="${escapeHtml(option.optionKey)}">Clear</button>` : ''}
      </div>
    </div>
  `;
}

function renderAuxiliaryKeyRow(config: AuxiliaryConfigInfo): string {
  const draft = keyDrafts['openrouter'] ?? '';
  return `
    <div class="key-row">
      <div class="key-section-head">Auxiliary</div>
      <p class="muted advisory-note">${escapeHtml(config.modelId ?? '')} via OpenRouter — informal advisory model.</p>
      <div class="key-row-head">
        <span class="pill ${config.hasKey ? 'ok' : 'warn'}">${config.hasKey ? 'Key set' : 'No key'}</span>
      </div>
      <div class="key-input-row">
        <input
          type="password"
          class="key-input"
          data-action="key-input"
          data-provider="openrouter"
          placeholder="${config.hasKey ? 'Replace existing key' : 'Paste API key'}"
          value="${escapeHtml(draft)}"
          autocomplete="new-password"
          spellcheck="false"
        />
        <button
          data-action="save-named-key"
          data-provider="openrouter"
          ${draft.trim() ? '' : 'disabled'}
        >Save</button>
        ${config.hasKey ? `<button data-action="clear-named-key" data-provider="openrouter">Clear</button>` : ''}
      </div>
    </div>
  `;
}

function renderProvisionPanel(current: ExtensionState): string {
  const provision = current.provision;
  const status = provision?.status ?? 'idle';
  const ready = provision?.projectReady ?? false;
  const leanVersion = provision?.leanVersion ?? current.desktopHealth?.lean.version ?? '—';
  const mathlibRevision = provision?.mathlibRevision ?? '—';

  // Status from the last run dominates over the file-existence `ready` flag:
  // a half-built `.lake/` from a failed run satisfies `ready` but the toolchain
  // is not usable. Pill priority: running > failed > ready > idle.
  const pillClass =
    status === 'running'
      ? 'warn'
      : status === 'failed'
        ? 'bad'
        : ready || status === 'ready'
          ? 'ok'
          : 'warn';
  const statusLabel =
    status === 'running'
      ? 'Installing'
      : status === 'failed'
        ? 'Failed'
        : ready || status === 'ready'
          ? 'Ready'
          : 'Not installed';

  const buttonLabel =
    status === 'failed'
      ? 'Reprovision'
      : ready
        ? 'Reprovision'
        : 'Install Lean + Mathlib';
  const button =
    status === 'running'
      ? ''
      : `<button data-action="start-provision">${buttonLabel}</button>`;

  const helperText =
    status === 'running'
      ? 'Installing the local verification tools and proof library. The first setup can take several minutes.'
      : status === 'failed'
        ? 'The previous provisioning attempt failed. Reprovisioning will overwrite the partial install.'
        : ready
          ? 'Toolchain installed locally. Verification can run.'
          : 'Lean is not provisioned. Verification needs a local Lean toolchain plus Mathlib.';

  const log = renderProvisionLog(current);

  return `
    <section class="panel">
      <div class="panel-title">Lean + Mathlib</div>
      <div class="advisory-row">
        <span class="pill ${pillClass}">${escapeHtml(statusLabel)}</span>
        <span class="muted">Lean ${escapeHtml(leanVersion)} · Mathlib ${escapeHtml(mathlibRevision)}</span>
      </div>
      ${provision?.error ? `<p class="muted error-text">${escapeHtml(provision.error)}</p>` : ''}
      <p class="muted advisory-note">${helperText}</p>
      <div class="actions">${button}</div>
      ${log}
    </section>
  `;
}

function renderProvisionLog(current: ExtensionState): string {
  const events = current.provisionEvents;
  if (events.length === 0) return '';
  const lines = events.slice(-20).map((event) => `[${event.step}] ${event.message}`);
  return `
    <div class="panel-title sub">Recent activity</div>
    <pre class="provision-log">${escapeHtml(lines.join('\n'))}</pre>
  `;
}

function renderProvisionCallout(current: ExtensionState): string {
  // Suppress until the desktop has responded once; avoids a one-frame flash on
  // first render before /v1/provision has been hit.
  if (!current.provision) return '';

  const { status, projectReady } = current.provision;
  // A truly healthy toolchain has both projectReady AND a non-failed last run.
  // After a failed attempt, the .lake/ dir persists so projectReady is true,
  // but the install is broken — still surface the callout.
  if (projectReady && status !== 'failed') return '';

  const running = status === 'running';
  const failed = status === 'failed';

  const title = running
    ? 'Installing Lean + Mathlib…'
    : failed
      ? 'Lean provisioning failed'
      : 'Lean toolchain not installed';
  const body = running
    ? 'Provisioning is in progress. Watch progress in Settings.'
    : failed
      ? 'The last attempt errored out. Reprovision from Settings to retry.'
      : 'Verification cannot run until Lean and Mathlib are provisioned locally.';
  const cta = running ? 'View progress' : 'Open Settings';

  return `
    <section class="notice">
      <div>
        <strong>${title}</strong>
        <p class="muted">${body}</p>
      </div>
      <button data-action="open-settings">${cta}</button>
    </section>
  `;
}

function renderStatusStrip(current: ExtensionState): string {
  const desktopClass = current.desktopStatus === 'connected' ? 'ok' : 'bad';
  const projectClass = current.projectStatus === 'linked' ? 'ok' : 'warn';
  const docClass = current.parsedDocument ? 'ok' : 'warn';
  const items = current.parsedDocument?.claims ?? [];
  const verifiableCount = items.filter(isVerifiableClaim).length;
  const referenceCount = items.length - verifiableCount;
  const documentLabel = current.parsedDocument
    ? `${verifiableCount} claims${referenceCount > 0 ? ` · ${referenceCount} refs` : ''}`
    : '0 claims';

  return `
    <section class="status-strip">
      <span class="pill ${desktopClass}">Desktop ${current.desktopStatus}</span>
      <span class="pill ${projectClass}">Project ${current.projectStatus}</span>
      <span class="pill ${docClass}">${documentLabel}</span>
    </section>
    ${current.error ? `<div class="notice bad">${escapeHtml(current.error)}</div>` : ''}
  `;
}

function renderProjectAction(current: ExtensionState): string {
  if (current.projectStatus !== 'notLinked' || !current.parsedDocument) return '';

  return `
    <section class="notice">
      <div>
        <strong>New Overleaf project</strong>
        <p>Create a local lale project before verification history can be tracked.</p>
      </div>
      <button data-action="create-project">Create</button>
    </section>
  `;
}

function renderIssues(issues: DocumentIssue[]): string {
  const visible = issues.filter((issue) => issue.severity !== 'info').slice(0, 6);
  if (visible.length === 0) {
    return `<section class="panel compact"><div class="panel-title">Document Issues</div><p class="muted">No blocking structure issues detected.</p></section>`;
  }

  return `
    <section class="panel">
      <div class="panel-title">Document Issues</div>
      <ul class="issue-list">
        ${visible.map((issue) => `<li class="${issue.severity}">${escapeHtml(issue.message)}</li>`).join('')}
      </ul>
    </section>
  `;
}

function renderGraph(document: ParsedDocument | null): string {
  if (!document || document.claims.length === 0) {
    return `<section class="panel compact"><div class="panel-title">Dependency Graph</div><p class="muted">No document items detected.</p></section>`;
  }

  const nodes = document.claims.slice(0, 12);
  const nodeMetrics = new Map(
    nodes.map((claim) => [
      claim.id,
      {
        label: shortLabel(claim),
        width: graphNodeWidth(shortLabel(claim)),
      },
    ]),
  );
  const maxLeftWidth = Math.max(
    124,
    ...nodes.filter((_, index) => index % 2 === 0).map((claim) => nodeMetrics.get(claim.id)?.width ?? 124),
  );
  const rowHeight = 44;
  const height = Math.max(96, nodes.length * rowHeight + 20);
  const positions = new Map(
    nodes.map((claim, index) => {
      const metrics = nodeMetrics.get(claim.id) ?? { label: shortLabel(claim), width: 124 };
      return [
        claim.id,
        {
          x: index % 2 === 0 ? 24 : 24 + maxLeftWidth + 58,
          y: 24 + index * rowHeight,
          width: metrics.width,
          label: metrics.label,
        },
      ];
    }),
  );
  const width = Math.max(360, ...[...positions.values()].map((position) => position.x + position.width + 24));
  const edges = document.edges.filter((edge) => positions.has(edge.from) && positions.has(edge.to));

  return `
    <section class="panel">
      <div class="panel-title">Dependency Graph</div>
      <svg class="graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="Dependency graph">
        ${edges
          .map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return '';
            return `<line x1="${from.x + from.width}" y1="${from.y}" x2="${to.x}" y2="${to.y}" />`;
          })
          .join('')}
        ${nodes
          .map((claim) => {
            const point = positions.get(claim.id);
            if (!point) return '';
            return `
              <g class="graph-node" data-claim-id="${escapeHtml(claim.id)}" transform="translate(${point.x}, ${point.y - 15})">
                <rect width="${point.width}" height="30" rx="6"></rect>
                <text x="10" y="19">${escapeHtml(point.label)}</text>
              </g>
            `;
          })
          .join('')}
      </svg>
    </section>
  `;
}

function renderClaimList(current: ExtensionState): string {
  const claims = current.parsedDocument?.claims ?? [];
  if (claims.length === 0) {
    return `<section class="panel compact"><div class="panel-title">Claims & References</div><p class="muted">Open an Overleaf source document with theorem-like environments.</p></section>`;
  }

  return `
    <section class="panel">
      <div class="panel-title">Claims & References</div>
      <div class="claim-list">
        ${claims
          .map((claim) => {
            const verifiable = isVerifiableClaim(claim);
            const runtime = current.claimStates.find((item) => item.claimId === claim.id);
            const proofMeta = verifiable ? (claim.proof ? 'proof' : 'no proof') : 'no proof required';
            const statusMeta = formatDocumentItemStatus(claim, runtime?.status ?? 'pending');
            return `
              <button class="claim-row" data-action="select-claim" data-claim-id="${escapeHtml(claim.id)}">
                <span class="claim-kind">${escapeHtml(claim.kind)}</span>
                <span class="claim-main">
                  <strong>${escapeHtml(shortLabel(claim))}</strong>
                  <small>${renderLatexInline(claim.statement || 'No statement text')}</small>
                </span>
                <span class="claim-meta">${claim.dependencies.length} deps · ${proofMeta} · ${statusMeta}</span>
              </button>
            `;
          })
          .join('')}
      </div>
    </section>
  `;
}

function renderClaimDetail(claim: ParsedClaim, current: ExtensionState): string {
  const downstream = claim.dependents;
  const verifiable = isVerifiableClaim(claim);
  const runtime = current.claimStates.find((item) => item.claimId === claim.id);
  const status = formatDocumentItemStatus(claim, runtime?.status ?? 'pending');
  const stage = formatRuntimeStage(claim, runtime);
  const isActiveRun =
    current.activeRunId != null && current.latestAcceptedRun?.claimId === claim.id;
  const isInformalPaused =
    current.informalAudit?.claimId === claim.id && current.informalAudit.paused;
  const showLatestRun =
    current.latestAcceptedRun?.claimId === claim.id && current.latestRunEvents.length > 0;
  const primaryPanelTitle = claim.kind === 'definition' ? 'Definition' : 'Statement';
  const actionLabel = verifiable ? 'Verify' : 'Formalize';

  return `
    <section class="detail">
      <button class="text-button" data-action="back">← Back</button>
      <div class="detail-head">
        <div>
          <span class="claim-kind">${escapeHtml(claim.kind)}</span>
          <h2>${escapeHtml(shortLabel(claim))}</h2>
          <p class="muted">Line ${claim.startLine} · ${status} · ${stage}</p>
        </div>
        <button data-action="jump-source" data-claim-id="${escapeHtml(claim.id)}">Source</button>
      </div>
      <section class="panel">
        <div class="panel-title">${primaryPanelTitle}</div>
        <div class="latex-block">${renderLatexProse(claim.statement)}</div>
      </section>
      ${
        verifiable
          ? `<section class="panel">
              <div class="panel-title">Proof</div>
              <div class="latex-block">${renderLatexProse(claim.proof?.text ?? 'No adjacent proof block detected.')}</div>
            </section>`
          : `<section class="panel compact">
              <div class="panel-title">Formalization</div>
              <p class="muted">${escapeHtml(capitalize(claim.kind))} entries need faithful Lean declarations for downstream verification; no proof block is expected.</p>
            </section>`
      }
      ${renderUpstreamVerificationPlan(claim, current)}
      <section class="panel compact">
        <div class="panel-title">Downstream</div>
        ${renderLabelList(downstream)}
      </section>
      <div class="actions">
        <button data-action="verify-claim" data-claim-id="${escapeHtml(claim.id)}">${actionLabel}</button>
      </div>
      ${verifiable ? renderInformalAuditPanel(current.informalAudit, claim.id) : ''}
      ${
        showLatestRun
          ? `<section class="panel"><div class="panel-title">${renderRunPanelTitle(isActiveRun, isInformalPaused, verifiable)}</div><pre>${escapeHtml(current.latestRunEvents.map(formatRunEventLine).join('\n'))}</pre></section>`
          : ''
      }
    </section>
  `;
}

type UpstreamPlanItem =
  | {
      type: 'claim';
      claim: ParsedClaim;
      viaLabel: string;
      direct: boolean;
    }
  | {
      type: 'unresolved';
      label: string;
      direct: boolean;
    };

function renderUpstreamVerificationPlan(claim: ParsedClaim, current: ExtensionState): string {
  const plan = buildUpstreamPlan(claim, current.parsedDocument);

  if (plan.length === 0) {
    return `
      <section class="panel compact">
        <div class="panel-title">Required upstream claims</div>
        <p class="muted">None</p>
      </section>
    `;
  }

  return `
    <section class="panel">
      <div class="panel-title">Required upstream claims</div>
      <div class="dependency-plan">
        ${plan.map((item, index) => renderUpstreamPlanRow(item, index, current)).join('')}
      </div>
    </section>
  `;
}

function buildUpstreamPlan(
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
      const item: Extract<UpstreamPlanItem, { type: 'unresolved' }> = { type: 'unresolved', label, direct };
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

function renderUpstreamPlanRow(
  item: UpstreamPlanItem,
  index: number,
  current: ExtensionState,
): string {
  const order = String(index + 1).padStart(2, '0');

  if (item.type === 'unresolved') {
    return `
      <div class="dependency-row unresolved">
        <span class="dependency-order">${order}</span>
        <span class="dependency-main">
          <strong>${escapeHtml(item.label)}</strong>
          <small>${item.direct ? 'direct' : 'transitive'} reference · unresolved</small>
        </span>
        <span class="dependency-state">
          <span class="pill bad">missing</span>
          <small>parser could not resolve label</small>
        </span>
      </div>
    `;
  }

  const runtime = current.claimStates.find((claimState) => claimState.claimId === item.claim.id);
  const status = runtime?.status ?? 'pending';
  const action = isVerifiableClaim(item.claim) ? 'verify' : 'formalize';
  const statusLabel = formatDocumentItemStatus(item.claim, status);
  const stage = formatRuntimeStage(item.claim, runtime);

  return `
    <button class="dependency-row" data-action="select-claim" data-claim-id="${escapeHtml(item.claim.id)}">
      <span class="dependency-order">${order}</span>
      <span class="dependency-main">
        <strong>${escapeHtml(shortLabel(item.claim))}</strong>
        <small>${item.direct ? 'direct' : 'transitive'} dependency · ${action} · line ${item.claim.startLine}</small>
      </span>
      <span class="dependency-state">
        <span class="pill ${statusPillClass(status)}">${escapeHtml(statusLabel)}</span>
        <small>${escapeHtml(stage)}</small>
      </span>
    </button>
  `;
}

function formatRuntimeStage(claim: ParsedClaim, runtime: ClaimRuntimeState | undefined): string {
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

function formatRunPhase(phase: NonNullable<ClaimRuntimeState['phase']>): string {
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
    case 'proverAttempt':
      return 'proving';
    case 'finalGate':
      return 'running final gate';
    case 'complete':
      return 'complete';
  }
}

function statusPillClass(status: string): 'ok' | 'warn' | 'bad' {
  if (status === 'formalized' || status === 'verified' || status === 'verifiedByOverride') return 'ok';
  if (status === 'failed' || status === 'timedOut' || status === 'blocked') return 'bad';
  return 'warn';
}

function renderRunPanelTitle(
  isActiveRun: boolean,
  isInformalPaused: boolean,
  verifiable: boolean,
): string {
  if (isInformalPaused) return 'Verification paused';
  if (isActiveRun) return `${verifiable ? 'Verification' : 'Formalization'} in progress`;
  return `Latest ${verifiable ? 'verification' : 'formalization'} run`;
}

function formatRunEventLine(event: ExtensionState['latestRunEvents'][number]): string {
  const payload = (event.payload ?? null) as Record<string, unknown> | null;
  const rawDiagnostics = payload?.['diagnostics'];
  const diagnostics = Array.isArray(rawDiagnostics)
    ? rawDiagnostics.filter((item): item is string => typeof item === 'string')
    : [];
  const firstDiagnostic = diagnostics[0];
  const detail = firstDiagnostic ? ` — ${firstDiagnostic}` : '';
  return `[${event.phase}] ${event.level}: ${event.message}${detail}`;
}

function renderInformalAuditPanel(audit: InformalAuditState | null, claimId: string): string {
  if (!audit || audit.claimId !== claimId) return '';

  if (audit.status === 'pending') {
    return `
      <section class="panel compact">
        <div class="panel-title">Informal advisory</div>
        <p class="muted">Running heuristic audit…</p>
      </section>
    `;
  }

  if (audit.status === 'failed') {
    return `
      <section class="panel compact">
        <div class="panel-title">Informal advisory</div>
        <p class="muted">Advisory check failed (non-blocking). ${escapeHtml(audit.message ?? '')}</p>
      </section>
    `;
  }

  if (audit.status === 'noObviousIssue') {
    return `
      <section class="panel compact">
        <div class="panel-title">Informal advisory</div>
        <div class="advisory-row">
          <span class="pill ok">No obvious issue</span>
          ${audit.confidence ? `<span class="muted">${escapeHtml(audit.confidence)} confidence</span>` : ''}
        </div>
      </section>
    `;
  }

  // status === 'warning' | 'paused'
  const verdictLabel = formatVerdict(audit.verdict);
  const confidence = audit.confidence ?? 'low';
  const confidenceClass = confidence === 'high' ? 'bad' : confidence === 'medium' ? 'warn' : 'warn';
  const isPaused = audit.status === 'paused' || audit.paused;

  return `
    <section class="panel">
      <div class="panel-title">Informal advisory</div>
      <div class="advisory-row">
        <span class="pill ${confidenceClass}">${escapeHtml(verdictLabel)}</span>
        <span class="muted">${escapeHtml(confidence)} confidence</span>
      </div>
      ${
        audit.findings.length > 0
          ? `<ul class="issue-list">${audit.findings
              .map((finding) => `<li class="warning">${escapeHtml(finding)}</li>`)
              .join('')}</ul>`
          : '<p class="muted">No specific findings reported.</p>'
      }
      <p class="muted advisory-note">
        ${
          isPaused
            ? 'Formal verification is paused until acknowledgement is recorded.'
            : 'Formal verification continues while this advisory is available.'
        }
      </p>
      ${renderOverrideArea(audit, isPaused)}
    </section>
  `;
}

function renderOverrideArea(audit: InformalAuditState, isPaused: boolean): string {
  if (audit.overridden) {
    return `
      <div class="advisory-override done">
        <strong>Acknowledged</strong>
        ${audit.overrideReason ? `<p>${escapeHtml(audit.overrideReason)}</p>` : ''}
        ${audit.overriddenAt ? `<small class="muted">${escapeHtml(audit.overriddenAt)}</small>` : ''}
      </div>
    `;
  }

  if (!overrideFormOpen) {
    return `
      <div class="actions">
        <button data-action="open-override" data-run-id="${escapeHtml(audit.runId)}">
          ${isPaused ? 'Acknowledge advisory and proceed…' : 'Acknowledge advisory…'}
        </button>
      </div>
    `;
  }

  return `
    <div class="advisory-override">
      <label for="override-reason">${isPaused ? 'Reason for proceeding' : 'Reason for acknowledgement'}</label>
      <textarea
        id="override-reason"
        data-action="override-input"
        rows="3"
        placeholder="e.g. The heuristic misread a non-standard notation; the proof is unaffected."
      >${escapeHtml(overrideReasonDraft)}</textarea>
      <div class="actions">
        <button data-action="cancel-override">Cancel</button>
        <button
          data-action="submit-override"
          data-run-id="${escapeHtml(audit.runId)}"
          ${overrideReasonDraft.trim() ? '' : 'disabled'}
        >${isPaused ? 'Acknowledge and proceed' : 'Record acknowledgement'}</button>
      </div>
    </div>
  `;
}

function formatVerdict(verdict: InformalAuditState['verdict']): string {
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

function bindActions(): void {
  root.querySelectorAll<HTMLElement>('[data-action]').forEach((element) => {
    const action = element.dataset.action;
    if (action === 'override-input') {
      element.addEventListener('input', () => {
        overrideReasonDraft = (element as HTMLTextAreaElement).value;
        // Toggle the submit button enabled state without a full re-render so the
        // textarea keeps focus and caret position.
        const submit = root.querySelector<HTMLButtonElement>('[data-action="submit-override"]');
        if (submit) submit.disabled = overrideReasonDraft.trim().length === 0;
      });
      return;
    }
    if (action === 'connect-input') {
      element.addEventListener('input', () => {
        connectTokenDraft = (element as HTMLTextAreaElement).value;
        const submit = root.querySelector<HTMLButtonElement>('[data-action="connect-save"]');
        if (submit) submit.disabled = connectTokenDraft.trim().length === 0;
      });
      return;
    }
    if (action === 'switch-formalizer') {
      element.addEventListener('change', () => {
        const configId = element.dataset.configId;
        const optionKey = element.dataset.optionKey as 'novita' | 'featherless' | undefined;
        if (!configId || !optionKey) return;
        void sendMessage({ type: 'sidepanel.switchFormalizer', configId, optionKey }).then(loadState);
      });
      return;
    }
    if (action === 'key-input') {
      const provider = element.dataset.provider;
      if (!provider) return;
      element.addEventListener('input', () => {
        keyDrafts[provider] = (element as HTMLInputElement).value;
        const saveBtn = root.querySelector<HTMLButtonElement>(
          `[data-action="save-named-key"][data-provider="${provider}"]`,
        );
        if (saveBtn) saveBtn.disabled = !keyDrafts[provider]?.trim();
      });
      return;
    }

    element.addEventListener('click', () => {
      const claimId = element.dataset.claimId;
      const runId = element.dataset.runId;

      if (action === 'refresh') void loadState();
      if (action === 'create-project') void sendMessage({ type: 'sidepanel.createProject' }).then(loadState);
      if (action === 'select-claim' && claimId) {
        selectedClaimId = claimId;
        resetOverrideForm();
        render();
      }
      if (action === 'back') {
        selectedClaimId = null;
        resetOverrideForm();
        render();
      }
      if (action === 'verify-claim' && claimId) {
        resetOverrideForm();
        void sendMessage({ type: 'sidepanel.verifyClaim', claimId }).then(loadState);
      }
      if (action === 'jump-source' && claimId) {
        void sendMessage({ type: 'sidepanel.jumpToSource', claimId });
      }
      if (action === 'open-override') {
        overrideFormOpen = true;
        render();
        const textarea = root.querySelector<HTMLTextAreaElement>('#override-reason');
        textarea?.focus();
      }
      if (action === 'cancel-override') {
        resetOverrideForm();
        render();
      }
      if (action === 'submit-override' && runId) {
        const reason = overrideReasonDraft.trim();
        if (!reason) return;
        void sendMessage({ type: 'sidepanel.acknowledgeInformalAudit', runId, reason }).then(
          (result) => {
            if (result?.ok) resetOverrideForm();
            return loadState();
          },
        );
      }
      if (action === 'open-settings') {
        view = 'settings';
        render();
      }
      if (action === 'close-settings') {
        view = 'main';
        keyDrafts = {};
        render();
      }
      if (action === 'connect-save') {
        const token = connectTokenDraft.trim();
        if (!token) return;
        void sendMessage({ type: 'sidepanel.setBearerToken', token }).then((result) => {
          if (result?.ok) {
            connectTokenDraft = '';
          }
          return loadState();
        });
      }
      if (action === 'clear-token') {
        void sendMessage({ type: 'sidepanel.clearBearerToken' }).then(loadState);
      }
      if (action === 'save-named-key') {
        const provider = element.dataset.provider;
        if (!provider) return;
        const key = keyDrafts[provider]?.trim() ?? '';
        if (!key) return;
        void sendMessage({ type: 'sidepanel.setNamedKey', provider, key }).then((result) => {
          if (result?.ok) delete keyDrafts[provider];
          return loadState();
        });
      }
      if (action === 'clear-named-key') {
        const provider = element.dataset.provider;
        if (!provider) return;
        void sendMessage({ type: 'sidepanel.clearNamedKey', provider }).then(loadState);
      }
      if (action === 'start-provision') {
        // Always force on a user-initiated click: a half-built `.lake/` from a
        // prior failed attempt makes the desktop see the project as "ready"
        // and short-circuit without a force flag.
        void sendMessage({ type: 'sidepanel.startProvision', force: true }).then(loadState);
      }
    });
  });

  root.querySelectorAll<SVGGElement>('.graph-node').forEach((node) => {
    node.addEventListener('click', () => {
      const claimId = node.dataset.claimId;
      if (!claimId) return;
      selectedClaimId = claimId;
      resetOverrideForm();
      render();
    });
  });
}

function resetOverrideForm(): void {
  overrideFormOpen = false;
  overrideReasonDraft = '';
}

function selectedClaim(document: ParsedDocument | null, claimId: string | null): ParsedClaim | null {
  if (!document || !claimId) return null;
  return document.claims.find((claim) => claim.id === claimId) ?? null;
}

function renderLabelList(labels: string[]): string {
  if (labels.length === 0) return `<p class="muted">None</p>`;
  return `<ul class="label-list">${labels.map((label) => `<li>${escapeHtml(label)}</li>`).join('')}</ul>`;
}

function projectSubtitle(current: ExtensionState): string {
  return current.desktopProject?.name ?? current.projectContext?.projectId ?? 'Overleaf project not detected';
}

function shortLabel(claim: ParsedClaim): string {
  return claim.label ?? `${claim.kind} ${claim.startLine}`;
}

function isVerifiableClaim(claim: ParsedClaim): boolean {
  return isVerifiableClaimKind(claim.kind);
}

function formatDocumentItemStatus(claim: ParsedClaim, status: string): string {
  if (isVerifiableClaim(claim)) {
    if (status === 'verifiedByOverride') return 'override verified';
    if (status === 'checking') return 'checking';
    if (status === 'timedOut') return 'timed out';
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

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function graphNodeWidth(label: string): number {
  return clamp(label.length * 7.2 + 24, 124, 280);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function sendMessage(message: Record<string, unknown>): Promise<{ ok: boolean; response?: unknown; error?: string }> {
  return chrome.runtime.sendMessage(message);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#039;';
      default:
        return char;
    }
  });
}

function renderLatexInline(source: string): string {
  return renderLatexProse(source, { compact: true });
}

function renderLatexProse(source: string, options: { compact?: boolean } = {}): string {
  const normalized = source.replace(/\s+/g, ' ').trim();
  const rendered = renderDelimitedMath(normalized);
  const withTextMacros = renderTextMacros(rendered);
  return options.compact ? withTextMacros : withTextMacros.replace(/\n/g, '<br>');
}

function renderDelimitedMath(source: string): string {
  const parts: string[] = [];
  let rest = source;

  while (rest.length > 0) {
    const match = rest.match(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\$([^$]+)\$/);
    if (!match || match.index == null) {
      parts.push(escapeHtml(rest));
      break;
    }

    parts.push(escapeHtml(rest.slice(0, match.index)));
    const math = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
    const displayMode = match[0].startsWith('\\[') || match[0].startsWith('$$');
    parts.push(renderMath(math, displayMode));
    rest = rest.slice(match.index + match[0].length);
  }

  return parts.join('');
}

function renderTextMacros(source: string): string {
  return source
    .replace(/\\emph\{([^{}]+)\}/g, '<em>$1</em>')
    .replace(/\\textbf\{([^{}]+)\}/g, '<strong>$1</strong>')
    .replace(/\\textit\{([^{}]+)\}/g, '<em>$1</em>')
    .replace(/\\ref\{([^{}]+)\}/g, '<code>$1</code>')
    .replace(/\\cref\{([^{}]+)\}/g, '<code>$1</code>')
    .replace(/\\Cref\{([^{}]+)\}/g, '<code>$1</code>')
    .replace(/\\autoref\{([^{}]+)\}/g, '<code>$1</code>')
    .replace(/\\eqref\{([^{}]+)\}/g, '<code>($1)</code>');
}

function renderMath(source: string, displayMode: boolean): string {
  return katex.renderToString(source, {
    displayMode,
    throwOnError: false,
    strict: false,
    trust: false,
  });
}

function installStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    :root {
      color: #1f2328;
      background: #fafaf8;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
    }

    * { box-sizing: border-box; }
    body { margin: 0; background: #fafaf8; }
    button {
      border: 1px solid #c9d1d9;
      background: #ffffff;
      border-radius: 6px;
      color: #1f2328;
      cursor: pointer;
      font: inherit;
      min-height: 30px;
      padding: 5px 9px;
    }
    button:hover { border-color: #87909a; background: #f6f8fa; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 17px; font-weight: 700; }
    h2 { font-size: 16px; margin-top: 4px; }
    pre {
      margin: 0;
      overflow-x: auto;
      white-space: pre-wrap;
      font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 11px;
      line-height: 1.45;
    }
    code {
      background: #f3f4f6;
      border: 1px solid #d8dee4;
      border-radius: 4px;
      font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 0.92em;
      padding: 0 3px;
    }

    #app { min-height: 100vh; padding: 12px; }
    .topbar {
      align-items: center;
      display: flex;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .topbar p, .muted { color: #6a737d; font-size: 12px; line-height: 1.35; }
    .icon-button {
      align-items: center;
      display: inline-flex;
      justify-content: center;
      line-height: 1;
      min-height: 34px;
      padding: 0;
      width: 34px;
    }
    .icon-glyph {
      align-items: center;
      display: inline-flex;
      font-size: 18px;
      font-weight: 700;
      height: 20px;
      justify-content: center;
      line-height: 1;
      width: 20px;
    }
    .refresh-glyph {
      font-size: 18px;
    }
    .status-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 10px;
    }
    .pill {
      border: 1px solid #d8dee4;
      border-radius: 999px;
      font-size: 11px;
      padding: 3px 7px;
    }
    .pill.ok { border-color: #9cc9b2; color: #1f7a5c; background: #eef8f3; }
    .pill.warn { border-color: #d9b650; color: #7a5b00; background: #fff8d8; }
    .pill.bad { border-color: #dfa5a0; color: #9a2d20; background: #fff1ef; }
    .notice {
      align-items: center;
      background: #fff;
      border: 1px solid #d8dee4;
      border-radius: 8px;
      display: flex;
      gap: 10px;
      justify-content: space-between;
      margin-bottom: 10px;
      padding: 10px;
    }
    .notice.bad { border-color: #dfa5a0; color: #9a2d20; display: block; }
    .panel {
      background: #ffffff;
      border: 1px solid #d8dee4;
      border-radius: 8px;
      margin-bottom: 10px;
      padding: 10px;
    }
    .panel.compact { padding: 9px 10px; }
    .panel-title {
      color: #4d5560;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0;
      margin-bottom: 8px;
      text-transform: uppercase;
    }
    .issue-list, .label-list { margin: 0; padding-left: 18px; }
    .issue-list li { margin: 5px 0; }
    .issue-list .error { color: #9a2d20; }
    .issue-list .warning { color: #7a5b00; }
    .graph {
      display: block;
      height: 220px;
      max-width: 100%;
      overflow: visible;
      width: 100%;
    }
    .graph line { stroke: #9aa4af; stroke-width: 1.25; }
    .graph-node { cursor: pointer; }
    .graph-node rect { fill: #f6f8fa; stroke: #c9d1d9; }
    .graph-node text { fill: #1f2328; font-size: 11px; }
    .latex-block {
      color: #24292f;
      font-size: 14px;
      line-height: 1.58;
      overflow-wrap: anywhere;
    }
    .latex-block .katex-display {
      margin: 8px 0;
      overflow-x: auto;
      overflow-y: hidden;
    }
    .claim-main small .katex {
      font-size: 1em;
    }
    .claim-list { display: grid; gap: 6px; }
    .claim-row {
      align-items: center;
      display: grid;
      gap: 8px;
      grid-template-columns: 74px minmax(0, 1fr);
      min-height: 58px;
      text-align: left;
      width: 100%;
    }
    .claim-kind {
      background: #eef2f5;
      border-radius: 6px;
      color: #4d5560;
      display: inline-block;
      font-size: 11px;
      padding: 3px 6px;
      text-transform: capitalize;
    }
    .claim-main { min-width: 0; }
    .claim-main strong, .claim-main small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .claim-main small, .claim-meta { color: #6a737d; font-size: 11px; margin-top: 3px; }
    .claim-meta { grid-column: 2; }
    .dependency-plan {
      display: grid;
      gap: 6px;
    }
    .dependency-row {
      align-items: center;
      background: #fbfcfd;
      border: 1px solid #d8dee4;
      border-radius: 6px;
      display: grid;
      gap: 4px 8px;
      grid-template-columns: 30px minmax(0, 1fr);
      min-height: 58px;
      padding: 8px;
      text-align: left;
      width: 100%;
    }
    button.dependency-row:hover {
      background: #f6f8fa;
      border-color: #bfc8d2;
    }
    .dependency-row.unresolved {
      background: #fffafa;
      border-color: #efd0cd;
    }
    .dependency-order {
      color: #8c96a1;
      font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 11px;
      grid-row: span 2;
      line-height: 1;
    }
    .dependency-main {
      min-width: 0;
    }
    .dependency-main strong,
    .dependency-main small {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dependency-main small,
    .dependency-state small {
      color: #6a737d;
      font-size: 11px;
      line-height: 1.3;
    }
    .dependency-state {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 5px 7px;
      grid-column: 2;
      min-width: 0;
    }
    .detail { display: grid; gap: 10px; }
    .detail-head {
      align-items: start;
      display: flex;
      justify-content: space-between;
    }
    .text-button {
      border: 0;
      background: transparent;
      padding-left: 0;
      width: fit-content;
    }
    .two-col {
      display: grid;
      gap: 12px;
      grid-template-columns: 1fr 1fr;
    }
    .actions { display: flex; gap: 6px; justify-content: flex-end; }
    .advisory-row {
      align-items: center;
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
    }
    .advisory-note {
      color: #6a737d;
      font-size: 11px;
      margin: 6px 0 8px 0;
    }
    .advisory-override {
      border-top: 1px solid #e5e8ec;
      display: grid;
      gap: 6px;
      margin-top: 8px;
      padding-top: 8px;
    }
    .advisory-override label {
      color: #4d5560;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .advisory-override textarea {
      border: 1px solid #c9d1d9;
      border-radius: 6px;
      font: inherit;
      padding: 6px 8px;
      resize: vertical;
    }
    .advisory-override.done strong {
      color: #1f7a5c;
      display: block;
      font-size: 12px;
      margin-bottom: 2px;
    }
    .advisory-override.done p {
      color: #1f2328;
      font-size: 12px;
      margin: 0 0 2px 0;
    }
    button:disabled {
      color: #9aa4af;
      cursor: not-allowed;
      opacity: 0.6;
    }
    .topbar-actions { display: flex; gap: 6px; }
    .panel textarea {
      border: 1px solid #c9d1d9;
      border-radius: 6px;
      font: inherit;
      padding: 6px 8px;
      resize: vertical;
      width: 100%;
    }
    .panel textarea.token-input {
      background: #fbfcfd;
      border-color: #bfc8d2;
      box-shadow: inset 0 1px 2px rgba(31, 35, 40, 0.04);
      color: #1f2328;
      font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
      min-height: 74px;
      padding: 10px 11px;
      resize: none;
    }
    .panel textarea.token-input::placeholder {
      color: #8c96a1;
    }
    .panel textarea.token-input:focus {
      background: #ffffff;
      border-color: #5b8def;
      box-shadow:
        0 0 0 3px rgba(91, 141, 239, 0.16),
        inset 0 1px 2px rgba(31, 35, 40, 0.04);
      outline: none;
    }
    .field-label {
      color: #4d5560;
      display: block;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      margin: 6px 0 4px 0;
      text-transform: uppercase;
    }
    .snippet code {
      font-size: 11px;
    }
    .connect-status {
      align-items: center;
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    .error-text { color: #9a2d20; }
    .panel-title.sub {
      margin-top: 10px;
    }
    .key-section-head {
      color: #4d5560;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.03em;
      margin-bottom: 2px;
      text-transform: uppercase;
    }
    .radio-group {
      display: grid;
      gap: 6px;
      margin-bottom: 4px;
    }
    .radio-option {
      border: 1px solid #d8dee4;
      border-radius: 8px;
      padding: 8px 10px;
    }
    .radio-option.active {
      background: #f6fdf9;
      border-color: #9cc9b2;
    }
    .radio-label {
      align-items: flex-start;
      cursor: pointer;
      display: flex;
      gap: 8px;
      margin-bottom: 6px;
    }
    .radio-label input[type="radio"] {
      accent-color: #16a05d;
      flex-shrink: 0;
      margin-top: 3px;
    }
    .radio-text {
      flex: 1;
      min-width: 0;
    }
    .radio-text strong,
    .radio-text small {
      display: block;
    }
    .key-row {
      border-top: 1px solid #e5e8ec;
      margin-top: 12px;
      padding-top: 10px;
    }
    .key-row-head {
      align-items: flex-start;
      display: flex;
      gap: 8px;
      justify-content: space-between;
      margin-bottom: 6px;
    }
    .key-input-row {
      display: flex;
      gap: 6px;
    }
    .key-input {
      border: 1px solid #c9d1d9;
      border-radius: 6px;
      flex: 1;
      font: inherit;
      min-height: 30px;
      min-width: 0;
      padding: 5px 8px;
    }
    .key-input:focus {
      border-color: #5b8def;
      box-shadow: 0 0 0 3px rgba(91, 141, 239, 0.16);
      outline: none;
    }
    pre.provision-log {
      background: #f6f8fa;
      border: 1px solid #e5e8ec;
      border-radius: 6px;
      max-height: 220px;
      overflow: auto;
      padding: 8px;
    }
  `;
  document.head.appendChild(style);
}

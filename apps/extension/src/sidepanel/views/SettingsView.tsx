import { useState } from 'react';
import { Button, IconButton, Input, Panel, Section, Status } from '@lale/ui';
import type { ExtensionState } from '../../shared/messages';
import { TopBar } from '../components/TopBar';

/**
 * Reasoning effort comes from the desktop config rather than being assumed —
 * the two roles deliberately run at different levels, and reasoning tokens bill
 * as output, so showing a level the backend is not using is a costly lie.
 */
function formatEffort(effort: string | null): string {
  if (!effort) return 'provider default effort';
  return `${effort.charAt(0).toUpperCase()}${effort.slice(1)} effort`;
}

function RoleRow({
  role,
  modelId,
  reasoningEffort,
  description,
}: {
  role: string;
  modelId: string;
  reasoningEffort: string | null;
  description: string;
}) {
  return (
    <div className="role-row">
      <span className="lale-label">{role}</span>
      <p className="lale-muted">
        <span className="lale-mono">{modelId}</span> · {formatEffort(reasoningEffort)}
      </p>
      <p className="lale-muted">{description}</p>
    </div>
  );
}

function ProviderKeys({
  state,
  onSaveKey,
  onClearKey,
}: {
  state: ExtensionState;
  onSaveKey: (key: string) => void;
  onClearKey: () => void;
}) {
  const [key, setKey] = useState('');
  const { formalizerConfig, proposerConfig, auxiliaryConfig, hasOpenRouterKey } = state;
  if (!formalizerConfig && !proposerConfig && !auxiliaryConfig) return null;

  return (
    <Section
      label="OpenRouter API key"
      action={<Status tone={hasOpenRouterKey ? 'ok' : 'warn'}>{hasOpenRouterKey ? 'Key set' : 'No key'}</Status>}
    >
      <p className="lale-muted advisory-note">
        Bring your own key. Model requests go to OpenRouter; review their data retention policy
        before use.
      </p>
      <div className="key-input-row">
        <Input
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder={hasOpenRouterKey ? 'Replace existing key' : 'Paste API key'}
          autoComplete="new-password"
          spellCheck={false}
          aria-label="OpenRouter API key"
        />
        <Button
          variant="primary"
          disabled={key.trim().length === 0}
          onClick={() => {
            onSaveKey(key.trim());
            setKey('');
          }}
        >
          Save
        </Button>
        {hasOpenRouterKey && (
          <Button variant="quiet" onClick={onClearKey}>
            Clear
          </Button>
        )}
      </div>
      {formalizerConfig && (
        <RoleRow
          role="Formalizer"
          modelId={formalizerConfig.modelId}
          reasoningEffort={formalizerConfig.reasoningEffort}
          description="Statements, and the steps of a proof."
        />
      )}
      {proposerConfig && (
        <RoleRow
          role="Proposer"
          modelId={proposerConfig.modelId}
          reasoningEffort={proposerConfig.reasoningEffort}
          description="Proposes proofs for Lean to check — deepest reasoning, most of the spend."
        />
      )}
      {auxiliaryConfig && (
        <RoleRow
          role="Auxiliary"
          modelId={auxiliaryConfig.modelId}
          reasoningEffort={auxiliaryConfig.reasoningEffort}
          description="Advisory and faithfulness checks."
        />
      )}
    </Section>
  );
}

function Provisioning({
  state,
  onStartProvision,
}: {
  state: ExtensionState;
  onStartProvision: () => void;
}) {
  const provision = state.provision;
  const status = provision?.status ?? 'idle';
  const ready = provision?.projectReady ?? false;
  const leanVersion = provision?.leanVersion ?? state.desktopHealth?.lean.version ?? '—';
  const mathlibRevision = provision?.mathlibRevision ?? '—';

  // Status from the last run dominates over the file-existence `ready` flag: a
  // half-built `.lake/` from a failed run satisfies `ready` but the toolchain is
  // not usable. Priority: running > failed > ready > idle.
  const tone =
    status === 'running' ? 'warn' : status === 'failed' ? 'bad' : ready || status === 'ready' ? 'ok' : 'warn';
  const statusLabel =
    status === 'running'
      ? 'Installing'
      : status === 'failed'
        ? 'Failed'
        : ready || status === 'ready'
          ? 'Ready'
          : 'Not installed';

  const helperText =
    status === 'running'
      ? 'Installing the local verification tools and proof library. The first setup can take several minutes.'
      : status === 'failed'
        ? 'The previous provisioning attempt failed. Reprovisioning will overwrite the partial install.'
        : ready
          ? 'Toolchain installed locally. Verification can run.'
          : 'Lean is not provisioned. Verification needs a local Lean toolchain plus Mathlib.';

  const events = state.provisionEvents.slice(-20);

  return (
    <Section
      label="Lean + Mathlib"
      action={
        <Status tone={tone} pulse={status === 'running'}>
          {statusLabel}
        </Status>
      }
    >
      <p className="lale-muted">
        Lean <span className="lale-mono">{leanVersion}</span> · Mathlib{' '}
        <span className="lale-mono">{mathlibRevision}</span>
      </p>
      {provision?.error && <p className="error-text">{provision.error}</p>}
      <p className="lale-muted advisory-note">{helperText}</p>
      {status !== 'running' && (
        <div className="actions">
          <Button onClick={onStartProvision}>
            {status === 'failed' || ready ? 'Reprovision' : 'Install Lean + Mathlib'}
          </Button>
        </div>
      )}
      {events.length > 0 && (
        <>
          <span className="lale-label provision-log-label">Recent activity</span>
          <Panel>
            <pre className="provision-log">
              {events.map((event) => `[${event.step}] ${event.message}`).join('\n')}
            </pre>
          </Panel>
        </>
      )}
    </Section>
  );
}

export function SettingsView({
  state,
  onClose,
  onClearToken,
  onSaveKey,
  onClearKey,
  onStartProvision,
}: {
  state: ExtensionState;
  onClose: () => void;
  onClearToken: () => void;
  onSaveKey: (key: string) => void;
  onClearKey: () => void;
  onStartProvision: () => void;
}) {
  return (
    <>
      <TopBar
        title="Settings"
        actions={
          <IconButton onClick={onClose} title="Done" aria-label="Close settings">
            ✕
          </IconButton>
        }
      />
      <Section
        label="Desktop connection"
        action={
          <Status tone={state.desktopAuthStatus === 'authorized' ? 'ok' : 'warn'}>
            {state.desktopAuthStatus === 'authorized' ? 'Authorized' : 'Unverified'}
          </Status>
        }
      >
        <p className="lale-muted">Token stored locally; never sent off-device.</p>
        <div className="actions">
          <Button variant="quiet" onClick={onClearToken}>
            Clear token
          </Button>
        </div>
      </Section>
      <ProviderKeys state={state} onSaveKey={onSaveKey} onClearKey={onClearKey} />
      <Provisioning state={state} onStartProvision={onStartProvision} />
    </>
  );
}

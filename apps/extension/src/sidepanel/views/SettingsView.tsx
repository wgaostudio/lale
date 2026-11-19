import { useState } from 'react';
import { Button, IconButton, Input, Panel, Section, Status } from '@lale/ui';
import type { ProverOptions } from '@lale/protocol';
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

const PROVER_MODELS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Configured proposer model' },
  { value: 'openai/gpt-6.2-astra', label: 'GPT-6.2 Astra' },
  { value: 'anthropic/claude-fable-5.2', label: 'Claude Fable 5.2' },
];

/**
 * Check proof steps runs an agent per step, billed to your key. The budget is
 * per step: a hard budget allows long research-level steps, and also refuses
 * to let the prover give up early, so it costs more on a step that is false.
 */
function ProverSettings({
  preferences,
  onChange,
}: {
  preferences: ProverOptions;
  onChange: (preferences: ProverOptions) => void;
}) {
  return (
    <Section label="Check proof steps">
      <label className="setting-row">
        <span className="lale-label">Prover model</span>
        <select
          className="lale-input"
          value={preferences.model ?? ''}
          onChange={(event) => {
            const model = event.target.value;
            onChange(model
              ? { ...preferences, model: model as NonNullable<ProverOptions['model']> }
              : { budget: preferences.budget });
          }}
        >
          {PROVER_MODELS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </label>
      <label className="setting-row">
        <span className="lale-label">Budget per step</span>
        <select
          className="lale-input"
          value={preferences.budget}
          onChange={(event) => onChange({ ...preferences, budget: event.target.value as ProverOptions['budget'] })}
        >
          <option value="standard">Standard — up to $2 a step</option>
          <option value="hard">Hard — up to $25 a step, at least $5 before giving up</option>
        </select>
      </label>
      <p className="lale-muted advisory-note">
        Each step of your proof is proved separately. A step the prover cannot prove is reported
        with what it found missing. Spending stops at the ceiling.
      </p>
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
  onSetProverPreferences,
}: {
  state: ExtensionState;
  onClose: () => void;
  onClearToken: () => void;
  onSaveKey: (key: string) => void;
  onClearKey: () => void;
  onStartProvision: () => void;
  onSetProverPreferences: (preferences: ProverOptions) => void;
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
      <ProverSettings preferences={state.proverPreferences} onChange={onSetProverPreferences} />
      <Provisioning state={state} onStartProvision={onStartProvision} />
    </>
  );
}

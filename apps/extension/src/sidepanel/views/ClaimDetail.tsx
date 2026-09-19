import type { ParsedClaim } from '@lale/document-parser';
import type { VerificationMode } from '@lale/protocol';
import { Button, Panel, Pill, Section, Status } from '@lale/ui';
import type { ExtensionState } from '../../shared/messages';
import { InformalAudit } from '../components/InformalAudit';
import { LatexBlock } from '../components/Latex';
import { TopBar } from '../components/TopBar';
import { UpstreamPlan } from '../components/UpstreamPlan';
import {
  capitalize,
  findRuntime,
  formatDocumentItemStatus,
  formatRunEventLine,
  formatRuntimeStage,
  isRunning,
  isVerifiableClaim,
  shortLabel,
  statusTone,
} from '../lib/status';

export function ClaimDetail({
  claim,
  state,
  onBack,
  onSelect,
  onVerify,
  onJumpToSource,
  onAcknowledge,
}: {
  claim: ParsedClaim;
  state: ExtensionState;
  onBack: () => void;
  onSelect: (claimId: string) => void;
  onVerify: (claimId: string, mode: VerificationMode) => void;
  onJumpToSource: (claimId: string) => void;
  onAcknowledge: (runId: string, reason: string) => void;
}) {
  const verifiable = isVerifiableClaim(claim);
  const runtime = findRuntime(state, claim.id);
  const status = runtime?.status ?? 'pending';

  const isActiveRun = state.activeRunId != null && state.latestAcceptedRun?.claimId === claim.id;
  const isInformalPaused =
    state.informalAudit?.claimId === claim.id && state.informalAudit.paused;
  const showLatestRun =
    state.latestAcceptedRun?.claimId === claim.id && state.latestRunEvents.length > 0;

  const runPanelTitle = isInformalPaused
    ? 'Verification paused'
    : isActiveRun
      ? `${verifiable ? 'Verification' : 'Formalization'} in progress`
      : `Latest ${verifiable ? 'verification' : 'formalization'} run`;

  return (
    <>
      <TopBar
        title={shortLabel(claim)}
        actions={
          <Button variant="quiet" onClick={onBack}>
            ← Back
          </Button>
        }
      />

      <div className="detail-meta">
        <Pill>{claim.kind}</Pill>
        <span className="lale-muted">line {claim.startLine}</span>
        <Status tone={statusTone(status)} pulse={isRunning(status)}>
          {formatDocumentItemStatus(claim, status)}
        </Status>
      </div>
      <p className="lale-muted detail-stage">{formatRuntimeStage(claim, runtime)}</p>

      <div className="actions detail-actions">
        <Button variant="quiet" onClick={() => onJumpToSource(claim.id)}>
          Source
        </Button>
        {verifiable ? (
          <>
            {/* Statement only: cheap, and enough to surface an ambiguous claim. */}
            <Button variant="quiet" onClick={() => onVerify(claim.id, 'formalizeOnly')}>
              Formalize only
            </Button>
            {/* The author's own argument, step by step — "Verify" checks that the
                theorem is true, which is not the same thing. */}
            {claim.proof ? (
              <Button variant="quiet" onClick={() => onVerify(claim.id, 'proofSkeleton')}>
                Check proof steps
              </Button>
            ) : null}
          </>
        ) : null}
        <Button variant="primary" onClick={() => onVerify(claim.id, verifiable ? 'full' : 'formalizeOnly')}>
          {verifiable ? 'Verify' : 'Formalize'}
        </Button>
      </div>

      <Section label={claim.kind === 'definition' ? 'Definition' : 'Statement'}>
        <LatexBlock source={claim.statement} />
      </Section>

      {verifiable ? (
        <Section label="Proof">
          <LatexBlock source={claim.proof?.text ?? 'No adjacent proof block detected.'} />
        </Section>
      ) : (
        <Section label="Formalization">
          <p className="lale-muted">
            {capitalize(claim.kind)} entries need faithful Lean declarations for downstream
            verification; no proof block is expected.
          </p>
        </Section>
      )}

      <Section label="Required upstream claims">
        <UpstreamPlan claim={claim} state={state} onSelect={onSelect} />
      </Section>

      <Section label="Downstream">
        {claim.dependents.length === 0 ? (
          <p className="lale-muted">Nothing depends on this claim.</p>
        ) : (
          <ul className="label-list">
            {claim.dependents.map((label) => (
              <li key={label} className="lale-mono">
                {label}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {verifiable && state.informalAudit?.claimId === claim.id && (
        <Section label="Informal advisory">
          <InformalAudit
            audit={state.informalAudit}
            claimId={claim.id}
            onAcknowledge={onAcknowledge}
          />
        </Section>
      )}

      {showLatestRun && (
        <Section label={runPanelTitle}>
          <Panel>
            <pre className="run-log">
              {state.latestRunEvents.map(formatRunEventLine).join('\n')}
            </pre>
          </Panel>
        </Section>
      )}
    </>
  );
}

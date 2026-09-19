import { Button, IconButton, Row, Section, Status } from '@lale/ui';
import type { DocumentIssue } from '@lale/document-parser';
import type { ExtensionState } from '../../shared/messages';
import { DependencyGraph } from '../components/DependencyGraph';
import { LatexInline } from '../components/Latex';
import { TopBar } from '../components/TopBar';
import {
  findRuntime,
  formatDocumentItemStatus,
  isRunning,
  isVerifiableClaim,
  projectSubtitle,
  shortLabel,
  statusTone,
} from '../lib/status';

/** Inline banner for a condition the user has to act on. Square, hairline. */
function Callout({
  tone,
  title,
  body,
  action,
}: {
  tone: 'warn' | 'bad';
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="callout" data-tone={tone}>
      <div className="callout-body">
        <span className="callout-title">{title}</span>
        <p className="lale-muted">{body}</p>
      </div>
      {action && (
        <Button onClick={action.onClick}>{action.label}</Button>
      )}
    </div>
  );
}

function StatusStrip({ state }: { state: ExtensionState }) {
  const claims = state.parsedDocument?.claims ?? [];
  const verifiableCount = claims.filter(isVerifiableClaim).length;
  const referenceCount = claims.length - verifiableCount;

  return (
    <div className="status-strip">
      <Status tone={state.desktopStatus === 'connected' ? 'ok' : 'bad'}>
        desktop {state.desktopStatus}
      </Status>
      <Status tone={state.projectStatus === 'linked' ? 'ok' : 'warn'}>
        project {state.projectStatus}
      </Status>
      <Status tone={state.parsedDocument ? 'ok' : 'warn'}>
        {verifiableCount} claims
        {referenceCount > 0 ? ` · ${referenceCount} refs` : ''}
      </Status>
    </div>
  );
}

function Issues({ issues }: { issues: DocumentIssue[] }) {
  const visible = issues.filter((issue) => issue.severity !== 'info').slice(0, 6);
  if (visible.length === 0) {
    return <p className="lale-muted">No blocking structure issues detected.</p>;
  }
  return (
    <ul className="finding-list">
      {visible.map((issue, index) => (
        <li key={index} data-severity={issue.severity}>
          {issue.message}
        </li>
      ))}
    </ul>
  );
}

export function MainView({
  state,
  selectedClaimId,
  onSelect,
  onRefresh,
  onOpenSettings,
  onCreateProject,
}: {
  state: ExtensionState;
  selectedClaimId: string | null;
  onSelect: (claimId: string) => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
  onCreateProject: () => void;
}) {
  const claims = state.parsedDocument?.claims ?? [];

  // Suppress until the desktop has responded once; avoids a one-frame flash on
  // first render before /v1/provision has been hit. A failed attempt leaves
  // `.lake/` behind so projectReady alone is not enough to call it healthy.
  const provision = state.provision;
  const showProvisionCallout =
    provision != null && !(provision.projectReady && provision.status !== 'failed');

  return (
    <>
      <TopBar
        title="lale"
        subtitle={projectSubtitle(state)}
        actions={
          <>
            <IconButton onClick={onOpenSettings} title="Settings" aria-label="Settings">
              ⚙
            </IconButton>
            <IconButton onClick={onRefresh} title="Refresh desktop status" aria-label="Refresh desktop status">
              ↻
            </IconButton>
          </>
        }
      />

      <StatusStrip state={state} />

      {state.error && <Callout tone="bad" title="Error" body={state.error} />}

      {showProvisionCallout && (
        <Callout
          tone={provision.status === 'failed' ? 'bad' : 'warn'}
          title={
            provision.status === 'running'
              ? 'Installing Lean + Mathlib…'
              : provision.status === 'failed'
                ? 'Lean provisioning failed'
                : 'Lean toolchain not installed'
          }
          body={
            provision.status === 'running'
              ? 'Provisioning is in progress. Watch progress in Settings.'
              : provision.status === 'failed'
                ? 'The last attempt errored out. Reprovision from Settings to retry.'
                : 'Verification cannot run until Lean and Mathlib are provisioned locally.'
          }
          action={{
            label: provision.status === 'running' ? 'View progress' : 'Open Settings',
            onClick: onOpenSettings,
          }}
        />
      )}

      {state.projectStatus === 'notLinked' && state.parsedDocument && (
        <Callout
          tone="warn"
          title="New Overleaf project"
          body="Create a local lale project before verification history can be tracked."
          action={{ label: 'Create', onClick: onCreateProject }}
        />
      )}

      <Section label="Claims">
        {claims.length === 0 ? (
          <p className="lale-muted">
            Open an Overleaf source document with theorem-like environments.
          </p>
        ) : (
          <div className="claim-list">
            {claims.map((claim) => {
              const runtime = findRuntime(state, claim.id);
              const status = runtime?.status ?? 'pending';
              const verifiable = isVerifiableClaim(claim);
              const proofMeta = verifiable
                ? claim.proof
                  ? 'proof'
                  : 'no proof'
                : 'no proof required';

              return (
                <Row
                  key={claim.id}
                  tone={statusTone(status)}
                  pulse={isRunning(status)}
                  selected={claim.id === selectedClaimId}
                  onClick={() => onSelect(claim.id)}
                  title={
                    <>
                      {shortLabel(claim)}{' '}
                      <span className="claim-kind">{claim.kind}</span>
                    </>
                  }
                  subtitle={
                    <>
                      <LatexInline source={claim.statement || 'No statement text'} />
                      <span className="claim-meta">
                        {' '}
                        · {claim.dependencies.length} deps · {proofMeta}
                      </span>
                    </>
                  }
                  trailing={
                    <Status tone={statusTone(status)} pulse={isRunning(status)}>
                      {formatDocumentItemStatus(claim, status)}
                    </Status>
                  }
                />
              );
            })}
          </div>
        )}
      </Section>

      <Section label="Document issues">
        <Issues issues={state.parsedDocument?.issues ?? []} />
      </Section>

      <Section label="Dependency graph">
        <DependencyGraph state={state} selectedClaimId={selectedClaimId} onSelect={onSelect} />
      </Section>
    </>
  );
}

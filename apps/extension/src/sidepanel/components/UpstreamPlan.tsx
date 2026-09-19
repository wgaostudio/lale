import type { ParsedClaim } from '@lale/document-parser';
import { Status } from '@lale/ui';
import type { ExtensionState } from '../../shared/messages';
import { buildUpstreamPlan, type UpstreamPlanItem } from '../lib/upstream';
import {
  findRuntime,
  formatDocumentItemStatus,
  formatRuntimeStage,
  isRunning,
  isVerifiableClaim,
  shortLabel,
  statusTone,
} from '../lib/status';

function PlanRow({
  item,
  index,
  state,
  onSelect,
}: {
  item: UpstreamPlanItem;
  index: number;
  state: ExtensionState;
  onSelect: (claimId: string) => void;
}) {
  // Mono, zero-padded ordinals make the verification order scannable as a
  // column rather than something you have to read word by word.
  const order = String(index + 1).padStart(2, '0');

  if (item.type === 'unresolved') {
    return (
      <div className="plan-row" data-unresolved="true">
        <span className="plan-order lale-mono">{order}</span>
        <span className="plan-main">
          <span className="plan-title lale-truncate">{item.label}</span>
          <span className="plan-sub lale-truncate">
            {item.direct ? 'direct' : 'transitive'} reference · parser could not resolve label
          </span>
        </span>
        <Status tone="bad">missing</Status>
      </div>
    );
  }

  const runtime = findRuntime(state, item.claim.id);
  const status = runtime?.status ?? 'pending';
  const action = isVerifiableClaim(item.claim) ? 'verify' : 'formalize';

  return (
    <button type="button" className="plan-row" onClick={() => onSelect(item.claim.id)}>
      <span className="plan-order lale-mono">{order}</span>
      <span className="plan-main">
        <span className="plan-title lale-truncate">{shortLabel(item.claim)}</span>
        <span className="plan-sub lale-truncate">
          {item.direct ? 'direct' : 'transitive'} · {action} · line {item.claim.startLine} ·{' '}
          {formatRuntimeStage(item.claim, runtime)}
        </span>
      </span>
      <Status tone={statusTone(status)} pulse={isRunning(status)}>
        {formatDocumentItemStatus(item.claim, status)}
      </Status>
    </button>
  );
}

export function UpstreamPlan({
  claim,
  state,
  onSelect,
}: {
  claim: ParsedClaim;
  state: ExtensionState;
  onSelect: (claimId: string) => void;
}) {
  const plan = buildUpstreamPlan(claim, state.parsedDocument);

  if (plan.length === 0) {
    return <p className="lale-muted">No upstream claims required.</p>;
  }

  return (
    <div className="plan-list">
      {plan.map((item, index) => (
        <PlanRow
          key={item.type === 'claim' ? item.claim.id : `unresolved:${item.label}`}
          item={item}
          index={index}
          state={state}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

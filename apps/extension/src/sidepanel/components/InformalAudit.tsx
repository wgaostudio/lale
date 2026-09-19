import { useEffect, useRef, useState } from 'react';
import { Button, Status, Textarea } from '@lale/ui';
import type { InformalAuditState } from '../../shared/messages';
import { formatVerdict } from '../lib/status';

function OverrideArea({
  audit,
  isPaused,
  onAcknowledge,
}: {
  audit: InformalAuditState;
  isPaused: boolean;
  onAcknowledge: (runId: string, reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Collapse the form whenever the advisory itself changes — a draft written
  // against one run should never carry over to another.
  useEffect(() => {
    setOpen(false);
    setReason('');
  }, [audit.runId]);

  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  if (audit.overridden) {
    return (
      <div className="advisory-ack">
        <Status tone="ok">Acknowledged</Status>
        {audit.overrideReason && <p className="advisory-ack-reason">{audit.overrideReason}</p>}
        {audit.overriddenAt && <p className="lale-muted">{audit.overriddenAt}</p>}
      </div>
    );
  }

  if (!open) {
    return (
      <div className="actions">
        <Button onClick={() => setOpen(true)}>
          {isPaused ? 'Acknowledge and proceed…' : 'Acknowledge advisory…'}
        </Button>
      </div>
    );
  }

  return (
    <div className="advisory-override">
      <label className="lale-label" htmlFor="override-reason">
        {isPaused ? 'Reason for proceeding' : 'Reason for acknowledgement'}
      </label>
      <Textarea
        id="override-reason"
        ref={textareaRef}
        rows={3}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="e.g. The heuristic misread a non-standard notation; the proof is unaffected."
      />
      <div className="actions">
        <Button
          variant="quiet"
          onClick={() => {
            setOpen(false);
            setReason('');
          }}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={reason.trim().length === 0}
          onClick={() => onAcknowledge(audit.runId, reason.trim())}
        >
          {isPaused ? 'Acknowledge and proceed' : 'Record acknowledgement'}
        </Button>
      </div>
    </div>
  );
}

export function InformalAudit({
  audit,
  claimId,
  onAcknowledge,
}: {
  audit: InformalAuditState | null;
  claimId: string;
  onAcknowledge: (runId: string, reason: string) => void;
}) {
  if (!audit || audit.claimId !== claimId) return null;

  if (audit.status === 'pending') {
    return (
      <Status tone="warn" pulse>
        Running heuristic audit
      </Status>
    );
  }

  if (audit.status === 'failed') {
    return (
      <p className="lale-muted">
        Advisory check failed (non-blocking). {audit.message ?? ''}
      </p>
    );
  }

  if (audit.status === 'noObviousIssue') {
    return (
      <div className="advisory-head">
        <Status tone="ok">No obvious issue</Status>
        {audit.confidence && <span className="lale-muted">{audit.confidence} confidence</span>}
      </div>
    );
  }

  // 'warning' | 'paused' — a high-confidence advisory reads as a failure, a
  // lower-confidence one as a warning.
  const confidence = audit.confidence ?? 'low';
  const isPaused = audit.status === 'paused' || audit.paused;

  return (
    <>
      <div className="advisory-head">
        <Status tone={confidence === 'high' ? 'bad' : 'warn'}>{formatVerdict(audit.verdict)}</Status>
        <span className="lale-muted">{confidence} confidence</span>
      </div>
      {audit.findings.length > 0 ? (
        <ul className="finding-list">
          {audit.findings.map((finding, index) => (
            <li key={index}>{finding}</li>
          ))}
        </ul>
      ) : (
        <p className="lale-muted">No specific findings reported.</p>
      )}
      <p className="lale-muted advisory-note">
        {isPaused
          ? 'Formal verification is paused until acknowledgement is recorded.'
          : 'Formal verification continues while this advisory is available.'}
      </p>
      <OverrideArea audit={audit} isPaused={isPaused} onAcknowledge={onAcknowledge} />
    </>
  );
}

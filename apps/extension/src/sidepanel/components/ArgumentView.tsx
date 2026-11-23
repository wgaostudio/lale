import type { ArgumentCitation, ArgumentStep, ProofArgument } from '@lale/protocol';
import { Panel, Pill, Status, type Tone } from '@lale/ui';
import { LatexBlock } from './Latex';

/**
 * The author's argument as Check proof steps found it: which steps held, which
 * did not and why, what was assumed from the literature, and whether the
 * steps reach the theorem. The gap report is the point of the whole mode, so
 * it is shown in full, not behind a disclosure.
 */

function stepTone(step: ArgumentStep): Tone {
  if (step.status !== 'checked') return 'bad';
  if (step.proofStatus === 'proved') return 'ok';
  if (step.proofStatus === 'refuted') return 'bad';
  return step.proofStatus === 'skipped' ? 'idle' : 'warn';
}

function stepLabel(step: ArgumentStep): string {
  if (step.status !== 'checked') return step.status === 'blocked' ? 'could not be checked' : 'could not be stated';
  if (step.proofStatus === 'proved') return 'proved';
  if (step.proofStatus === 'refuted') return 'false';
  return step.proofStatus === 'skipped' ? 'not attempted' : 'not proved';
}

function citationTone(citation: ArgumentCitation): Tone {
  if (citation.status === 'discharged') return 'ok';
  if (citation.status === 'assumed') return 'warn';
  return 'bad';
}

const CITATION_LABEL: Record<ArgumentCitation['status'], string> = {
  assumed: 'assumed',
  discharged: 'proved from Mathlib',
  rejected: 'rejected',
  unstated: 'could not be stated',
};

function formatUsd(amount: number): string {
  return amount >= 0.01 || amount === 0 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(4)}`;
}

function modelLabel(modelId: string | null): string | null {
  if (!modelId) return null;
  if (modelId === 'openai/gpt-6.2-astra') return 'GPT-6.2 Astra';
  if (modelId === 'anthropic/claude-fable-5.2') return 'Claude Fable 5.2';
  return modelId;
}

export function summarizeArgument(argument: ProofArgument): string {
  const proved = argument.steps.filter((s) => s.status === 'checked' && s.proofStatus === 'proved').length;
  const parts = [`${proved}/${argument.steps.length} steps proved`];
  const refuted = argument.steps.filter((s) => s.proofStatus === 'refuted').length;
  if (refuted) parts.push(`${refuted} shown false in Lean`);
  const assumed = argument.citations.filter((c) => c.status === 'assumed').length;
  if (assumed) parts.push(`${assumed} cited result${assumed === 1 ? '' : 's'} assumed`);
  const composition = argument.composition;
  if (composition?.status === 'proved') parts.push('steps reach the theorem');
  if (composition?.status === 'unproved') parts.push("steps don't reach the theorem");
  if (argument.agentSpendUsd > 0) {
    const model = modelLabel(argument.proverModel);
    parts.push(`${formatUsd(argument.agentSpendUsd)}${model ? ` on ${model}` : ''}${argument.budget === 'hard' ? ' (hard budget)' : ''}`);
  }
  return parts.join(' · ');
}

function LeanDetails({ title, source, backtranslation }: { title: string; source: string | null; backtranslation: string | null }) {
  if (!source && !backtranslation) return null;
  return (
    <details className="argument-details">
      <summary>{title}</summary>
      {backtranslation ? <p className="lale-muted">Reads back as: {backtranslation}</p> : null}
      {source ? <pre className="lean-source">{source}</pre> : null}
    </details>
  );
}

function StepItem({ step, citations }: { step: ArgumentStep; citations: ArgumentCitation[] }) {
  const cited = step.cites.map((i) => citations.find((c) => c.idx === i)).filter((c): c is ArgumentCitation => c !== undefined);
  const failed = !(step.status === 'checked' && step.proofStatus === 'proved');
  return (
    <li className="argument-step">
      <div className="argument-step-head">
        <span className="argument-index lale-mono">{step.idx}</span>
        <Status tone={stepTone(step)}>{stepLabel(step)}</Status>
        {step.proofStatus === 'proved' && step.closedBy && step.closedBy !== 'agent' ? (
          <span className="lale-muted">by <span className="lale-mono">{step.closedBy}</span></span>
        ) : null}
        {step.uses.length ? <span className="lale-muted">uses {step.uses.join(', ')}</span> : null}
        {cited.map((c) => (
          <Pill key={c.idx} title={c.statement}>cites {c.name}</Pill>
        ))}
        {step.turns ? <span className="lale-muted">{step.turns} turns{step.spentUsd ? `, ${formatUsd(step.spentUsd)}` : ''}</span> : null}
      </div>
      <LatexBlock source={step.claim} />
      {failed && step.report ? (
        <div className="callout" data-tone={step.proofStatus === 'refuted' ? 'bad' : 'warn'}>
          <div className="callout-body">
            <span className="callout-title">
              {step.proofStatus === 'refuted' ? 'This step is false: Lean checked a counterexample' : 'What the prover found'}
            </span>
            <p>{step.report}</p>
          </div>
        </div>
      ) : null}
      {failed && !step.report && step.diagnostics.length ? (
        <p className="lale-muted argument-diagnostic">{step.diagnostics[0]}</p>
      ) : null}
      <LeanDetails title="Lean statement" source={step.leanStatement} backtranslation={step.backtranslation} />
      {step.refutation ? <LeanDetails title="Lean counterexample" source={step.refutation} backtranslation={null} /> : null}
    </li>
  );
}

export function ArgumentView({ argument }: { argument: ProofArgument }) {
  const composition = argument.composition;
  return (
    <div className="argument">
      <p className="lale-muted argument-summary">{summarizeArgument(argument)}</p>

      <ol className="argument-steps">
        {argument.steps.map((step) => (
          <StepItem key={step.idx} step={step} citations={argument.citations} />
        ))}
      </ol>

      {composition && composition.status !== 'skipped' ? (
        <div className="callout" data-tone={composition.status === 'proved' ? undefined : 'bad'}>
          <div className="callout-body">
            <span className="callout-title">
              {composition.status === 'proved'
                ? composition.conditionalOn.length
                  ? 'The steps reach the theorem, given the cited results below'
                  : 'The steps reach the theorem'
                : "The steps don't reach the theorem"}
            </span>
            {composition.status !== 'proved' && (composition.report ?? composition.diagnostics[0]) ? (
              <p>{composition.report ?? composition.diagnostics[0]}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {argument.citations.length ? (
        <>
          <span className="lale-label argument-label">Cited results</span>
          <Panel>
            <ul className="argument-citations">
              {argument.citations.map((citation) => (
                <li key={citation.idx}>
                  <div className="argument-step-head">
                    <span className="argument-citation-name">{citation.name}</span>
                    <Status tone={citationTone(citation)}>{CITATION_LABEL[citation.status]}</Status>
                  </div>
                  <LatexBlock source={citation.statement} />
                  <p className="lale-muted">{citation.reason}</p>
                  <LeanDetails title="Lean statement" source={citation.leanSource} backtranslation={citation.backtranslation} />
                </li>
              ))}
            </ul>
          </Panel>
          {argument.citations.some((c) => c.status === 'assumed') ? (
            <p className="lale-muted advisory-note">
              Assumed results are checked against your wording and for easy contradictions, not proved.
              Check that each Lean statement says no more than the source you cite.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

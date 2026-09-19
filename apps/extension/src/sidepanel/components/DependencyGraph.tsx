import type { ExtensionState } from '../../shared/messages';
import { layoutGraph, type GraphRow } from '../lib/graph-layout';
import {
  findRuntime,
  formatDocumentItemStatus,
  isRunning,
  shortLabel,
  statusTone,
} from '../lib/status';

const LANE_WIDTH = 14;
const ROW_HEIGHT = 30;

const laneX = (lane: number): number => lane * LANE_WIDTH + LANE_WIDTH / 2;

/**
 * The lane gutter for a single row. Lines are drawn per row rather than as one
 * tall SVG so each row's text stays plain HTML — truncation, hover and focus
 * all come from CSS instead of being hand-computed in SVG coordinates.
 */
function Gutter({ row, width, tone }: { row: GraphRow; width: number; tone: string }) {
  const midY = ROW_HEIGHT / 2;
  const nodeX = laneX(row.lane);

  return (
    <svg className="graph-gutter" width={width} height={ROW_HEIGHT} aria-hidden="true">
      {row.through.map((lane) => (
        <line key={`t${lane}`} x1={laneX(lane)} y1={0} x2={laneX(lane)} y2={ROW_HEIGHT} />
      ))}

      {row.incoming.map((lane) =>
        lane === row.lane ? (
          <line key={`i${lane}`} x1={nodeX} y1={0} x2={nodeX} y2={midY} />
        ) : (
          <path
            key={`i${lane}`}
            d={`M ${laneX(lane)} 0 L ${laneX(lane)} ${midY - 8} Q ${laneX(lane)} ${midY} ${nodeX} ${midY}`}
          />
        ),
      )}

      {row.outgoing.map((lane) =>
        lane === row.lane ? (
          <line key={`o${lane}`} x1={nodeX} y1={midY} x2={nodeX} y2={ROW_HEIGHT} />
        ) : (
          <path
            key={`o${lane}`}
            d={`M ${nodeX} ${midY} Q ${laneX(lane)} ${midY} ${laneX(lane)} ${midY + 8} L ${laneX(lane)} ${ROW_HEIGHT}`}
          />
        ),
      )}

      <circle className="graph-node-dot" data-tone={tone} cx={nodeX} cy={midY} r={3.5} />
    </svg>
  );
}

export function DependencyGraph({
  state,
  selectedClaimId,
  onSelect,
}: {
  state: ExtensionState;
  selectedClaimId: string | null;
  onSelect: (claimId: string) => void;
}) {
  const layout = layoutGraph(state.parsedDocument);

  if (!layout) {
    return <p className="lale-muted">No document items detected.</p>;
  }

  const gutterWidth = layout.laneCount * LANE_WIDTH;

  return (
    <>
      <div className="graph-rows">
        {layout.rows.map((row) => {
          const runtime = findRuntime(state, row.claim.id);
          const status = runtime?.status ?? 'pending';
          const tone = statusTone(status);
          const selected = row.claim.id === selectedClaimId;

          return (
            <button
              key={row.claim.id}
              type="button"
              className="graph-row"
              data-selected={selected ? 'true' : undefined}
              data-running={isRunning(status) ? 'true' : undefined}
              style={{ height: ROW_HEIGHT }}
              onClick={() => onSelect(row.claim.id)}
              title={`${shortLabel(row.claim)} — ${formatDocumentItemStatus(row.claim, status)}${
                row.bundled > 0 ? ` · ${row.bundled} connection(s) not drawn` : ''
              }`}
            >
              <Gutter row={row} width={gutterWidth} tone={tone} />
              <span className="graph-row-label lale-truncate">{shortLabel(row.claim)}</span>
              {row.bundled > 0 && (
                <span className="graph-row-bundled" title={`${row.bundled} connection(s) not drawn`}>
                  +{row.bundled}
                </span>
              )}
              <span className="graph-row-kind">{row.claim.kind}</span>
            </button>
          );
        })}
      </div>
      {layout.omitted > 0 && (
        <p className="lale-muted graph-note">
          Showing {layout.rows.length} of {layout.rows.length + layout.omitted} claims.
        </p>
      )}
    </>
  );
}

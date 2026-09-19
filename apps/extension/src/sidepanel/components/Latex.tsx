import { renderLatexInline, renderLatexProse } from '../lib/latex';

/** Block-level LaTeX prose — statements and proof bodies. */
export function LatexBlock({ source }: { source: string }) {
  return (
    <div className="latex-block" dangerouslySetInnerHTML={{ __html: renderLatexProse(source) }} />
  );
}

/** Single-line LaTeX, truncated — used inside scannable rows. */
export function LatexInline({ source }: { source: string }) {
  return (
    <span
      className="latex-inline"
      dangerouslySetInnerHTML={{ __html: renderLatexInline(source) }}
    />
  );
}

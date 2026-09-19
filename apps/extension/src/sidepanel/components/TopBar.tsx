import type { ReactNode } from 'react';

/**
 * Title and subtitle share one line to buy vertical space back — the panel is
 * narrow and the claim list is what matters.
 */
export function TopBar({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div className="topbar-title lale-truncate">
        <h1 className="topbar-heading">
          {title === 'lale' ? (
            <img className="topbar-logo" src="/brand/lale-logo.svg" alt="lale" width={69} height={24} />
          ) : (
            <>
              <img className="topbar-mark" src="/brand/lale-mark.svg" alt="" width={24} height={24} />
              {title}
            </>
          )}
        </h1>
        {subtitle && (
          <>
            <span className="topbar-sep">·</span>
            <span className="topbar-subtitle lale-truncate">{subtitle}</span>
          </>
        )}
      </div>
      {actions && <div className="topbar-actions">{actions}</div>}
    </header>
  );
}

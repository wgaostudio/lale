/*
 * @lale/ui React primitives.
 *
 * Thin wrappers over the class names in base.css — the styling contract lives
 * in CSS so the desktop GUI can adopt the same look without React. Keep logic
 * out of here; these are presentational only.
 */
import type { ComponentPropsWithRef, HTMLAttributes, ReactNode } from 'react';

export type Tone = 'idle' | 'ok' | 'warn' | 'bad';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* --- Text -------------------------------------------------------------- */

export function Label({ children, className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx('lale-label', className)} {...rest}>
      {children}
    </span>
  );
}

/* --- Structure --------------------------------------------------------- */

export function Section({
  label,
  action,
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLElement> & { label?: ReactNode; action?: ReactNode }) {
  return (
    <section className={cx('lale-section', className)} {...rest}>
      {(label || action) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--lale-space-4)',
            marginBottom: 'var(--lale-space-5)',
          }}
        >
          {label ? <Label style={{ marginBottom: 0 }}>{label}</Label> : <span />}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Panel({ children, className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('lale-panel', className)} {...rest}>
      {children}
    </div>
  );
}

/* --- Status ------------------------------------------------------------ */

export function Dot({ tone = 'idle', pulse = false }: { tone?: Tone; pulse?: boolean }) {
  return <span className="lale-dot" data-tone={tone} data-pulse={pulse ? 'true' : undefined} />;
}

/** Dot plus an uppercase label — the canonical way status is expressed. */
export function Status({
  tone = 'idle',
  pulse = false,
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; pulse?: boolean }) {
  return (
    <span className={cx('lale-status', className)} data-tone={tone} {...rest}>
      <Dot tone={tone} pulse={pulse} />
      {children}
    </span>
  );
}

export function Pill({ children, className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx('lale-pill', className)} {...rest}>
      {children}
    </span>
  );
}

/* --- Controls ---------------------------------------------------------- */

export function Button({
  variant = 'default',
  children,
  className,
  type = 'button',
  ...rest
}: ComponentPropsWithRef<'button'> & { variant?: 'default' | 'primary' | 'quiet' }) {
  return (
    <button
      type={type}
      className={cx('lale-button', className)}
      data-variant={variant === 'default' ? undefined : variant}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconButton({
  children,
  className,
  type = 'button',
  ...rest
}: ComponentPropsWithRef<'button'>) {
  return (
    <button type={type} className={cx('lale-icon-button', className)} {...rest}>
      {children}
    </button>
  );
}

export function Input({
  mono = false,
  className,
  ...rest
}: ComponentPropsWithRef<'input'> & { mono?: boolean }) {
  return <input className={cx('lale-input', mono && 'lale-mono', className)} {...rest} />;
}

export function Textarea({
  mono = false,
  className,
  ...rest
}: ComponentPropsWithRef<'textarea'> & { mono?: boolean }) {
  return <textarea className={cx('lale-textarea', mono && 'lale-mono', className)} {...rest} />;
}

/* --- Rows -------------------------------------------------------------- */

/**
 * One scannable line: status marker, title + subtitle, trailing status text.
 * Renders as a button when `onClick` is supplied, otherwise a plain div, so
 * non-interactive lists don't advertise affordances they don't have.
 */
export function Row({
  tone = 'idle',
  pulse = false,
  title,
  subtitle,
  trailing,
  selected = false,
  onClick,
  disabled,
}: {
  tone?: Tone;
  pulse?: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const inner = (
    <>
      <Dot tone={tone} pulse={pulse} />
      <span className="lale-row-main">
        <span className="lale-row-title lale-truncate">{title}</span>
        {subtitle && <span className="lale-row-sub lale-truncate">{subtitle}</span>}
      </span>
      {trailing && <span>{trailing}</span>}
    </>
  );

  if (!onClick) {
    return (
      <div className="lale-row" data-selected={selected ? 'true' : undefined} style={{ cursor: 'default' }}>
        {inner}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="lale-row"
      data-selected={selected ? 'true' : undefined}
      onClick={onClick}
      disabled={disabled}
    >
      {inner}
    </button>
  );
}

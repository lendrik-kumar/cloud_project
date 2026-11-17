import type { ReactNode } from 'react';
import type { EnrollStatus } from '../api';
import { ENROLL_LABELS } from '../enroll';

export function Spinner({ small }: { small?: boolean }) {
  return <span className={small ? 'spinner spinner-sm' : 'spinner'} aria-hidden="true" />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

type AlertKind = 'error' | 'warn' | 'info' | 'success';

export function Alert({
  kind = 'error',
  children,
  onRetry,
}: {
  kind?: AlertKind;
  children: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div className="alert-body">{children}</div>
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function EnrollBadge({ status, error }: { status: EnrollStatus; error?: string | null }) {
  const info = ENROLL_LABELS[status] ?? { label: status, tone: 'neutral', hint: '' };
  return (
    <span className={`badge badge-${info.tone}`} title={error || info.hint}>
      {status === 'PENDING' ? <Spinner small /> : <span aria-hidden="true">{info.tone === 'good' ? '✓' : '!'}</span>}
      {info.label}
    </span>
  );
}

/** Percentage with a thin meter and a tick at the threshold. */
export function PctMeter({ pct, threshold, below }: { pct: number; threshold: number; below: boolean }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="pct">
      <span className="pct-value">{pct.toFixed(1)}%</span>
      <span className="meter" aria-hidden="true">
        <span className={below ? 'meter-fill meter-below' : 'meter-fill'} style={{ width: `${clamped}%` }} />
        <span className="meter-tick" style={{ left: `${threshold}%` }} />
      </span>
    </div>
  );
}

export function BelowTag({ threshold }: { threshold: number }) {
  return (
    <span className="badge badge-bad" title={`Below the ${threshold}% attendance requirement`}>
      <span aria-hidden="true">!</span>Below {threshold}%
    </span>
  );
}

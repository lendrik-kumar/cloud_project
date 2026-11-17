import type { RekognitionUsage as Usage } from '../api';
import { summarizeUsage } from '../rekognition';
import { Alert } from './ui';

/** One-line usage meter for the page footer. */
export function RekognitionUsageMeter({ usage }: { usage: Usage }) {
  const s = summarizeUsage(usage);
  return (
    <div
      className={`usage usage-${s.level}`}
      title={`${s.monthLabel}: group 1 ${usage.group1} · group 2 ${usage.group2} · cap ${usage.cap} per group`}
    >
      <span>
        Rekognition this month: <strong>{s.used}</strong> / {s.cap} (free-tier cap)
      </span>
      <span className="meter usage-meter" aria-hidden="true">
        <span className="meter-fill" style={{ width: `${Math.min(100, s.pct)}%` }} />
      </span>
      {s.level === 'reached' && <span className="usage-flag">cap reached</span>}
    </div>
  );
}

/** Shown before Rekognition work (attendance photos, enrollment) when the cap is near or reached. */
export function RekognitionCapNotice({ usage, action }: { usage?: Usage; action: 'attendance' | 'enroll' }) {
  if (!usage) return null;
  const s = summarizeUsage(usage);
  if (s.level === 'ok') return null;
  if (s.level === 'reached') {
    return (
      <Alert kind="warn">
        This month’s Rekognition free-tier cap is used up ({s.used} / {s.cap}).{' '}
        {action === 'attendance'
          ? 'Photos are still saved, but faces won’t be recognised. After uploading, use the Mark present / Mark absent buttons.'
          : 'New reference photos may not be indexed until next month; the status will show why.'}
      </Alert>
    );
  }
  return (
    <Alert kind="info">
      Rekognition usage is at {s.used} of {s.cap} free-tier calls for {s.monthLabel}.
    </Alert>
  );
}

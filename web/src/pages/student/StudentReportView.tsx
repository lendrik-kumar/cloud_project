import { api, ApiError, formatDate, type StudentReport } from '../../api';
import { useAsync } from '../../hooks';
import { Alert, BelowTag, Empty, Loading, PctMeter } from '../../components/ui';

/** Consecutive sessions a student must attend to climb back to the threshold. */
function sessionsToRecover(attended: number, total: number, threshold: number): number | null {
  if (threshold >= 100) return null;
  const k = Math.ceil((threshold * total - 100 * attended) / (100 - threshold) - 1e-9);
  return Math.max(0, k);
}

function ClassCard({ c, threshold }: { c: StudentReport['classes'][number]; threshold: number }) {
  const present = new Set(c.presentDates);
  const dates = [...c.sessionDates].sort().reverse();
  const recover = c.belowThreshold ? sessionsToRecover(c.attended, c.total, threshold) : null;

  return (
    <section className={c.belowThreshold ? 'card class-report class-report-below' : 'card class-report'}>
      <div className="section-head">
        <div>
          <h2>{c.name}</h2>
          <p className="muted small mono">{c.classId}</p>
        </div>
        {c.belowThreshold && <BelowTag threshold={threshold} />}
      </div>
      <div className="class-report-summary">
        <span className="big-pct">{c.total ? `${c.pct.toFixed(1)}%` : '—'}</span>
        <div className="grow">
          <PctMeter pct={c.pct} threshold={threshold} below={c.belowThreshold} />
          <p className="muted small">
            Attended {c.attended} of {c.total} session{c.total === 1 ? '' : 's'}
          </p>
        </div>
      </div>
      {recover !== null && recover > 0 && (
        <p className="small">
          Attend the next <strong>{recover}</strong> session{recover === 1 ? '' : 's'} in a row to get back to{' '}
          {threshold}%.
        </p>
      )}
      {dates.length === 0 ? (
        <p className="muted small">No sessions held yet.</p>
      ) : (
        <ul className="date-chips" aria-label="Sessions, newest first">
          {dates.map((d) => {
            const here = present.has(d);
            return (
              <li key={d} className={here ? 'chip chip-present' : 'chip chip-absent'} title={`${formatDate(d)}: ${here ? 'present' : 'absent'}`}>
                <span aria-hidden="true">{here ? '✓' : '✗'}</span>
                <span>{formatDate(d)}</span>
                <span className="sr-only">{here ? 'present' : 'absent'}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function StudentReportView({ studentId, heading }: { studentId: string; heading?: string }) {
  const report = useAsync(async () => {
    try {
      return await api.studentReport(studentId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }, `student-report:${studentId}`);

  if (report.error) return <Alert onRetry={report.reload}>{report.error}</Alert>;
  if (report.data === undefined) return <Loading label="Loading attendance…" />;
  if (report.data === null) return <Empty title="No attendance record found">There is no student with ID {studentId}.</Empty>;
  const r = report.data;
  const below = r.classes.filter((c) => c.belowThreshold);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{heading ?? r.student.name}</h1>
          <p className="muted small">
            {heading ? `${r.student.name} · ` : ''}
            <span className="mono">{r.student.studentId}</span> · minimum attendance {r.threshold}%
          </p>
        </div>
      </header>
      {below.length > 0 && (
        <Alert kind="warn">
          Below {r.threshold}% in {below.map((c) => c.name).join(', ')}.
        </Alert>
      )}
      {r.classes.length === 0 ? (
        <Empty title="Not enrolled in any class yet" />
      ) : (
        <div className="stack">
          {r.classes.map((c) => (
            <ClassCard key={c.classId} c={c} threshold={r.threshold} />
          ))}
        </div>
      )}
    </div>
  );
}

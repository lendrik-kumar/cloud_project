import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { useAsync } from '../../hooks';
import { BarChart } from '../../components/BarChart';
import { Alert, BelowTag, Empty, Loading, PctMeter } from '../../components/ui';
import { useClass } from './class-context';

type Sort = 'name' | 'pct';

export function ClassReportPage() {
  const { cls } = useClass();
  const report = useAsync(() => api.classReport(cls.classId), `report:${cls.classId}`);
  const [sort, setSort] = useState<Sort>('pct');
  const [onlyBelow, setOnlyBelow] = useState(false);

  if (report.error) return <Alert onRetry={report.reload}>{report.error}</Alert>;
  if (!report.data) return <Loading label="Loading report…" />;
  const r = report.data;

  const below = r.students.filter((s) => s.belowThreshold).length;
  const avg = r.students.length ? r.students.reduce((a, s) => a + s.pct, 0) / r.students.length : 0;
  const rows = r.students
    .filter((s) => !onlyBelow || s.belowThreshold)
    .sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : a.pct - b.pct || a.name.localeCompare(b.name)));

  return (
    <div className="stack">
      <div className="stats">
        <div className="stat">
          <span className="stat-value">{r.totalSessions}</span>
          <span className="stat-label">sessions</span>
        </div>
        <div className="stat">
          <span className="stat-value">{avg.toFixed(1)}%</span>
          <span className="stat-label">average attendance</span>
        </div>
        <div className={below ? 'stat stat-bad' : 'stat'}>
          <span className="stat-value">{below}</span>
          <span className="stat-label">below {r.threshold}%</span>
        </div>
      </div>

      {r.sessions.length > 0 ? (
        <section className="card">
          <BarChart
            title="Students present per session"
            data={r.sessions.map((s) => ({ date: s.date, value: s.presentCount }))}
            max={r.students.length}
            unit="present"
          />
        </section>
      ) : (
        <Empty title="No sessions yet">
          <p>
            <Link to={`/classes/${encodeURIComponent(cls.classId)}/attendance`}>Take attendance</Link> to start
            building the report.
          </p>
        </Empty>
      )}

      <section className="card">
        <div className="section-head">
          <h2>Students</h2>
          <div className="toolbar toolbar-tight">
            <label className="inline-field">
              <span>Sort</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="pct">Lowest attendance first</option>
                <option value="name">Name</option>
              </select>
            </label>
            <label className="inline-field">
              <input type="checkbox" checked={onlyBelow} onChange={(e) => setOnlyBelow(e.target.checked)} />
              <span>Only below {r.threshold}%</span>
            </label>
          </div>
        </div>
        {r.students.length === 0 ? (
          <p className="muted">No students on this roster.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Student</th>
                  <th className="num">Attended</th>
                  <th>Attendance</th>
                  <th aria-label="Status" />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.studentId} className={s.belowThreshold ? 'row-below' : undefined}>
                    <td>
                      <Link to={`/students/${encodeURIComponent(s.studentId)}/report`} className="person">
                        <span className="person-name">{s.name}</span>
                        <span className="muted small mono">{s.studentId}</span>
                      </Link>
                    </td>
                    <td className="num">
                      {s.attended}
                      <span className="muted"> / {s.total}</span>
                    </td>
                    <td>
                      <PctMeter pct={s.pct} threshold={r.threshold} below={s.belowThreshold} />
                    </td>
                    <td>{s.belowThreshold && <BelowTag threshold={r.threshold} />}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      Everyone is at or above {r.threshold}%.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">The tick on each bar marks the {r.threshold}% requirement.</p>
      </section>
    </div>
  );
}

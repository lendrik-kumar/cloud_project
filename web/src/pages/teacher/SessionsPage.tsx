import { Link } from 'react-router-dom';
import { api, formatDate } from '../../api';
import { useAsync } from '../../hooks';
import { Alert, Empty, Loading } from '../../components/ui';
import { useClass } from './class-context';

export function SessionsPage() {
  const { cls } = useClass();
  const sessions = useAsync(() => api.listSessions(cls.classId), `sessions:${cls.classId}`);
  const base = `/classes/${encodeURIComponent(cls.classId)}`;

  if (sessions.error) return <Alert onRetry={sessions.reload}>{sessions.error}</Alert>;
  if (!sessions.data) return <Loading label="Loading sessions…" />;
  if (sessions.data.length === 0) {
    return (
      <Empty title="No sessions yet">
        <p>
          <Link to={`${base}/attendance`}>Take attendance</Link> to create the first session.
        </p>
      </Empty>
    );
  }

  return (
    <section className="card">
      <div className="section-head">
        <h2>Sessions</h2>
        <Link to={`${base}/attendance`} className="btn btn-sm btn-primary">
          Take attendance
        </Link>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">Present</th>
              <th className="num">Faces detected</th>
              <th className="num">Photos</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {sessions.data.map((s) => (
              <tr key={s.date}>
                <td>
                  <Link to={`${base}/sessions/${s.date}`}>{formatDate(s.date)}</Link>
                </td>
                <td className="num">
                  {s.presentCount}
                  <span className="muted"> / {cls.studentIds.length}</span>
                </td>
                <td className="num">{s.facesDetected}</td>
                <td className="num">{s.photoCount}</td>
                <td className="num">
                  <Link to={`${base}/sessions/${s.date}`} className="btn btn-sm">
                    Review
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">“/ {cls.studentIds.length}” is the current roster size.</p>
    </section>
  );
}

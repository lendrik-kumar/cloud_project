import { useMemo, useState } from 'react';
import { api, errorMessage, type SessionDetail } from '../api';
import { FacePhoto } from './FacePhoto';
import { Alert, Spinner } from './ui';

type Props = {
  classId: string;
  date: string;
  detail: SessionDetail;
  /** Refetch the session after a manual override. */
  refetch: () => Promise<void>;
};

export function SessionView({ classId, date, detail, refetch }: Props) {
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();

  const names = useMemo(() => {
    const m = new Map<string, string>();
    detail.present.forEach((s) => m.set(s.studentId, s.name));
    detail.absent.forEach((s) => m.set(s.studentId, s.name));
    return m;
  }, [detail]);

  const toggle = async (studentId: string, present: boolean) => {
    setError(undefined);
    setBusy((b) => new Set(b).add(studentId));
    try {
      await api.setAttendance(classId, date, studentId, present);
      await refetch();
    } catch (err) {
      setError(`Could not update ${names.get(studentId) ?? studentId}: ${errorMessage(err)}`);
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(studentId);
        return next;
      });
    }
  };

  const total = detail.present.length + detail.absent.length;
  const skipped = detail.session.photos.filter((p) => p.note).length;
  const present = [...detail.present].sort((a, b) => a.name.localeCompare(b.name));
  const absent = [...detail.absent].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="session-view">
      <div className="stats">
        <div className="stat">
          <span className="stat-value">
            {detail.present.length}
            <span className="stat-of">/{total}</span>
          </span>
          <span className="stat-label">present</span>
        </div>
        <div className="stat">
          <span className="stat-value">{detail.absent.length}</span>
          <span className="stat-label">absent</span>
        </div>
        <div className="stat">
          <span className="stat-value">{detail.session.facesDetected}</span>
          <span className="stat-label">faces detected</span>
        </div>
        <div className="stat">
          <span className="stat-value">{detail.session.photos.length}</span>
          <span className="stat-label">photo{detail.session.photos.length === 1 ? '' : 's'}</span>
        </div>
      </div>

      {error && <Alert>{error}</Alert>}
      {skipped > 0 && (
        <Alert kind="warn">
          Face recognition was limited for {skipped === detail.session.photos.length ? 'all photos' : `${skipped} photo${skipped === 1 ? '' : 's'}`} in
          this session (see the note on each photo). Check the lists and use Mark present / Mark absent.
        </Alert>
      )}

      <div className="session-grid">
        <section className="card attendance-lists">
          <h3>
            Present <span className="count">{present.length}</span>
          </h3>
          {present.length === 0 ? (
            <p className="muted small">Nobody marked present yet.</p>
          ) : (
            <ul className="people">
              {present.map((s) => (
                <li key={s.studentId}>
                  <span className="person">
                    <span className="person-name">{s.name}</span>
                    <span className="muted small">
                      {s.studentId} ·{' '}
                      {s.source === 'manual'
                        ? 'marked by teacher'
                        : `recognised${s.similarity != null ? ` ${s.similarity.toFixed(1)}%` : ''}`}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy.has(s.studentId)}
                    onClick={() => toggle(s.studentId, false)}
                  >
                    {busy.has(s.studentId) ? <Spinner small /> : null}
                    Mark absent
                  </button>
                </li>
              ))}
            </ul>
          )}

          <h3>
            Absent <span className="count">{absent.length}</span>
          </h3>
          {absent.length === 0 ? (
            <p className="muted small">Everyone on the roster is present.</p>
          ) : (
            <ul className="people">
              {absent.map((s) => (
                <li key={s.studentId}>
                  <span className="person">
                    <span className="person-name">{s.name}</span>
                    <span className="muted small">{s.studentId}</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={busy.has(s.studentId)}
                    onClick={() => toggle(s.studentId, true)}
                  >
                    {busy.has(s.studentId) ? <Spinner small /> : null}
                    Mark present
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="photos">
          {detail.session.photos.length === 0 ? (
            <p className="muted">No photos in this session (attendance was entered manually).</p>
          ) : (
            detail.session.photos.map((p, i) => (
              <FacePhoto key={p.key} photo={p} index={i} names={names} onExpired={() => void refetch()} />
            ))
          )}
          <p className="legend small">
            <span className="legend-swatch legend-known" /> recognised student
            <span className="legend-swatch legend-unknown" /> unknown face
          </p>
        </section>
      </div>
    </div>
  );
}

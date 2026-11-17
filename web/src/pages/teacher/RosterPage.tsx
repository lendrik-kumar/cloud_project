import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage, type Student } from '../../api';
import { useAsync } from '../../hooks';
import { Alert, EnrollBadge, Empty, Loading, Spinner } from '../../components/ui';
import { useClass } from './class-context';

export function RosterPage() {
  const { cls, setCls } = useClass();
  const students = useAsync(api.listStudents, 'students');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(cls.studentIds));
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  // Students on the roster whose record no longer exists still need to be shown.
  const all: Student[] = useMemo(() => {
    const known = students.data ?? [];
    const ids = new Set(known.map((s) => s.studentId));
    const orphans = cls.studentIds
      .filter((id) => !ids.has(id))
      .map(
        (id): Student => ({
          studentId: id,
          name: '(unknown student)',
          email: '',
          enrollStatus: 'ERROR',
          enrollError: 'No student record with this ID',
          subscribed: false,
        }),
      );
    return [...known, ...orphans].sort((a, b) => a.name.localeCompare(b.name));
  }, [students.data, cls.studentIds]);

  const q = filter.trim().toLowerCase();
  const visible = q
    ? all.filter((s) => `${s.name} ${s.studentId} ${s.email}`.toLowerCase().includes(q))
    : all;

  const dirty =
    selected.size !== cls.studentIds.length || cls.studentIds.some((id) => !selected.has(id));

  const toggle = (id: string) => {
    setSaved(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setVisible = (on: boolean) => {
    setSaved(false);
    setSelected((prev) => {
      const next = new Set(prev);
      visible.forEach((s) => (on ? next.add(s.studentId) : next.delete(s.studentId)));
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      // Keep the order stable: alphabetical by ID.
      const updated = await api.setRoster(cls.classId, [...selected].sort());
      setCls(updated);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (students.error) return <Alert onRetry={students.reload}>{students.error}</Alert>;
  if (!students.data) return <Loading label="Loading students…" />;
  if (all.length === 0) {
    return (
      <Empty title="No students enrolled yet">
        <p>
          <Link to="/students">Enroll students</Link> first, then come back to add them to this class.
        </p>
      </Empty>
    );
  }

  const notIndexed = all.filter((s) => selected.has(s.studentId) && s.enrollStatus !== 'INDEXED').length;

  return (
    <section className="card">
      <div className="section-head">
        <h2>Roster</h2>
        <span className="muted small">
          {selected.size} of {all.length} students selected
        </span>
      </div>
      <div className="toolbar">
        <input
          type="search"
          placeholder="Filter by name, ID or email"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter students"
        />
        <button type="button" className="btn btn-sm" onClick={() => setVisible(true)}>
          Select {q ? 'shown' : 'all'}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setVisible(false)}>
          Clear {q ? 'shown' : 'all'}
        </button>
      </div>

      <ul className="checklist">
        {visible.map((s) => (
          <li key={s.studentId}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(s.studentId)}
                onChange={() => toggle(s.studentId)}
              />
              <span className="person">
                <span className="person-name">{s.name}</span>
                <span className="muted small">
                  <span className="mono">{s.studentId}</span>
                  {s.email ? ` · ${s.email}` : ''}
                </span>
              </span>
              <EnrollBadge status={s.enrollStatus} error={s.enrollError} />
            </label>
          </li>
        ))}
        {visible.length === 0 && <li className="muted small">No students match “{filter}”.</li>}
      </ul>

      {notIndexed > 0 && (
        <Alert kind="warn">
          {notIndexed} selected student{notIndexed === 1 ? ' has' : 's have'} no indexed face yet and
          won’t be recognised in photos until their reference photo is processed. You can still mark
          them present manually.
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      {saved && !dirty && <Alert kind="success">Roster saved.</Alert>}

      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={save}>
          {saving && <Spinner small />} Save roster
        </button>
        {dirty && (
          <button
            type="button"
            className="btn btn-link"
            disabled={saving}
            onClick={() => setSelected(new Set(cls.studentIds))}
          >
            Discard changes
          </button>
        )}
      </div>
    </section>
  );
}

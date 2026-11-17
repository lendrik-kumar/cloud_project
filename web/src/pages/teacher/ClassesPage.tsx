import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, errorMessage, ID_PATTERN } from '../../api';
import { useAsync } from '../../hooks';
import { Alert, Empty, Loading, Spinner } from '../../components/ui';

export function ClassesPage() {
  const classes = useAsync(api.listClasses, 'classes');
  const navigate = useNavigate();
  const [classId, setClassId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    const id = classId.trim();
    if (!ID_PATTERN.test(id)) {
      setError('Class ID may use letters, digits, "-" and "_" only (max 40 characters).');
      return;
    }
    setBusy(true);
    try {
      const created = await api.createClass(id, name.trim());
      navigate(`/classes/${encodeURIComponent(created.classId)}`);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? `A class with ID "${id}" already exists.`
          : errorMessage(err),
      );
      setBusy(false);
    }
  };

  const list = [...(classes.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="page">
      <header className="page-header">
        <h1>Classes</h1>
      </header>

      <section className="card">
        <h2>Create a class</h2>
        <form className="form form-inline" onSubmit={onCreate}>
          <label className="field">
            <span>Class ID</span>
            <input
              required
              maxLength={40}
              pattern="[A-Za-z0-9_\-]{1,40}"
              placeholder="UCS531-A"
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
            />
          </label>
          <label className="field field-grow">
            <span>Name</span>
            <input
              required
              placeholder="Cloud Computing — Section A"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <Spinner small />} Create class
          </button>
        </form>
        {error && <Alert>{error}</Alert>}
      </section>

      {classes.error && <Alert onRetry={classes.reload}>{classes.error}</Alert>}
      {classes.loading && !classes.data ? (
        <Loading label="Loading classes…" />
      ) : classes.data && list.length === 0 ? (
        <Empty title="No classes yet">Create your first class above, then add students to its roster.</Empty>
      ) : (
        <ul className="class-grid">
          {list.map((c) => (
            <li key={c.classId}>
              <Link to={`/classes/${encodeURIComponent(c.classId)}`} className="card class-card">
                <span className="class-name">{c.name}</span>
                <span className="muted small mono">{c.classId}</span>
                <span className="class-meta">
                  <span>
                    <strong>{c.studentIds.length}</strong> student{c.studentIds.length === 1 ? '' : 's'}
                  </span>
                  <span>
                    <strong>{c.sessionCount}</strong> session{c.sessionCount === 1 ? '' : 's'}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

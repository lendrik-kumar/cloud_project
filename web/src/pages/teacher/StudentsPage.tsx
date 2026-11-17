import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, errorMessage, ID_PATTERN, type Student } from '../../api';
import { useAsync } from '../../hooks';
import { Alert, EnrollBadge, Empty, Loading, Spinner } from '../../components/ui';
import { EnrollPhotoPanel } from './EnrollPhotoPanel';

type Active = { student: Student; uploadUrl?: string; nonce: number };

export function StudentsPage() {
  const students = useAsync(api.listStudents, 'students');
  const [form, setForm] = useState({ studentId: '', name: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<string>();
  const [active, setActive] = useState<Active | null>(null);
  const [filter, setFilter] = useState('');

  const upsert = (s: Student) =>
    students.setData((prev = []) =>
      prev.some((x) => x.studentId === s.studentId)
        ? prev.map((x) => (x.studentId === s.studentId ? s : x))
        : [...prev, s],
    );

  const openPanel = (student: Student, uploadUrl?: string) => {
    setActive({ student, uploadUrl, nonce: Date.now() });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const onEnroll = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setCreated(undefined);
    const input = {
      studentId: form.studentId.trim(),
      name: form.name.trim(),
      email: form.email.trim(),
    };
    if (!ID_PATTERN.test(input.studentId)) {
      setError('Student ID may use letters, digits, "-" and "_" only (max 40 characters).');
      return;
    }
    setBusy(true);
    try {
      const { student, uploadUrl } = await api.createStudent(input);
      upsert(student);
      setForm({ studentId: '', name: '', email: '' });
      setCreated(
        `${student.name} enrolled. Cognito has emailed a temporary password to ${student.email}.`,
      );
      openPanel(student, uploadUrl);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? `A student with ID "${input.studentId}" or that email already exists.`
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const q = filter.trim().toLowerCase();
  const list = [...(students.data ?? [])]
    .filter((s) => !q || `${s.name} ${s.studentId} ${s.email}`.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="page">
      <header className="page-header">
        <h1>Students</h1>
      </header>

      {active && (
        <EnrollPhotoPanel
          key={`${active.student.studentId}:${active.nonce}`}
          student={active.student}
          initialUploadUrl={active.uploadUrl}
          uploadUrlIssuedAt={active.nonce}
          onStudentUpdate={upsert}
          onClose={() => {
            setActive(null);
            setCreated(undefined);
          }}
        />
      )}
      {created && <Alert kind="success">{created}</Alert>}

      <section className="card">
        <h2>Enroll a student</h2>
        <form className="form form-inline" onSubmit={onEnroll}>
          <label className="field">
            <span>Student ID</span>
            <input
              required
              maxLength={40}
              pattern="[A-Za-z0-9_\-]{1,40}"
              placeholder="102203001"
              value={form.studentId}
              onChange={(e) => setForm({ ...form, studentId: e.target.value })}
            />
          </label>
          <label className="field field-grow">
            <span>Full name</span>
            <input
              required
              placeholder="Asha Verma"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="field field-grow">
            <span>Email</span>
            <input
              type="email"
              required
              placeholder="asha@example.edu"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <Spinner small />} Enroll
          </button>
        </form>
        <p className="muted small">
          Enrolling creates the student’s login; they receive a temporary password by email.
        </p>
        {error && <Alert>{error}</Alert>}
      </section>

      <section className="card">
        <div className="section-head">
          <h2>All students</h2>
          {students.data && students.data.length > 0 && (
            <input
              type="search"
              className="search"
              placeholder="Filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter students"
            />
          )}
        </div>
        {students.error && <Alert onRetry={students.reload}>{students.error}</Alert>}
        {!students.data ? (
          !students.error && <Loading label="Loading students…" />
        ) : students.data.length === 0 ? (
          <Empty title="No students yet">Enroll your first student above.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Student</th>
                  <th className="hide-sm">Email</th>
                  <th>Face</th>
                  <th className="hide-sm">Email alerts</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.studentId}>
                    <td>
                      <span className="person">
                        <span className="person-name">{s.name}</span>
                        <span className="muted small mono">{s.studentId}</span>
                      </span>
                    </td>
                    <td className="hide-sm">{s.email}</td>
                    <td>
                      <span className="status-cell">
                        <EnrollBadge status={s.enrollStatus} error={s.enrollError} />
                        {s.enrollStatus !== 'INDEXED' && s.enrollStatus !== 'PENDING' && s.enrollError && (
                          <span className="enroll-error">{s.enrollError}</span>
                        )}
                      </span>
                    </td>
                    <td className="hide-sm">{s.subscribed ? 'Confirmed' : 'Awaiting confirmation'}</td>
                    <td className="row-actions">
                      <button type="button" className="btn btn-sm" onClick={() => openPanel(s)}>
                        {s.enrollStatus === 'INDEXED' ? 'Re-take photo' : 'Upload photo'}
                      </button>
                      <Link to={`/students/${encodeURIComponent(s.studentId)}/report`} className="btn btn-sm btn-ghost">
                        Report
                      </Link>
                    </td>
                  </tr>
                ))}
                {list.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      No students match “{filter}”.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

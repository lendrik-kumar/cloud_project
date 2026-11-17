import { Link, NavLink, Outlet, useParams } from 'react-router-dom';
import { api, type Class } from '../../api';
import { useAsync } from '../../hooks';
import { Alert, Empty, Loading } from '../../components/ui';
import type { ClassContext } from './class-context';

export function ClassLayout() {
  const { classId = '' } = useParams();
  // There is no single-class GET in the API, so find it in the teacher's list.
  const classes = useAsync(api.listClasses, 'classes');
  const cls = classes.data?.find((c) => c.classId === classId);

  if (classes.error) return <Alert onRetry={classes.reload}>{classes.error}</Alert>;
  if (!classes.data) return <Loading label="Loading class…" />;
  if (!cls) {
    return (
      <Empty title="Class not found">
        <p>
          No class with ID <code>{classId}</code> belongs to you. <Link to="/classes">Back to classes</Link>
        </p>
      </Empty>
    );
  }

  const setCls = (next: Class) =>
    classes.setData((prev = []) => prev.map((c) => (c.classId === next.classId ? next : c)));
  const ctx: ClassContext = { cls, setCls, reload: classes.reload };
  const base = `/classes/${encodeURIComponent(cls.classId)}`;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="crumbs">
            <Link to="/classes">Classes</Link> /
          </p>
          <h1>{cls.name}</h1>
          <p className="muted small">
            <span className="mono">{cls.classId}</span> · {cls.studentIds.length} student
            {cls.studentIds.length === 1 ? '' : 's'} · {cls.sessionCount} session
            {cls.sessionCount === 1 ? '' : 's'}
          </p>
        </div>
      </header>
      <nav className="tabs" aria-label="Class sections">
        <NavLink to={base} end className="tab">
          Roster
        </NavLink>
        <NavLink to={`${base}/attendance`} className="tab">
          Take attendance
        </NavLink>
        <NavLink to={`${base}/sessions`} className="tab">
          Sessions
        </NavLink>
        <NavLink to={`${base}/report`} className="tab">
          Report
        </NavLink>
      </nav>
      <Outlet context={ctx} />
    </div>
  );
}

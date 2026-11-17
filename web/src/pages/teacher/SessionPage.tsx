import { Link, useParams } from 'react-router-dom';
import { api, ApiError, DATE_PATTERN, formatDate } from '../../api';
import { useAsync } from '../../hooks';
import { SessionView } from '../../components/SessionView';
import { Alert, Empty, Loading } from '../../components/ui';
import { useClass } from './class-context';

export function SessionPage() {
  const { cls } = useClass();
  const { date = '' } = useParams();
  const base = `/classes/${encodeURIComponent(cls.classId)}`;
  const session = useAsync(async () => {
    try {
      return await api.getSession(cls.classId, date);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }, `session:${cls.classId}:${date}`);

  if (!DATE_PATTERN.test(date)) return <Alert>Invalid date in the address: {date}</Alert>;
  if (session.error) return <Alert onRetry={session.reload}>{session.error}</Alert>;
  if (session.data === undefined) return <Loading label="Loading session…" />;
  if (session.data === null) {
    return (
      <Empty title={`No session on ${formatDate(date)}`}>
        <p>
          No photo has been processed for this date yet.{' '}
          <Link to={`${base}/attendance`}>Take attendance</Link> or{' '}
          <button type="button" className="btn btn-link" onClick={session.reload}>
            check again
          </button>
          .
        </p>
      </Empty>
    );
  }

  const refetch = async () => {
    const next = await api.getSession(cls.classId, date);
    session.setData(next);
  };

  return (
    <div className="stack">
      <div className="section-head">
        <h2>
          <Link to={`${base}/sessions`} className="back-link" aria-label="Back to sessions">
            ←
          </Link>{' '}
          {formatDate(date)}
        </h2>
        <Link to={`${base}/attendance`} className="btn btn-sm">
          Add photos
        </Link>
      </div>
      <SessionView classId={cls.classId} date={date} detail={session.data} refetch={refetch} />
    </div>
  );
}

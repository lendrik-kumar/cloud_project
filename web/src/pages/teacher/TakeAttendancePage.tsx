import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  ApiError,
  DATE_PATTERN,
  errorMessage,
  formatDate,
  putToS3,
  resizeToJpeg,
  todayLocal,
  type SessionDetail,
} from '../../api';
import { useAuth, useMe } from '../../auth-context';
import { useUnmountSignal } from '../../hooks';
import { poll, PollAbortedError } from '../../poll';
import { PhotoPicker } from '../../components/PhotoPicker';
import { RekognitionCapNotice } from '../../components/RekognitionUsage';
import { SessionView } from '../../components/SessionView';
import { Alert, Spinner } from '../../components/ui';
import { useClass } from './class-context';

const MAX_PHOTOS = 3;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 90_000;

type Phase = 'select' | 'uploading' | 'processing' | 'done';
type FileStatus = { state: 'waiting' | 'resizing' | 'uploading' | 'uploaded' | 'failed'; error?: string };

/** GET the session, treating 404 ("no photo processed yet") as null. */
async function fetchSession(classId: string, date: string): Promise<SessionDetail | null> {
  try {
    return await api.getSession(classId, date);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export function TakeAttendancePage() {
  const { cls, reload: reloadClass } = useClass();
  const newSignal = useUnmountSignal();
  const me = useMe();
  const { reloadMe } = useAuth();
  const today = todayLocal();
  const [date, setDate] = useState(today);
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>('select');
  const [statuses, setStatuses] = useState<FileStatus[]>([]);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [expected, setExpected] = useState(0);
  const [baseline, setBaseline] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();

  // Seconds counter while photos are processing.
  useEffect(() => {
    if (phase !== 'processing') return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const setStatus = (i: number, s: FileStatus) =>
    setStatuses((prev) => prev.map((old, j) => (j === i ? s : old)));

  const reset = () => {
    setFiles([]);
    setStatuses([]);
    setDetail(null);
    setError(undefined);
    setWarning(undefined);
    setPhase('select');
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setWarning(undefined);
    if (!DATE_PATTERN.test(date)) {
      setError('Pick a valid date.');
      return;
    }
    if (files.length < 1 || files.length > MAX_PHOTOS) {
      setError(`Choose between 1 and ${MAX_PHOTOS} photos.`);
      return;
    }
    const signal = newSignal();
    const classId = cls.classId;

    // Photos already in this date's session (re-runs add to the same session).
    let before: SessionDetail | null;
    try {
      before = await fetchSession(classId, date);
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    const baseCount = before?.session.photos.length ?? 0;
    setBaseline(baseCount);
    setDetail(null);

    // 1) resize → get a pre-signed URL → PUT, for each photo in parallel
    setPhase('uploading');
    setStatuses(files.map(() => ({ state: 'waiting' })));
    const results = await Promise.all(
      files.map(async (file, i) => {
        try {
          setStatus(i, { state: 'resizing' });
          const jpeg = await resizeToJpeg(file);
          setStatus(i, { state: 'uploading' });
          const { uploadUrl, key } = await api.sessionUploadUrl(classId, date);
          await putToS3(uploadUrl, jpeg);
          setStatus(i, { state: 'uploaded' });
          return key;
        } catch (err) {
          setStatus(i, { state: 'failed', error: errorMessage(err) });
          return null;
        }
      }),
    );
    if (signal.aborted) return;
    const keys = results.filter((k): k is string => k !== null);
    if (keys.length === 0) {
      setError('No photo could be uploaded. Check the errors above and try again.');
      setPhase('select');
      return;
    }
    if (keys.length < files.length) {
      setWarning(`${files.length - keys.length} photo(s) failed to upload; continuing with ${keys.length}.`);
    }

    // 2) poll the session until every uploaded photo has been processed
    setExpected(keys.length);
    setElapsed(0);
    setPhase('processing');
    const target = baseCount + keys.length;
    try {
      const { value, timedOut } = await poll(() => fetchSession(classId, date), {
        intervalMs: POLL_INTERVAL_MS,
        timeoutMs: POLL_TIMEOUT_MS,
        signal,
        isDone: (v) => {
          if (!v) return false;
          const have = new Set(v.session.photos.map((p) => p.key));
          return keys.every((k) => have.has(k)) || v.session.photos.length >= target;
        },
        onUpdate: (v) => v && setDetail(v),
      });
      if (timedOut) {
        const got = Math.max(0, (value?.session.photos.length ?? 0) - baseCount);
        setWarning(
          `Only ${got} of ${keys.length} photo(s) were processed within ${POLL_TIMEOUT_MS / 1000} s. ` +
            'Results may be incomplete; open the session again in a minute.',
        );
      }
      setPhase('done');
      reloadClass();
      void reloadMe(); // processing used Rekognition; refresh the usage meter
    } catch (err) {
      if (err instanceof PollAbortedError) return;
      setError(`Lost track of processing: ${errorMessage(err)}`);
      setPhase('done');
    }
  };

  const refetch = async () => {
    const v = await fetchSession(cls.classId, date);
    if (v) setDetail(v);
  };

  const processed = Math.max(0, (detail?.session.photos.length ?? 0) - baseline);
  const sessionLink = `/classes/${encodeURIComponent(cls.classId)}/sessions/${date}`;

  return (
    <div className="stack">
      {phase === 'select' || phase === 'uploading' ? (
        <section className="card">
          <h2>Take attendance</h2>
          <p className="muted">
            Upload 1–{MAX_PHOTOS} photos of the classroom. Faces are matched against the{' '}
            {cls.studentIds.length} student{cls.studentIds.length === 1 ? '' : 's'} on this class’s roster.
          </p>
          {cls.studentIds.length === 0 && (
            <Alert kind="warn">
              This class has no students yet. <Link to={`/classes/${encodeURIComponent(cls.classId)}`}>Add students to the roster</Link>{' '}
              before taking attendance.
            </Alert>
          )}
          <RekognitionCapNotice usage={me.rekognitionUsage} action="attendance" />
          <form className="form" onSubmit={onSubmit}>
            <label className="field field-narrow">
              <span>Date</span>
              <input
                type="date"
                required
                max={today}
                value={date}
                disabled={phase !== 'select'}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <PhotoPicker
              files={files}
              onChange={(f) => {
                setFiles(f);
                setStatuses([]);
              }}
              max={MAX_PHOTOS}
              camera="environment"
              disabled={phase !== 'select'}
            />
            {statuses.length > 0 && (
              <ul className="upload-status">
                {statuses.map((s, i) => (
                  <li key={i} className={`upload-${s.state}`}>
                    {s.state === 'resizing' || s.state === 'uploading' ? <Spinner small /> : null}
                    <span>
                      Photo {i + 1}: {STATUS_TEXT[s.state]}
                      {s.error ? ` — ${s.error}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {error && <Alert>{error}</Alert>}
            <div className="actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={phase !== 'select' || files.length === 0}
              >
                {phase === 'uploading' && <Spinner small />}
                {phase === 'uploading' ? 'Uploading…' : `Upload ${files.length || ''} photo${files.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <section className="card">
          <div className="section-head">
            <h2>{formatDate(date)}</h2>
            <div className="actions">
              {phase === 'done' && (
                <>
                  <Link className="btn btn-sm" to={sessionLink}>
                    Open session page
                  </Link>
                  <button type="button" className="btn btn-sm btn-primary" onClick={reset}>
                    Upload more photos
                  </button>
                </>
              )}
            </div>
          </div>
          {phase === 'processing' && (
            <div className="processing" role="status">
              <Spinner />
              <div>
                <strong>
                  Recognising faces… {Math.min(processed, expected)} of {expected} photo
                  {expected === 1 ? '' : 's'} processed
                </strong>
                <p className="muted small">
                  Usually 3–15 s per photo · {elapsed} s elapsed
                  {baseline > 0 ? ` · adding to ${baseline} earlier photo${baseline === 1 ? '' : 's'} for this date` : ''}
                </p>
              </div>
            </div>
          )}
          {warning && <Alert kind="warn">{warning}</Alert>}
          {error && <Alert>{error}</Alert>}
          {phase === 'done' && !detail && !error && (
            <Alert kind="warn">No processed photos yet for this date. Try opening the session again shortly.</Alert>
          )}
        </section>
      )}

      {detail && (phase === 'processing' || phase === 'done') && (
        <SessionView classId={cls.classId} date={date} detail={detail} refetch={refetch} />
      )}
    </div>
  );
}

const STATUS_TEXT: Record<FileStatus['state'], string> = {
  waiting: 'waiting',
  resizing: 'resizing…',
  uploading: 'uploading…',
  uploaded: 'uploaded',
  failed: 'failed',
};

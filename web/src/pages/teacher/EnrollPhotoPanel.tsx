import { useRef, useState } from 'react';
import { api, errorMessage, putToS3, resizeToJpeg, type Student } from '../../api';
import { useAuth, useMe } from '../../auth-context';
import { useUnmountSignal } from '../../hooks';
import { poll, PollAbortedError } from '../../poll';
import { PhotoPicker } from '../../components/PhotoPicker';
import { RekognitionCapNotice } from '../../components/RekognitionUsage';
import { Alert, EnrollBadge, Spinner } from '../../components/ui';
import { enrollHint } from '../../enroll';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120_000;
/** Pre-signed URLs last 5 minutes; get a fresh one if ours is older than this. */
const URL_MAX_AGE_MS = 4 * 60_000;

type Props = {
  student: Student;
  /** URL returned by POST students, if this is a brand-new enrollment. */
  initialUploadUrl?: string;
  /** When `initialUploadUrl` was issued (ms since epoch). */
  uploadUrlIssuedAt?: number;
  onStudentUpdate: (s: Student) => void;
  onClose: () => void;
};

type Phase = 'pick' | 'uploading' | 'processing' | 'done';

export function EnrollPhotoPanel({ student, initialUploadUrl, uploadUrlIssuedAt = 0, onStudentUpdate, onClose }: Props) {
  const newSignal = useUnmountSignal();
  const me = useMe();
  const { reloadMe } = useAuth();
  const initial = useRef(initialUploadUrl ? { url: initialUploadUrl, at: uploadUrlIssuedAt } : null);
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>('pick');
  const [current, setCurrent] = useState<Student>(student);
  const [error, setError] = useState<string>();
  const [timedOut, setTimedOut] = useState(false);

  const upload = async () => {
    const file = files[0];
    if (!file) return;
    const signal = newSignal();
    setError(undefined);
    setTimedOut(false);
    setPhase('uploading');
    try {
      const jpeg = await resizeToJpeg(file);
      // Use the URL from enrollment once, if still fresh; otherwise ask for a new one
      // (which also resets the status to PENDING).
      let url: string;
      if (initial.current && Date.now() - initial.current.at < URL_MAX_AGE_MS) {
        url = initial.current.url;
      } else {
        url = await api.newStudentPhotoUrl(current.studentId);
      }
      initial.current = null;
      await putToS3(url, jpeg);
    } catch (err) {
      initial.current = null;
      setError(errorMessage(err));
      setPhase('pick');
      return;
    }

    setPhase('processing');
    const pending: Student = { ...current, enrollStatus: 'PENDING' };
    setCurrent(pending);
    onStudentUpdate(pending);
    try {
      const { value, timedOut: late } = await poll(() => api.getStudent(current.studentId), {
        intervalMs: POLL_INTERVAL_MS,
        timeoutMs: POLL_TIMEOUT_MS,
        signal,
        isDone: (s) => s.enrollStatus !== 'PENDING',
      });
      setCurrent(value);
      onStudentUpdate(value);
      setTimedOut(late);
      setPhase('done');
      void reloadMe(); // indexing used Rekognition; refresh the usage meter
    } catch (err) {
      if (err instanceof PollAbortedError) return;
      setError(`Could not check the enrollment status: ${errorMessage(err)}`);
      setPhase('done');
    }
  };

  const retake = () => {
    setFiles([]);
    setError(undefined);
    setTimedOut(false);
    setPhase('pick');
  };

  const ok = current.enrollStatus === 'INDEXED';

  return (
    <section className="card enroll-panel" aria-live="polite">
      <div className="section-head">
        <h2>Reference photo · {current.name}</h2>
        <button type="button" className="btn btn-sm" onClick={onClose} disabled={phase === 'uploading'}>
          {phase === 'done' ? 'Done' : 'Close'}
        </button>
      </div>
      <p className="muted small">
        <span className="mono">{current.studentId}</span> · status{' '}
        <EnrollBadge status={current.enrollStatus} error={current.enrollError} />
      </p>

      {(phase === 'pick' || phase === 'uploading') && (
        <>
          <RekognitionCapNotice usage={me.rekognitionUsage} action="enroll" />
          <p className="muted">
            One clear, front-facing photo of just this student: good light, no sunglasses or mask.
          </p>
          <PhotoPicker files={files} onChange={setFiles} max={1} camera="user" disabled={phase === 'uploading'} />
          {error && <Alert>{error}</Alert>}
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={files.length === 0 || phase === 'uploading'}
              onClick={() => void upload()}
            >
              {phase === 'uploading' && <Spinner small />}
              {phase === 'uploading' ? 'Uploading…' : 'Upload photo'}
            </button>
          </div>
        </>
      )}

      {phase === 'processing' && (
        <div className="processing" role="status">
          <Spinner />
          <div>
            <strong>Indexing face…</strong>
            <p className="muted small">Checking every 2 s. This usually takes a few seconds.</p>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <>
          {error && <Alert>{error}</Alert>}
          {timedOut ? (
            <Alert kind="warn">
              Still processing after {POLL_TIMEOUT_MS / 1000} s. Check the student list again later.
            </Alert>
          ) : ok ? (
            <Alert kind="success">Face enrolled. {current.name} can now be recognised in class photos.</Alert>
          ) : (
            !error && (
              <Alert kind="error">
                {current.enrollError || `${enrollHint(current.enrollStatus)}.`}
              </Alert>
            )
          )}
          <div className="actions">
            <button type="button" className={ok ? 'btn' : 'btn btn-primary'} onClick={retake}>
              Re-take photo
            </button>
          </div>
        </>
      )}
    </section>
  );
}

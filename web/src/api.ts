/**
 * Typed client for the CloudAttend REST API (see docs/api.md, the source of truth).
 * Every request carries the raw Cognito ID token in `Authorization` (no "Bearer").
 */
import { fetchAuthSession } from 'aws-amplify/auth';
import { getConfig } from './config';

// ---------- Types (mirrors docs/api.md) ----------

export type Role = 'teacher' | 'student';
export type EnrollStatus = 'PENDING' | 'INDEXED' | 'NO_FACE' | 'MULTIPLE_FACES' | 'ERROR';

export type Student = {
  studentId: string;
  name: string;
  email: string;
  enrollStatus: EnrollStatus;
  /** Why the status is NO_FACE / MULTIPLE_FACES / ERROR; null otherwise. */
  enrollError: string | null;
  subscribed: boolean;
};

export type Class = {
  classId: string;
  name: string;
  studentIds: string[];
  sessionCount: number;
};

export type Box = { left: number; top: number; width: number; height: number };

export type Face = {
  box: Box;
  studentId: string | null;
  similarity: number | null;
};

/** This month's Rekognition calls against the free-tier cap (teachers only). */
export type RekognitionUsage = { month: string; cap: number; group1: number; group2: number };

export type Me = {
  role: Role;
  email: string;
  studentId?: string;
  rekognitionUsage?: RekognitionUsage;
};

export type SessionSummary = {
  date: string;
  photoCount: number;
  facesDetected: number;
  presentCount: number;
};

export type SessionPhoto = {
  key: string;
  url: string;
  faces: Face[];
  /** e.g. monthly Rekognition cap reached, or only the N largest faces were checked. */
  note?: string;
};

export type PresentEntry = {
  studentId: string;
  name: string;
  source: 'auto' | 'manual';
  similarity: number | null;
};

export type AbsentEntry = { studentId: string; name: string };

export type SessionDetail = {
  session: {
    classId: string;
    date: string;
    facesDetected: number;
    photos: SessionPhoto[];
  };
  present: PresentEntry[];
  absent: AbsentEntry[];
};

export type ClassReport = {
  classId: string;
  name: string;
  threshold: number;
  totalSessions: number;
  sessions: { date: string; presentCount: number }[];
  students: {
    studentId: string;
    name: string;
    attended: number;
    total: number;
    pct: number;
    belowThreshold: boolean;
  }[];
};

export type StudentReport = {
  student: { studentId: string; name: string };
  threshold: number;
  classes: {
    classId: string;
    name: string;
    attended: number;
    total: number;
    pct: number;
    belowThreshold: boolean;
    sessionDates: string[];
    presentDates: string[];
  }[];
};

// ---------- Validation helpers ----------

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ---------- Core request ----------

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function getIdToken(): Promise<string> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) throw new ApiError(401, 'You are signed out. Please sign in again.');
  return token;
}

type Method = 'GET' | 'POST' | 'PUT';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const { apiUrl } = getConfig();
  const headers: Record<string, string> = { Authorization: await getIdToken() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(apiUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Network error: could not reach the CloudAttend API.');
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const obj = (data ?? {}) as { error?: unknown; message?: unknown };
    // Our Lambdas send { error }; API Gateway itself (e.g. the authorizer) sends { message }.
    const msg =
      (typeof obj.error === 'string' && obj.error) ||
      (typeof obj.message === 'string' && obj.message) ||
      `Request failed (HTTP ${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

const seg = encodeURIComponent;

// ---------- Routes ----------

export const api = {
  // Any signed-in user
  getMe: () => request<Me>('GET', 'me'),

  // Teacher: classes
  listClasses: () => request<{ classes: Class[] }>('GET', 'classes').then((r) => r.classes),
  createClass: (classId: string, name: string) =>
    request<{ class: Class }>('POST', 'classes', { classId, name }).then((r) => r.class),
  setRoster: (classId: string, studentIds: string[]) =>
    request<{ class: Class }>('PUT', `classes/${seg(classId)}/students`, { studentIds }).then(
      (r) => r.class,
    ),

  // Teacher: students
  listStudents: () => request<{ students: Student[] }>('GET', 'students').then((r) => r.students),
  createStudent: (input: { studentId: string; name: string; email: string }) =>
    request<{ student: Student; uploadUrl: string }>('POST', 'students', input),
  getStudent: (studentId: string) =>
    request<{ student: Student }>('GET', `students/${seg(studentId)}`).then((r) => r.student),
  newStudentPhotoUrl: (studentId: string) =>
    request<{ uploadUrl: string }>('POST', `students/${seg(studentId)}/photo-url`).then(
      (r) => r.uploadUrl,
    ),

  // Teacher: sessions
  sessionUploadUrl: (classId: string, date: string) =>
    request<{ uploadUrl: string; key: string }>(
      'POST',
      `classes/${seg(classId)}/sessions/${seg(date)}/upload-url`,
    ),
  listSessions: (classId: string) =>
    request<{ sessions: SessionSummary[] }>('GET', `classes/${seg(classId)}/sessions`).then(
      (r) => r.sessions,
    ),
  getSession: (classId: string, date: string) =>
    request<SessionDetail>('GET', `classes/${seg(classId)}/sessions/${seg(date)}`),
  setAttendance: (classId: string, date: string, studentId: string, present: boolean) =>
    request<{ studentId: string; present: boolean }>(
      'PUT',
      `classes/${seg(classId)}/sessions/${seg(date)}/attendance/${seg(studentId)}`,
      { present },
    ),

  // Reports
  classReport: (classId: string) =>
    request<ClassReport>('GET', `reports/class/${seg(classId)}`),
  studentReport: (studentId: string) =>
    request<StudentReport>('GET', `reports/student/${seg(studentId)}`),
};

// ---------- Photo helpers ----------

async function decodeImage(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if ('createImageBitmap' in window) {
    try {
      // 'from-image' bakes EXIF rotation in, so face-box ratios match what we display.
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // fall through to <img>, which some browsers decode more formats with (e.g. HEIC on Safari)
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('Could not read this image. Please use a JPEG or PNG photo.');
  }
}

/** Downscale so the longest side is at most `maxSide` px and re-encode as JPEG. */
export async function resizeToJpeg(file: Blob, maxSide = 1920, quality = 0.85): Promise<Blob> {
  const img = await decodeImage(file);
  try {
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot process images (no canvas support).');
    ctx.fillStyle = '#fff'; // transparent PNG areas would otherwise turn black
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img.source, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the photo as JPEG.'))),
        'image/jpeg',
        quality,
      ),
    );
  } finally {
    img.close();
  }
}

/** PUT a JPEG to a pre-signed S3 URL. The content type must match the signature. */
export async function putToS3(uploadUrl: string, blob: Blob): Promise<void> {
  let res: Response;
  try {
    res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
    });
  } catch {
    throw new Error('Upload failed: could not reach S3 (network or CORS error).');
  }
  if (!res.ok) {
    const detail = res.status === 403 ? ' The upload link may have expired; please try again.' : '';
    throw new Error(`Upload failed (HTTP ${res.status}).${detail}`);
  }
}

// ---------- Misc ----------

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Today's date as YYYY-MM-DD in the browser's local time zone (not UTC). */
export function todayLocal(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function formatDate(date: string): string {
  // Parse as a local calendar date to avoid UTC off-by-one.
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

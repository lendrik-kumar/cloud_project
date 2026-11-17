import type { EnrollStatus } from './api';

export const ENROLL_LABELS: Record<EnrollStatus, { label: string; tone: 'good' | 'bad' | 'neutral'; hint: string }> = {
  PENDING: { label: 'Processing', tone: 'neutral', hint: 'Waiting for the reference photo to be indexed' },
  INDEXED: { label: 'Enrolled', tone: 'good', hint: 'Face indexed; the student can be recognised' },
  NO_FACE: { label: 'No face found', tone: 'bad', hint: 'No face was detected; re-take the photo' },
  MULTIPLE_FACES: { label: 'Multiple faces', tone: 'bad', hint: 'More than one face; re-take with only the student' },
  ERROR: { label: 'Error', tone: 'bad', hint: 'Indexing failed; re-take the photo' },
};

export function enrollHint(status: EnrollStatus): string {
  return ENROLL_LABELS[status]?.hint ?? '';
}

import { sleep } from './api';

export class PollAbortedError extends Error {
  constructor() {
    super('Polling stopped');
    this.name = 'PollAbortedError';
  }
}

export type PollOptions<T> = {
  intervalMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
  isDone: (value: T) => boolean;
  onUpdate?: (value: T) => void;
};

/**
 * Call `fn` every `intervalMs` until `isDone(value)` or the timeout. Errors from
 * `fn` stop polling (make `fn` swallow "keep going" errors such as a 404).
 */
export async function poll<T>(
  fn: () => Promise<T>,
  { intervalMs, timeoutMs, signal, isDone, onUpdate }: PollOptions<T>,
): Promise<{ value: T; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new PollAbortedError();
    const value = await fn();
    if (signal?.aborted) throw new PollAbortedError();
    onUpdate?.(value);
    if (isDone(value)) return { value, timedOut: false };
    if (Date.now() + intervalMs > deadline) return { value, timedOut: true };
    await sleep(intervalMs);
  }
}

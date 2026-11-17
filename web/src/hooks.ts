import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { errorMessage } from './api';

export type AsyncState<T> = {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
  /** Replace the data, or derive it from the latest value. */
  setData: (data: T | ((prev: T | undefined) => T)) => void;
};

type Settled<T> = { key: string; nonce: number; data?: T; error?: string };

/**
 * Run `fn` on mount and whenever `key` changes; `reload()` re-runs it and keeps
 * the old data visible meanwhile. Results of superseded runs are dropped.
 */
export function useAsync<T>(fn: () => Promise<T>, key: string): AsyncState<T> {
  const [nonce, setNonce] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const run = useEffectEvent(fn);

  useEffect(() => {
    let cancelled = false;
    run().then(
      (data) => {
        if (!cancelled) setSettled({ key, nonce, data });
      },
      (err: unknown) => {
        if (cancelled) return;
        setSettled((prev) => ({
          key,
          nonce,
          data: prev?.key === key ? prev.data : undefined,
          error: errorMessage(err),
        }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  const sameKey = settled?.key === key;
  const current = sameKey && settled.nonce === nonce;
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback(
    (d: T | ((prev: T | undefined) => T)) =>
      setSettled((prev) => {
        const old = prev?.key === key ? prev.data : undefined;
        const data = typeof d === 'function' ? (d as (p: T | undefined) => T)(old) : d;
        return { key, nonce: prev?.key === key ? prev.nonce : nonce, data };
      }),
    [key, nonce],
  );

  return {
    data: sameKey ? settled.data : undefined,
    error: current ? settled.error : undefined,
    loading: !current,
    reload,
    setData,
  };
}

/**
 * Returns a factory for AbortSignals that are all aborted when the component
 * unmounts. Use one per long-running operation (polling loops).
 */
export function useUnmountSignal(): () => AbortSignal {
  const controllers = useRef(new Set<AbortController>());
  useEffect(() => {
    const set = controllers.current;
    return () => {
      set.forEach((c) => c.abort());
      set.clear();
    };
  }, []);
  return useCallback(() => {
    const ctrl = new AbortController();
    controllers.current.add(ctrl);
    return ctrl.signal;
  }, []);
}

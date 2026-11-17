import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Hub } from 'aws-amplify/utils';
import { fetchAuthSession, signOut as amplifySignOut } from 'aws-amplify/auth';
import { api, ApiError, errorMessage } from './api';
import { AuthContext, type AuthState } from './auth-context';

/** Read the Cognito session, then ask the API who we are (`GET me`). */
async function resolveAuth(): Promise<AuthState> {
  let hasToken = false;
  try {
    const session = await fetchAuthSession();
    hasToken = !!session.tokens?.idToken;
  } catch {
    hasToken = false; // e.g. the refresh token has expired
  }
  if (!hasToken) return { status: 'signedOut' };
  try {
    return { status: 'signedIn', me: await api.getMe() };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return { status: 'signedOut' };
    const message =
      err instanceof ApiError && err.status === 403
        ? 'Your account is not assigned to the teacher or student group yet. Ask an administrator to add it.'
        : errorMessage(err);
    return { status: 'error', message };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    setState({ status: 'loading' });
    setState(await resolveAuth());
  }, []);

  const reloadMe = useCallback(async () => {
    try {
      const me = await api.getMe();
      setState((s) => (s.status === 'signedIn' ? { status: 'signedIn', me } : s));
    } catch {
      // Background refresh only; keep the current profile.
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await amplifySignOut();
    } finally {
      setState({ status: 'signedOut' });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    resolveAuth().then((s) => {
      if (!cancelled) setState(s);
    });
    const stopListening = Hub.listen('auth', ({ payload }) => {
      if (payload.event === 'signedOut' || payload.event === 'tokenRefresh_failure') {
        setState({ status: 'signedOut' });
      }
    });
    return () => {
      cancelled = true;
      stopListening();
    };
  }, []);

  const value = useMemo(
    () => ({ state, refresh, reloadMe, signOut }),
    [state, refresh, reloadMe, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

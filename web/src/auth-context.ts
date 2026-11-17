import { createContext, useContext } from 'react';
import type { Me } from './api';

export type AuthState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; me: Me }
  /** Signed in with Cognito, but the API refused or failed `GET me`. */
  | { status: 'error'; message: string };

export type AuthContextValue = {
  state: AuthState;
  /** Re-read the Cognito session and `GET me` (call after a successful sign-in). */
  refresh: () => Promise<void>;
  /** Re-fetch `GET me` in the background (e.g. to update Rekognition usage). */
  reloadMe: () => Promise<void>;
  signOut: () => Promise<void>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** The signed-in user's profile; only call from pages rendered behind the sign-in gate. */
export function useMe(): Me {
  const { state } = useAuth();
  if (state.status !== 'signedIn') throw new Error('useMe called while signed out');
  return state.me;
}

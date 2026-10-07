import type { SessionResponse } from '@running-tracker/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { onAuthenticationRequired } from './request.js';
import { endSession, loadSession, RunnerApiError } from './runner-api.js';

// Why there is no session: nobody signed in yet, the session ran out or was refused, or the person signed out.
export type SessionEnd = 'expired' | 'none' | 'signed-out';

export type SessionState =
  | { status: 'loading' }
  | { message: string; reason: SessionEnd; status: 'required' }
  | { session: SessionResponse; signal: AbortSignal; status: 'ready' };

export type SignOutState =
  | { status: 'idle' }
  | { status: 'working' }
  | { message: string; status: 'failed' };

export const sessionEndMessages: Readonly<Record<SessionEnd, string>> = {
  expired: 'Your session ended. Sign in again to continue; anything not yet uploaded stays on this device.',
  none: 'Sign in with your organization account to record and view runs.',
  'signed-out':
    'You are signed out. Anything not yet uploaded stays on this device until you sign in again as the same person.',
};

const endRank: Readonly<Record<SessionEnd, number>> = { none: 0, expired: 1, 'signed-out': 2 };

// The most specific reason wins until a session is ready again: a focus check or a late 401 after an explicit
// sign-out must not turn "You are signed out" back into "Your session ended".
export function nextSessionEnd(previous: SessionState, reason: SessionEnd): SessionEnd {
  return previous.status === 'required' && endRank[previous.reason] > endRank[reason]
    ? previous.reason
    : reason;
}

function signOutFailure(error: unknown): string {
  const detail = error instanceof RunnerApiError
    ? `${error.message} (${error.code}).`
    : 'The server could not be reached.';
  return `Could not sign out. ${detail} You are still signed in.`;
}

export function useRunnerSession(onSuspend: () => void, onSignedOut: () => void) {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  const [signOutState, setSignOutState] = useState<SignOutState>({ status: 'idle' });
  const currentSession = useRef<SessionResponse | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const check = useRef<AbortController | null>(null);
  const signingOut = useRef(false);
  const suspend = useCallback((reason: SessionEnd) => {
    check.current?.abort();
    currentSession.current = null;
    lifetime.current?.abort();
    onSuspend();
    setSession((previous) => {
      const end = nextSessionEnd(previous, reason);
      return { message: sessionEndMessages[end], reason: end, status: 'required' };
    });
  }, [onSuspend]);

  const refreshSession = useCallback(async () => {
    check.current?.abort();
    const controller = new AbortController();
    check.current = controller;
    try {
      const next = await loadSession(controller.signal);
      if (controller.signal.aborted) return;
      if (Date.parse(next.expiresAt) <= Date.now()) { suspend('expired'); return; }
      const previous = currentSession.current;
      if (previous?.identity.userId === next.identity.userId && previous.expiresAt === next.expiresAt
        && previous.csrf.token === next.csrf.token && !lifetime.current?.signal.aborted) return;
      lifetime.current?.abort();
      onSuspend();
      lifetime.current = new AbortController();
      currentSession.current = next;
      setSignOutState({ status: 'idle' });
      setSession({ session: next, signal: lifetime.current.signal, status: 'ready' });
    } catch {
      if (!controller.signal.aborted) suspend(currentSession.current === null ? 'none' : 'expired');
    }
  }, [onSuspend, suspend]);

  // Ends the server session first and only then the local one: a failed request leaves the person signed in,
  // with the reason, instead of looking signed out while the cookie still works. Nothing durable is touched
  // here; the recovery data in IndexedDB belongs to the identity and survives for its next sign-in.
  const signOut = useCallback(async () => {
    const current = currentSession.current;
    if (current === null || signingOut.current) return;
    signingOut.current = true;
    setSignOutState({ status: 'working' });
    try {
      await endSession(current.csrf);
    } catch (error) {
      // A 401 means the server session is already gone, which is the state the person asked for.
      if (!(error instanceof RunnerApiError && error.status === 401)) {
        signingOut.current = false;
        setSignOutState({ message: signOutFailure(error), status: 'failed' });
        return;
      }
    }
    signingOut.current = false;
    setSignOutState({ status: 'idle' });
    suspend('signed-out');
    onSignedOut();
  }, [onSignedOut, suspend]);

  useEffect(() => {
    const unsubscribe = onAuthenticationRequired(() => suspend('expired'));
    void refreshSession();
    const focus = () => { void refreshSession(); };
    const visible = () => { if (document.visibilityState === 'visible') focus(); };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visible);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visible);
      check.current?.abort();
      lifetime.current?.abort();
    };
  }, [refreshSession, suspend]);

  useEffect(() => {
    if (session.status !== 'ready') return;
    const timer = setTimeout(() => suspend('expired'), Math.max(0, Date.parse(session.session.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [session, suspend]);
  return { refreshSession, session, signOut, signOutState };
}

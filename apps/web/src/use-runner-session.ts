import type { SessionResponse } from '@running-tracker/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { onAuthenticationRequired } from './request.js';
import { loadSession } from './runner-api.js';

export type SessionState =
  | { status: 'loading' }
  | { message: string; status: 'required' }
  | { session: SessionResponse; signal: AbortSignal; status: 'ready' };

export function useRunnerSession(onSuspend: () => void) {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  const currentSession = useRef<SessionResponse | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const check = useRef<AbortController | null>(null);
  const suspend = useCallback(() => {
    check.current?.abort();
    currentSession.current = null;
    lifetime.current?.abort();
    onSuspend();
    setSession({ message: 'A session is required: sign in, or create the local development session.', status: 'required' });
  }, [onSuspend]);

  const refreshSession = useCallback(async () => {
    check.current?.abort();
    const controller = new AbortController();
    check.current = controller;
    try {
      const next = await loadSession(controller.signal);
      if (controller.signal.aborted) return;
      if (Date.parse(next.expiresAt) <= Date.now()) { suspend(); return; }
      const previous = currentSession.current;
      if (previous?.identity.userId === next.identity.userId && previous.expiresAt === next.expiresAt
        && previous.csrf.token === next.csrf.token && !lifetime.current?.signal.aborted) return;
      lifetime.current?.abort();
      onSuspend();
      lifetime.current = new AbortController();
      currentSession.current = next;
      setSession({ session: next, signal: lifetime.current.signal, status: 'ready' });
    } catch {
      if (!controller.signal.aborted) suspend();
    }
  }, [onSuspend, suspend]);

  useEffect(() => {
    const unsubscribe = onAuthenticationRequired(suspend);
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
    const timer = setTimeout(suspend, Math.max(0, Date.parse(session.session.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [session, suspend]);
  return { refreshSession, session };
}

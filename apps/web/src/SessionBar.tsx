import type { SessionState, SignOutState } from './use-runner-session.js';

interface SessionBarProps {
  onRetry: () => void;
  onSignOut: () => void;
  session: SessionState;
  signOut: SignOutState;
  // Said next to the button when signing out would leave something behind on this device; null when nothing is.
  unsentNote: string | null;
}

// What the person needs from their session: whether they are signed in, the way to sign out, and what signing
// out does to unsent work. The user and expiry are developer diagnostics and stay behind a disclosure.
export function SessionBar({ onRetry, onSignOut, session, signOut, unsentNote }: SessionBarProps) {
  return (
    <section className={`session-bar session-bar--${session.status}`} aria-label="Session" aria-live="polite">
      {session.status === 'loading' && <span>Checking session…</span>}
      {session.status === 'ready' && (
        <>
          <span className="session-state"><i className="dot dot--up" aria-hidden="true" />Signed in</span>
          <details className="session-details">
            <summary>Session details</summary>
            <span>
              user {session.session.identity.userId.slice(0, 8)} · expires {new Date(session.session.expiresAt).toLocaleTimeString()}
            </span>
          </details>
          <button disabled={signOut.status === 'working'} onClick={onSignOut} type="button">
            {signOut.status === 'working' ? 'Signing out…' : 'Sign out'}
          </button>
          {unsentNote !== null && <span className="session-note">{unsentNote}</span>}
          {signOut.status === 'failed' && <span className="session-failure" role="alert">{signOut.message}</span>}
        </>
      )}
      {session.status === 'required' && (
        <>
          <span>Not signed in</span>
          <button onClick={onRetry} type="button">Retry session</button>
        </>
      )}
    </section>
  );
}

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SessionBar } from './SessionBar.js';
import type { SessionState, SignOutState } from './use-runner-session.js';

const noop = () => undefined;
const ready = {
  session: {
    csrf: { headerName: 'x-csrf-token', token: 'a'.repeat(43) },
    expiresAt: '2026-10-06T12:00:00.000Z',
    identity: { userId: '11111111-1111-4111-8111-111111111111' },
  },
  signal: new AbortController().signal,
  status: 'ready',
} satisfies SessionState;

function render(session: SessionState, signOut: SignOutState = { status: 'idle' }, unsentNote: string | null = null) {
  return renderToStaticMarkup(
    <SessionBar onRetry={noop} onSignOut={noop} session={session} signOut={signOut} unsentNote={unsentNote} />,
  );
}

describe('SessionBar', () => {
  it('says the person is signed in and offers Sign out, with diagnostics behind a disclosure', () => {
    const markup = render(ready);

    expect(markup).toContain('Signed in');
    expect(markup).toContain('Sign out');
    expect(markup).toMatch(/<details[^>]*>\s*<summary>Session details<\/summary>/u);
    expect(markup).toContain('user 11111111');
    expect(markup).not.toContain('Session ready');
  });

  it('disables the button while the server is ending the session', () => {
    const markup = render(ready, { status: 'working' });

    expect(markup).toContain('Signing out…');
    expect(markup).toContain('disabled=""');
  });

  it('keeps the person signed in, and says why, when sign-out failed', () => {
    const markup = render(ready, { message: 'Could not sign out. You are still signed in.', status: 'failed' });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('You are still signed in.');
  });

  it('shows what signing out leaves behind only when there is something', () => {
    expect(render(ready)).not.toContain('session-note');
    expect(render(ready, { status: 'idle' }, 'Unsent data stays on this device.')).toContain('Unsent data stays on this device.');
  });

  it('shows the not-signed-in state without a Sign out button', () => {
    const markup = render({ message: 'You are signed out.', reason: 'signed-out', status: 'required' });

    expect(markup).toContain('Not signed in');
    expect(markup).not.toContain('Sign out');
    expect(markup).toContain('Retry session');
  });
});

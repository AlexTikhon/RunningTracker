import { describe, expect, it } from 'vitest';

import { nextSessionEnd, sessionEndMessages, type SessionState } from './use-runner-session.js';

const ready = {
  session: {
    csrf: { headerName: 'x-csrf-token', token: 'a'.repeat(43) },
    expiresAt: '2026-10-06T12:00:00.000Z',
    identity: { userId: '11111111-1111-4111-8111-111111111111' },
  },
  signal: new AbortController().signal,
  status: 'ready',
} satisfies SessionState;

function required(reason: 'expired' | 'none' | 'signed-out' | 'unreachable'): SessionState {
  return { message: sessionEndMessages[reason], reason, status: 'required' };
}

describe('nextSessionEnd', () => {
  it('uses the reason it is given when a session was ready or still loading', () => {
    expect(nextSessionEnd(ready, 'expired')).toBe('expired');
    expect(nextSessionEnd({ status: 'loading' }, 'none')).toBe('none');
    expect(nextSessionEnd(ready, 'signed-out')).toBe('signed-out');
  });

  it('keeps an explicit sign-out through later focus checks and late 401 answers', () => {
    expect(nextSessionEnd(required('signed-out'), 'none')).toBe('signed-out');
    expect(nextSessionEnd(required('signed-out'), 'expired')).toBe('signed-out');
  });

  it('keeps "expired" over a failed re-check, and lets a more specific reason replace a weaker one', () => {
    expect(nextSessionEnd(required('expired'), 'none')).toBe('expired');
    expect(nextSessionEnd(required('none'), 'expired')).toBe('expired');
    expect(nextSessionEnd(required('expired'), 'signed-out')).toBe('signed-out');
  });
});

describe('nextSessionEnd and an unreachable server', () => {
  it('never turns a known ending into "unreachable", and lets the real answer replace "unreachable"', () => {
    expect(nextSessionEnd(required('expired'), 'unreachable')).toBe('expired');
    expect(nextSessionEnd(required('signed-out'), 'unreachable')).toBe('signed-out');
    expect(nextSessionEnd(required('unreachable'), 'none')).toBe('none');
    expect(nextSessionEnd(required('unreachable'), 'expired')).toBe('expired');
    expect(nextSessionEnd({ status: 'loading' }, 'unreachable')).toBe('unreachable');
  });

  it('says the server could not be reached, not that the session ended', () => {
    expect(sessionEndMessages.unreachable).toContain('could not be reached');
    expect(sessionEndMessages.unreachable).not.toMatch(/ended|expired/iu);
    expect(sessionEndMessages.unreachable).toContain('stays on this device');
  });
});

describe('session end messages', () => {
  it('tell the person what happens to unsent data and never mention internals', () => {
    for (const message of Object.values(sessionEndMessages)) {
      expect(message).not.toMatch(/development|csrf|cookie|token/iu);
    }
    expect(sessionEndMessages['signed-out']).toContain('stays on this device');
    expect(sessionEndMessages.expired).toContain('stays on this device');
  });
});

import type { SessionResponse } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { RunnerApiError } from './runner-api.js';
import {
  classifySessionFailure,
  decideSessionTransition,
  SESSION_RETRY_MS,
  sessionRetryDelay,
  SessionChecker,
  type SessionCheckResult,
} from './session-revalidation.js';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const userA = '11111111-1111-4111-8111-111111111111';

function session(overrides: { expiresAt?: string; token?: string; userId?: string } = {}): SessionResponse {
  return {
    csrf: { headerName: 'x-csrf-token', token: (overrides.token ?? 'a').repeat(43) },
    expiresAt: overrides.expiresAt ?? '2026-10-07T13:00:00.000Z',
    identity: { userId: overrides.userId ?? userA },
  };
}

function apiError(status: number, code = 'HTTP_ERROR', retryAfterMs: number | null = null): RunnerApiError {
  return new RunnerApiError('failed', status, code, null, retryAfterMs);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, reject, resolve };
}

describe('classifySessionFailure', () => {
  it('treats only a 401 from the session endpoint as the server saying the session is gone', () => {
    expect(classifySessionFailure(apiError(401, 'AUTH_REQUIRED'))).toBe('invalid');
    expect(classifySessionFailure(apiError(401))).toBe('invalid');
  });

  it.each([408, 425, 429, 500, 502, 503, 504])('treats HTTP %i as "could not verify", never as invalid', (status) => {
    expect(classifySessionFailure(apiError(status))).toBe('unverifiable');
  });

  it('does not read a 403 as session loss: GET /api/session never answers it, so it is not an answer about this session', () => {
    expect(classifySessionFailure(apiError(403, 'ORIGIN_DENIED'))).toBe('unverifiable');
    expect(classifySessionFailure(apiError(403, 'CSRF_DENIED'))).toBe('unverifiable');
  });

  it('treats a network failure, a request deadline and an unreadable 200 as "could not verify"', () => {
    expect(classifySessionFailure(new TypeError('Failed to fetch'))).toBe('unverifiable');
    expect(classifySessionFailure(new DOMException('Request deadline exceeded', 'TimeoutError'))).toBe('unverifiable');
    expect(classifySessionFailure(new DOMException('Request cancelled', 'AbortError'))).toBe('unverifiable');
    expect(classifySessionFailure(new SyntaxError('Unexpected token <'))).toBe('unverifiable');
    expect(classifySessionFailure(new Error('schema mismatch'))).toBe('unverifiable');
  });
});

describe('decideSessionTransition', () => {
  const current = session();

  it('confirms a valid, unexpired answer', () => {
    const next = session({ token: 'b' });
    expect(decideSessionTransition({ kind: 'confirmed', session: next }, current, NOW)).toEqual({ kind: 'confirm', session: next });
    expect(decideSessionTransition({ kind: 'confirmed', session: next }, null, NOW)).toEqual({ kind: 'confirm', session: next });
  });

  it('ends the session when the server confirms one that has already run out', () => {
    const next = session({ expiresAt: '2026-10-07T12:00:00.000Z' });
    expect(decideSessionTransition({ kind: 'confirmed', session: next }, current, NOW)).toEqual({ kind: 'end', reason: 'expired' });
  });

  it('ends a known session on an authoritative invalid answer, and says "none" when there never was one', () => {
    expect(decideSessionTransition({ kind: 'invalid' }, current, NOW)).toEqual({ kind: 'end', reason: 'expired' });
    expect(decideSessionTransition({ kind: 'invalid' }, null, NOW)).toEqual({ kind: 'end', reason: 'none' });
  });

  it('keeps a known, unexpired session when verification is unavailable, and remembers when to retry', () => {
    expect(decideSessionTransition({ kind: 'unverifiable', retryAfterMs: null }, current, NOW)).toEqual({ kind: 'degrade', retryAfterMs: null });
    expect(decideSessionTransition({ kind: 'unverifiable', retryAfterMs: 90_000 }, current, NOW)).toEqual({ kind: 'degrade', retryAfterMs: 90_000 });
  });

  it('still enforces the known expiry when verification is unavailable (no immortal session)', () => {
    const expiring = session({ expiresAt: '2026-10-07T12:00:30.000Z' });
    const unverifiable: SessionCheckResult = { kind: 'unverifiable', retryAfterMs: null };
    expect(decideSessionTransition(unverifiable, expiring, NOW)).toEqual({ kind: 'degrade', retryAfterMs: null });
    expect(decideSessionTransition(unverifiable, expiring, Date.parse('2026-10-07T12:00:30.000Z'))).toEqual({ kind: 'end', reason: 'expired' });
    expect(decideSessionTransition(unverifiable, expiring, Date.parse('2026-10-07T12:05:00.000Z'))).toEqual({ kind: 'end', reason: 'expired' });
  });

  it('does not manufacture a session at startup: with nothing confirmed before, "could not verify" is not signed in', () => {
    expect(decideSessionTransition({ kind: 'unverifiable', retryAfterMs: null }, null, NOW)).toEqual({ kind: 'end', reason: 'unreachable' });
  });

  it('ignores a superseded answer', () => {
    expect(decideSessionTransition({ kind: 'stale' }, current, NOW)).toEqual({ kind: 'ignore' });
    expect(decideSessionTransition({ kind: 'stale' }, null, NOW)).toEqual({ kind: 'ignore' });
  });
});

describe('sessionRetryDelay', () => {
  it('retries on a fixed cadence and never sooner than the server asked for', () => {
    expect(sessionRetryDelay(null)).toBe(SESSION_RETRY_MS);
    expect(sessionRetryDelay(1_000)).toBe(SESSION_RETRY_MS);
    expect(sessionRetryDelay(SESSION_RETRY_MS + 45_000)).toBe(SESSION_RETRY_MS + 45_000);
  });
});

describe('SessionChecker attempt fencing', () => {
  function checker() {
    const calls: Array<{ result: ReturnType<typeof deferred<SessionResponse>>; signal: AbortSignal }> = [];
    const instance = new SessionChecker((signal) => {
      const result = deferred<SessionResponse>();
      calls.push({ result, signal });
      return result.promise;
    });
    return { calls, instance };
  }

  it('reports a valid answer as confirmed', async () => {
    const { calls, instance } = checker();
    const pending = instance.check();
    const next = session();
    calls[0]?.result.resolve(next);
    await expect(pending).resolves.toEqual({ kind: 'confirmed', session: next });
  });

  it('reports an authoritative 401 as invalid and a 503 as unverifiable, with its Retry-After', async () => {
    const { calls, instance } = checker();
    const invalid = instance.check();
    calls[0]?.result.reject(apiError(401, 'AUTH_REQUIRED'));
    await expect(invalid).resolves.toEqual({ kind: 'invalid' });

    const unavailable = instance.check();
    calls[1]?.result.reject(apiError(503, 'HTTP_ERROR', 7_000));
    await expect(unavailable).resolves.toEqual({ kind: 'unverifiable', retryAfterMs: 7_000 });
  });

  it('A starts, B starts, B is valid, A fails later: the newer valid answer stands and A is ignored', async () => {
    const { calls, instance } = checker();
    const a = instance.check();
    const b = instance.check();
    const valid = session({ token: 'b' });
    calls[1]?.result.resolve(valid);
    await expect(b).resolves.toEqual({ kind: 'confirmed', session: valid });
    calls[0]?.result.reject(new TypeError('Failed to fetch'));
    await expect(a).resolves.toEqual({ kind: 'stale' });
  });

  it('A starts, B starts, B is authoritatively invalid, A succeeds later: the invalid answer stands and A is ignored', async () => {
    const { calls, instance } = checker();
    const a = instance.check();
    const b = instance.check();
    calls[1]?.result.reject(apiError(401, 'AUTH_REQUIRED'));
    await expect(b).resolves.toEqual({ kind: 'invalid' });
    calls[0]?.result.resolve(session());
    await expect(a).resolves.toEqual({ kind: 'stale' });
  });

  it('ignores an older answer that arrives before the newer one, even when the transport ignored the abort', async () => {
    const { calls, instance } = checker();
    const a = instance.check();
    const b = instance.check();
    expect(calls[0]?.signal.aborted).toBe(true);
    calls[0]?.result.resolve(session({ token: 'a' }));
    await expect(a).resolves.toEqual({ kind: 'stale' });
    const newer = session({ token: 'b' });
    calls[1]?.result.resolve(newer);
    await expect(b).resolves.toEqual({ kind: 'confirmed', session: newer });
  });

  it('A fails transiently, then B succeeds: the later success is what the caller sees', async () => {
    const { calls, instance } = checker();
    const a = instance.check();
    calls[0]?.result.reject(apiError(503));
    await expect(a).resolves.toEqual({ kind: 'unverifiable', retryAfterMs: null });
    const b = instance.check();
    const valid = session();
    calls[1]?.result.resolve(valid);
    await expect(b).resolves.toEqual({ kind: 'confirmed', session: valid });
  });

  it('a superseded check that was cancelled is stale, not unverifiable (cancelling is not a network failure)', async () => {
    const { calls, instance } = checker();
    const a = instance.check();
    void instance.check();
    calls[0]?.result.reject(new DOMException('Request cancelled', 'AbortError'));
    await expect(a).resolves.toEqual({ kind: 'stale' });
  });

  it('cancel() drops whatever is in flight, so a late answer after sign-out or unmount cannot revive a session', async () => {
    const { calls, instance } = checker();
    const pending = instance.check();
    instance.cancel();
    expect(calls[0]?.signal.aborted).toBe(true);
    calls[0]?.result.resolve(session());
    await expect(pending).resolves.toEqual({ kind: 'stale' });
  });
});

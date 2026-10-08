import type { SessionResponse } from '@running-tracker/contracts';

import { RunnerApiError } from './runner-api.js';
import type { SessionEnd } from './use-runner-session.js';

// Re-checking a session the page already holds (ADR-0054). Three answers are kept apart because they mean different
// things: the server confirmed the session, the server said it is gone, or no answer could be had. The last one says
// nothing about the session, so it must never end it; only the known expiry can.

export const SESSION_RETRY_MS = 30_000;

export type SessionCheckResult =
  | { kind: 'confirmed'; session: SessionResponse }
  | { kind: 'invalid' }
  | { kind: 'unverifiable'; retryAfterMs: number | null }
  // A newer check was started (or the page stopped checking) after this one, so what it found is no longer news.
  | { kind: 'stale' };

export type SessionTransition =
  | { kind: 'confirm'; session: SessionResponse }
  | { kind: 'degrade'; retryAfterMs: number | null }
  | { kind: 'end'; reason: SessionEnd }
  | { kind: 'ignore' };

// GET /api/session answers 200 or 401 AUTH_REQUIRED and nothing else about the session itself. A 401 is the server
// refusing this session (the same rule the page applies to every request). Everything else is an unreadable answer:
// an unreachable server, a deadline, a 5xx or 429, a gateway's 403, a body that is not the contract. None of it is
// evidence that the session ended, so a known-good session stays good until its own expiry.
export function classifySessionFailure(error: unknown): 'invalid' | 'unverifiable' {
  return error instanceof RunnerApiError && error.status === 401 ? 'invalid' : 'unverifiable';
}

export function sessionRetryDelay(retryAfterMs: number | null): number {
  return Math.max(SESSION_RETRY_MS, retryAfterMs ?? 0);
}

// What a finished check means for the session the page currently holds (null when it holds none). Pure: the caller
// supplies the clock.
export function decideSessionTransition(
  result: SessionCheckResult,
  current: SessionResponse | null,
  now: number,
): SessionTransition {
  switch (result.kind) {
    case 'stale':
      return { kind: 'ignore' };
    case 'confirmed':
      return Date.parse(result.session.expiresAt) <= now
        ? { kind: 'end', reason: 'expired' }
        : { kind: 'confirm', session: result.session };
    case 'invalid':
      return { kind: 'end', reason: current === null ? 'none' : 'expired' };
    case 'unverifiable':
      // Nothing was ever confirmed here, so nothing can be kept: do not claim a session from silence.
      if (current === null) return { kind: 'end', reason: 'unreachable' };
      // A silent server is not an extension: the expiry the server gave still applies without it.
      return Date.parse(current.expiresAt) <= now
        ? { kind: 'end', reason: 'expired' }
        : { kind: 'degrade', retryAfterMs: result.retryAfterMs };
  }
}

// Orders session checks. Only the newest check may speak: starting one cancels the one before it, and an answer
// that still arrives from an older one (a transport can ignore the cancellation) is reported as stale. The attempt
// number, not the abort signal, is what keeps an old answer from overwriting a newer one.
export class SessionChecker {
  readonly #load: (signal: AbortSignal) => Promise<SessionResponse>;
  #attempt = 0;
  #controller: AbortController | null = null;

  public constructor(load: (signal: AbortSignal) => Promise<SessionResponse>) {
    this.#load = load;
  }

  public async check(): Promise<SessionCheckResult> {
    this.#controller?.abort();
    const attempt = ++this.#attempt;
    const controller = new AbortController();
    this.#controller = controller;
    try {
      const session = await this.#load(controller.signal);
      return attempt === this.#attempt ? { kind: 'confirmed', session } : { kind: 'stale' };
    } catch (error) {
      if (attempt !== this.#attempt) return { kind: 'stale' };
      return classifySessionFailure(error) === 'invalid'
        ? { kind: 'invalid' }
        : { kind: 'unverifiable', retryAfterMs: error instanceof RunnerApiError ? error.retryAfterMs : null };
    }
  }

  // Nothing in flight may speak any more: the session was ended on purpose, or the page is going away.
  public cancel(): void {
    this.#attempt += 1;
    this.#controller?.abort();
    this.#controller = null;
  }
}

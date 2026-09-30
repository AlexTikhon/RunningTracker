import { sessionResponseSchema } from '@running-tracker/contracts';
import { inspect } from 'node:util';

import type { LoadHttpClient } from './load-http.js';

const cookieName = 'running_tracker_session';

/** Extracts the single session cookie's `name=value` pair from `Set-Cookie` headers. */
export function extractSessionCookie(setCookie: readonly string[]): string {
  const pairs = setCookie
    .map((header) => header.split(';', 1)[0]?.trim() ?? '')
    .filter((pair) => pair.startsWith(`${cookieName}=`) && pair.length > cookieName.length + 1);
  if (pairs.length !== 1) {
    throw new Error('The session response did not carry exactly one session cookie');
  }
  return pairs[0] as string;
}

/**
 * One authenticated load identity. The cookie and CSRF token live in private fields and every textual
 * rendering (JSON, inspect, string) exposes the user ID only, so a stray log line cannot leak them.
 */
export class LoadSession {
  readonly #cookie: string;
  readonly #csrfHeaderName: string;
  readonly #csrfToken: string;
  readonly #origin: string;

  public constructor(
    public readonly userId: string,
    secrets: { cookie: string; csrfHeaderName: string; csrfToken: string; origin: string },
  ) {
    this.#cookie = secrets.cookie;
    this.#csrfHeaderName = secrets.csrfHeaderName;
    this.#csrfToken = secrets.csrfToken;
    this.#origin = secrets.origin;
  }

  public readHeaders(): Record<string, string> {
    return { cookie: this.#cookie };
  }

  public mutationHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      cookie: this.#cookie,
      [this.#csrfHeaderName]: this.#csrfToken,
      origin: this.#origin,
    };
  }

  public streamHeaders(): Record<string, string> {
    return { accept: 'text/event-stream', cookie: this.#cookie };
  }

  /** Raw secret values, only so the result writer can prove none of them reaches disk. */
  public secrets(): string[] {
    return [this.#csrfToken, this.#cookie.slice(cookieName.length + 1)];
  }

  public toJSON(): { userId: string } {
    return { userId: this.userId };
  }

  public toString(): string {
    return `LoadSession(${this.userId})`;
  }

  public [inspect.custom](): string {
    return this.toString();
  }
}

export interface LocalSessionOptions {
  origin: string;
  timeoutMs: number;
  userId: string;
}

/** Logs in through the real `POST /api/session` local-identity endpoint; there is no other path. */
export async function createLocalSession(
  http: LoadHttpClient,
  { origin, timeoutMs, userId }: LocalSessionOptions,
): Promise<LoadSession> {
  const response = await http.request({
    body: JSON.stringify({ userId }),
    headers: { 'content-type': 'application/json', origin },
    method: 'POST',
    path: '/api/session',
    timeoutMs,
  });
  if (response.status !== 201) {
    throw new Error(`The local session request was answered with status ${response.status}`);
  }
  const setCookie = response.headers['set-cookie'];
  const parsed = sessionResponseSchema.parse(JSON.parse(response.body.toString('utf8')));
  if (parsed.identity.userId !== userId) {
    throw new Error('The session was created for a different identity');
  }
  return new LoadSession(userId, {
    cookie: extractSessionCookie(setCookie ?? []),
    csrfHeaderName: parsed.csrf.headerName,
    csrfToken: parsed.csrf.token,
    origin,
  });
}

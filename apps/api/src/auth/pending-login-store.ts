import { createHash, randomBytes } from 'node:crypto';

/** What the callback needs to complete one authorization-code login. Stored only as long as the login is pending. */
export interface PendingLogin {
  codeVerifier: string;
  nonce: string;
  state: string;
}

/**
 * Where pending OpenID Connect logins live between the redirect to the provider and its callback (ADR-0081). The
 * browser holds only an opaque login identifier; a store keeps its digest. Every operation is asynchronous and may
 * fail with OidcLoginStoreUnavailableError, which says nothing about the attempt itself: a caller must neither
 * complete a login nor report it as expired on that error.
 *
 * - reserve takes room for one login BEFORE provider discovery and returns its new identifier. The browser's own
 *   previous attempt (the identifier its login cookie carries) is removed first. A store full of live attempts,
 *   reservations included, refuses with OidcLoginStoreCapacityError; another live attempt is never evicted.
 * - completeReservation stores the PKCE verifier, state and nonce on a live, not yet completed reservation. It never
 *   extends the reservation's expiry and never overwrites a completed or consumed attempt; false otherwise.
 * - consume removes the attempt, whatever its state, and returns its material only if it was completed and is still
 *   live. At most one caller ever receives an attempt, across every API instance on the store. Unknown, malformed,
 *   incomplete and expired identifiers resolve to undefined.
 * - cancel removes an attempt the caller started (a failed or abandoned sign-in).
 *
 * Expiry is absolute from the reservation instant: an attempt is refused from its expiry instant on.
 */
export interface PendingLoginStore {
  cancel(loginId: string): Promise<void>;
  completeReservation(loginId: string, login: PendingLogin): Promise<boolean>;
  consume(loginId: string): Promise<PendingLogin | undefined>;
  reserve(previousLoginId?: string): Promise<string>;
}

export class OidcLoginStoreCapacityError extends Error {
  public constructor() {
    super('The pending login store is at capacity');
    this.name = 'OidcLoginStoreCapacityError';
  }
}

/** The store could not answer (unreachable, timed out, or failed). Not evidence that an attempt exists or not. */
export class OidcLoginStoreUnavailableError extends Error {
  /** A short machine code (SQLSTATE or a Node network code) for logs; never a message, query or value. */
  public readonly code: string | undefined;

  public constructor(reason: string, options?: { cause?: unknown }) {
    super(`The pending login store is unavailable: ${reason}`, options);
    this.name = 'OidcLoginStoreUnavailableError';
    const causeCode = (options?.cause as { code?: unknown } | undefined)?.code;
    this.code = typeof causeCode === 'string' ? causeCode : undefined;
  }
}

/** The shape of every identifier this module issues: 32 random bytes, base64url. */
export const loginIdPattern = /^[A-Za-z0-9_-]{43}$/u;

/** Bounded, URL-safe values (RFC 3986 unreserved characters): the shape the OIDC client generates. */
const materialPattern = /^[A-Za-z0-9._~-]{1,255}$/u;

/** The largest OIDC_LOGIN_TTL_MS; also a table constraint (migration 0037). */
export const maximumLoginTtlMs = 60 * 60 * 1_000;

export function createLoginId(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 of the identifier, base64url: the only form a store keeps. */
export function pendingLoginDigest(loginId: string): string {
  return createHash('sha256').update(loginId, 'utf8').digest('base64url');
}

/** Rejects material a store must not keep. A programming error, not a refusal: the OIDC client generates it. */
export function assertPendingLoginShape(login: PendingLogin): void {
  for (const value of [login.codeVerifier, login.state, login.nonce]) {
    if (typeof value !== 'string' || !materialPattern.test(value)) {
      throw new TypeError('Pending login material must be 1 to 255 URL-safe characters');
    }
  }
}

export function assertPendingLoginLimits(capacity: number, ttlMs: number): void {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000) {
    throw new TypeError('capacity must be an integer between 1 and 10000');
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > maximumLoginTtlMs) {
    throw new TypeError('ttlMs must be an integer between 1 and 3600000');
  }
}

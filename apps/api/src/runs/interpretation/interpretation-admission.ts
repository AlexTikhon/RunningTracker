import type { Clock } from '../../clock.js';

// Admission control for the interpreter, in one process and in memory (ADR-0057). Every check and every
// reservation happens in one synchronous call, so two requests can never both take the last place: JavaScript runs
// this to completion before anything else can.
//
// What it is not: a durable budget (a restart forgets everything) and not a distributed limiter (each process has
// its own). It bounds how fast one process can spend, which is what a misbehaving client or a loop in a page can
// otherwise do to the provider bill.

export type AdmissionRejection = 'budget_exhausted' | 'busy' | 'in_progress' | 'rate_limited';

export class AdmissionRejectedError extends Error {
  public constructor(
    public readonly reason: AdmissionRejection,
    /** When a retry could succeed, in milliseconds; null when that is not known. */
    public readonly retryAfterMs: number | null,
  ) {
    super(`Interpretation request not admitted: ${reason}`);
    this.name = 'AdmissionRejectedError';
  }
}

interface WindowLimit {
  perWindow: number;
  windowMs: number;
}

export interface AdmissionOptions {
  allowance: WindowLimit;
  clock: Pick<Clock, 'monotonicNow'>;
  maxConcurrent: number;
  /** Most people tracked at once; a table that is full of people who are still limited refuses newcomers. */
  maxUsers: number;
  userRate: WindowLimit;
}

/**
 * An admitted provider OPERATION: one global place and the person's one in-flight reservation.
 *
 * The owner releases it when the operation has settled, not when the HTTP request that started it has ended. A
 * request ends at a deadline or when its client leaves; an interpreter may keep running after either, and while it
 * does, the place must stay taken or the concurrency limit stops bounding anything. There is deliberately no lease
 * or expiry here: a place held by an operation that never settles stays held until the process restarts.
 */
export interface AdmissionTicket {
  /**
   * Gives the place back. A request that reached the provider keeps its charge (the provider may have done billable
   * work whatever the outcome); one that was admitted and never dispatched can say so and is refunded. Idempotent.
   */
  release(options?: { dispatched?: boolean }): void;
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

export class InterpretationAdmission {
  readonly #allowance: WindowLimit;
  readonly #clock: Pick<Clock, 'monotonicNow'>;
  readonly #maxConcurrent: number;
  readonly #maxUsers: number;
  readonly #userRate: WindowLimit;
  // Monotonic times of dispatches in the rolling allowance window, oldest first. At most `allowance.perWindow` long.
  readonly #dispatches: number[] = [];
  readonly #inFlight = new Set<string>();
  // Per person: monotonic times of admitted requests in the rate window, oldest first.
  readonly #recent = new Map<string, number[]>();
  #concurrent = 0;

  public constructor(options: AdmissionOptions) {
    requirePositiveInteger(options.maxConcurrent, 'maxConcurrent');
    requirePositiveInteger(options.maxUsers, 'maxUsers');
    requirePositiveInteger(options.userRate.perWindow, 'userRate.perWindow');
    requirePositiveInteger(options.userRate.windowMs, 'userRate.windowMs');
    requirePositiveInteger(options.allowance.perWindow, 'allowance.perWindow');
    requirePositiveInteger(options.allowance.windowMs, 'allowance.windowMs');
    this.#allowance = options.allowance;
    this.#clock = options.clock;
    this.#maxConcurrent = options.maxConcurrent;
    this.#maxUsers = options.maxUsers;
    this.#userRate = options.userRate;
  }

  /** People currently remembered by the rate limiter (after discarding the expired). */
  public trackedUsers(): number {
    this.#sweep(this.#clock.monotonicNow());
    return this.#recent.size;
  }

  /** Dispatches currently charged against the allowance window. */
  public allowanceInUse(): number {
    this.#expireDispatches(this.#clock.monotonicNow());
    return this.#dispatches.length;
  }

  public admit(userId: string): AdmissionTicket {
    const now = this.#clock.monotonicNow();

    if (this.#inFlight.has(userId)) {
      throw new AdmissionRejectedError('in_progress', null);
    }

    let times = this.#recent.get(userId);
    if (times !== undefined) {
      this.#expireTimes(times, now, this.#userRate.windowMs);
      if (times.length === 0) {
        this.#recent.delete(userId);
        times = undefined;
      }
    }
    if (times !== undefined && times.length >= this.#userRate.perWindow) {
      throw new AdmissionRejectedError('rate_limited', times[0]! + this.#userRate.windowMs - now);
    }
    if (times === undefined && this.#recent.size >= this.#maxUsers) {
      this.#sweep(now);
      if (this.#recent.size >= this.#maxUsers) {
        // Forgetting someone who is still limited would let them start over; refusing a newcomer is the safe side.
        throw new AdmissionRejectedError('busy', null);
      }
    }

    if (this.#concurrent >= this.#maxConcurrent) {
      throw new AdmissionRejectedError('busy', null);
    }

    this.#expireDispatches(now);
    if (this.#dispatches.length >= this.#allowance.perWindow) {
      throw new AdmissionRejectedError(
        'budget_exhausted',
        this.#dispatches[0]! + this.#allowance.windowMs - now,
      );
    }

    // Everything passed: reserve, in the same synchronous step.
    if (times === undefined) {
      times = [];
      this.#recent.set(userId, times);
    }
    times.push(now);
    this.#dispatches.push(now);
    this.#inFlight.add(userId);
    this.#concurrent += 1;

    let released = false;
    return {
      release: (options) => {
        if (released) {
          return;
        }
        released = true;
        this.#inFlight.delete(userId);
        this.#concurrent -= 1;
        if (options?.dispatched === false) {
          this.#refund(userId, now);
        }
      },
    };
  }

  #refund(userId: string, reservedAt: number): void {
    const times = this.#recent.get(userId);
    if (times !== undefined) {
      const index = times.lastIndexOf(reservedAt);
      if (index !== -1) {
        times.splice(index, 1);
      }
      if (times.length === 0) {
        this.#recent.delete(userId);
      }
    }
    const dispatch = this.#dispatches.lastIndexOf(reservedAt);
    if (dispatch !== -1) {
      this.#dispatches.splice(dispatch, 1);
    }
  }

  #expireTimes(times: number[], now: number, windowMs: number): void {
    let expired = 0;
    while (expired < times.length && now - times[expired]! >= windowMs) {
      expired += 1;
    }
    if (expired > 0) {
      times.splice(0, expired);
    }
  }

  #expireDispatches(now: number): void {
    this.#expireTimes(this.#dispatches, now, this.#allowance.windowMs);
  }

  #sweep(now: number): void {
    for (const [userId, times] of this.#recent) {
      this.#expireTimes(times, now, this.#userRate.windowMs);
      if (times.length === 0 && !this.#inFlight.has(userId)) {
        this.#recent.delete(userId);
      }
    }
  }
}

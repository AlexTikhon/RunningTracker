export interface VirtualTimerHandle {
  readonly id: number;
}

interface PendingTimer {
  readonly callback: () => void;
  readonly dueMs: number;
  readonly id: number;
  readonly insertionOrder: number;
}

const MAX_CALLBACKS_PER_RUN = 100_000;

function requireNonnegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a nonnegative finite number`);
  }
}

export class VirtualClock {
  readonly #epochMs: number;
  #elapsedMs = 0;
  #nextId = 1;
  #nextInsertionOrder = 1;
  readonly #timers = new Map<number, PendingTimer>();

  public constructor(startAt: string | Date) {
    const epochMs = startAt instanceof Date ? startAt.getTime() : Date.parse(startAt);
    if (!Number.isFinite(epochMs)) {
      throw new RangeError('startAt must be a valid timestamp');
    }
    this.#epochMs = epochMs;
  }

  public clearTimeout(handle: VirtualTimerHandle): void {
    this.#timers.delete(handle.id);
  }

  public monotonicNow(): number {
    return this.#elapsedMs;
  }

  public pendingTimerCount(): number {
    return this.#timers.size;
  }

  public setTimeout(callback: () => void, delayMs: number): VirtualTimerHandle {
    requireNonnegativeFinite(delayMs, 'delayMs');
    const id = this.#nextId++;
    this.#timers.set(id, {
      callback,
      dueMs: this.#elapsedMs + delayMs,
      id,
      insertionOrder: this.#nextInsertionOrder++,
    });
    return Object.freeze({ id });
  }

  public utcNow(): Date {
    return new Date(this.#epochMs + this.#elapsedMs);
  }

  public advanceBy(durationMs: number): void {
    requireNonnegativeFinite(durationMs, 'durationMs');
    this.advanceTo(this.#elapsedMs + durationMs);
  }

  public advanceTo(targetMs: number): void {
    requireNonnegativeFinite(targetMs, 'targetMs');
    if (targetMs < this.#elapsedMs) {
      throw new RangeError('virtual time cannot move backwards');
    }

    let callbackCount = 0;
    while (true) {
      const next = this.#nextTimerAtOrBefore(targetMs);
      if (next === undefined) break;
      if (++callbackCount > MAX_CALLBACKS_PER_RUN) {
        throw new Error('virtual clock callback limit exceeded');
      }
      this.#timers.delete(next.id);
      this.#elapsedMs = next.dueMs;
      next.callback();
    }
    this.#elapsedMs = targetMs;
  }

  public runAll(): void {
    let callbackCount = 0;
    while (this.#timers.size > 0) {
      const next = this.#nextTimerAtOrBefore(Number.POSITIVE_INFINITY);
      if (next === undefined) return;
      if (++callbackCount > MAX_CALLBACKS_PER_RUN) {
        throw new Error('virtual clock callback limit exceeded');
      }
      this.#timers.delete(next.id);
      this.#elapsedMs = next.dueMs;
      next.callback();
    }
  }

  #nextTimerAtOrBefore(targetMs: number): PendingTimer | undefined {
    let result: PendingTimer | undefined;
    for (const timer of this.#timers.values()) {
      if (timer.dueMs > targetMs) continue;
      if (
        result === undefined ||
        timer.dueMs < result.dueMs ||
        (timer.dueMs === result.dueMs && timer.insertionOrder < result.insertionOrder)
      ) {
        result = timer;
      }
    }
    return result;
  }
}

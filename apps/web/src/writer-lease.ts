import type { IndexedDbRunnerStorage, WriterLease } from './runner-storage.js';

const DEFAULT_LEASE_DURATION_MS = 15_000;
const DEFAULT_RENEW_INTERVAL_MS = 5_000;

type WriterLeaseStorage = Pick<
  IndexedDbRunnerStorage,
  'acquireWriterLease' | 'releaseWriterLease' | 'renewWriterLease'
>;

export type WriterOwnershipState =
  | { status: 'unclaimed' }
  | { status: 'acquiring' }
  | { expiresAt: string; fencingToken: string; status: 'owned' }
  | { expiresAt: string; status: 'conflict' }
  | { message: string; status: 'lost' | 'error' };

export interface WriterLeaseCoordinatorOptions {
  leaseDurationMs?: number;
  onState: (state: WriterOwnershipState) => void;
  ownerId?: string;
  renewIntervalMs?: number;
  storage: WriterLeaseStorage;
  userId: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Writer ownership failed for an unknown reason.';
}

export class WriterLeaseCoordinator {
  readonly #leaseDurationMs: number;
  readonly #onState: (state: WriterOwnershipState) => void;
  readonly #ownerId: string;
  readonly #renewIntervalMs: number;
  readonly #storage: WriterLeaseStorage;
  readonly #userId: string;
  #claimPromise: Promise<boolean> | null = null;
  #disposed = false;
  #lease: WriterLease | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  public constructor(options: WriterLeaseCoordinatorOptions) {
    this.#leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.#renewIntervalMs = options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
    if (
      !Number.isInteger(this.#leaseDurationMs)
      || !Number.isInteger(this.#renewIntervalMs)
      || this.#renewIntervalMs < 1
      || this.#renewIntervalMs >= this.#leaseDurationMs
    ) {
      throw new Error('Writer lease renewal must be a positive integer shorter than the lease duration');
    }
    this.#onState = options.onState;
    this.#ownerId = options.ownerId ?? crypto.randomUUID();
    this.#storage = options.storage;
    this.#userId = options.userId;
  }

  public claim(): Promise<boolean> {
    if (this.#disposed) {
      return Promise.resolve(false);
    }
    if (this.#lease !== null) {
      return this.assertOwned();
    }
    this.#claimPromise ??= this.#claim().finally(() => {
      this.#claimPromise = null;
    });
    return this.#claimPromise;
  }

  public async assertOwned(): Promise<boolean> {
    return await this.assertOwnedLease() !== null;
  }

  public async assertOwnedLease(): Promise<WriterLease | null> {
    const lease = this.#lease;
    if (lease === null || this.#disposed) {
      return null;
    }
    try {
      const renewed = await this.#storage.renewWriterLease(lease, this.#leaseDurationMs);
      if (this.#disposed) {
        return null;
      }
      if (renewed === null) {
        if (this.#lease === lease) {
          this.#lease = null;
          this.#clearTimer();
          this.#onState({
            message: 'This tab no longer owns the writer lease. Recording controls are read-only.',
            status: 'lost',
          });
        }
        return null;
      }
      if (this.#lease === lease) {
        this.#lease = renewed;
        this.#onState({
          expiresAt: renewed.expiresAt,
          fencingToken: renewed.fencingToken,
          status: 'owned',
        });
        this.#scheduleRenewal();
      }
      return renewed;
    } catch (error) {
      if (!this.#disposed && this.#lease === lease) {
        this.#lease = null;
        this.#clearTimer();
        this.#onState({ message: message(error), status: 'error' });
      }
      return null;
    }
  }

  public async release(): Promise<void> {
    this.#clearTimer();
    const lease = this.#lease;
    this.#lease = null;
    if (!this.#disposed) {
      this.#onState({ status: 'unclaimed' });
    }
    if (lease !== null) {
      await this.#storage.releaseWriterLease(lease);
    }
  }

  public async dispose(): Promise<void> {
    this.#disposed = true;
    this.#clearTimer();
    const lease = this.#lease;
    this.#lease = null;
    if (lease !== null) {
      await this.#storage.releaseWriterLease(lease);
    }
  }

  async #claim(): Promise<boolean> {
    this.#onState({ status: 'acquiring' });
    try {
      const result = await this.#storage.acquireWriterLease(
        this.#userId,
        this.#ownerId,
        this.#leaseDurationMs,
      );
      if (this.#disposed) {
        if (result.acquired) {
          await this.#storage.releaseWriterLease(result.lease);
        }
        return false;
      }
      if (!result.acquired) {
        this.#onState({ expiresAt: result.lease.expiresAt, status: 'conflict' });
        return false;
      }
      this.#lease = result.lease;
      this.#onState({
        expiresAt: result.lease.expiresAt,
        fencingToken: result.lease.fencingToken,
        status: 'owned',
      });
      this.#scheduleRenewal();
      return true;
    } catch (error) {
      if (!this.#disposed) {
        this.#onState({ message: message(error), status: 'error' });
      }
      return false;
    }
  }

  #scheduleRenewal(): void {
    this.#clearTimer();
    if (this.#disposed || this.#lease === null) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.assertOwned();
    }, this.#renewIntervalMs);
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}

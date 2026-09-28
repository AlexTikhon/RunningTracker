import type { LiveState } from '@running-tracker/contracts';

import {
  LiveTrackStore,
  type LiveTrackState,
  type LiveTrackStoreScope,
} from './live-track-sync.js';

export type SelectedTrackStatus = 'error' | 'loading' | 'ready';

export interface SelectedTrackSnapshot {
  message: string | null;
  runId: string;
  status: SelectedTrackStatus;
  targetRevision: string;
  track: LiveTrackState | null;
}

export interface SelectedTrackSynchronizerOptions {
  onChange: (tracks: readonly SelectedTrackSnapshot[]) => void;
  orgId: string;
  store?: LiveTrackStore;
  userId: string;
}

interface SelectedTrackEntry extends SelectedTrackSnapshot {
  algorithmVersion: string;
  inFlight: Promise<LiveTrackState> | null;
}

function laterRevision(left: string, right: string): string {
  return BigInt(left) >= BigInt(right) ? left : right;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Track synchronization failed.';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class SelectedTrackSynchronizer {
  readonly #entries = new Map<string, SelectedTrackEntry>();
  readonly #onChange: SelectedTrackSynchronizerOptions['onChange'];
  readonly #orgId: string;
  readonly #store: LiveTrackStore;
  readonly #userId: string;
  #active = true;

  public constructor(options: SelectedTrackSynchronizerOptions) {
    this.#onChange = options.onChange;
    this.#orgId = options.orgId;
    this.#store = options.store ?? new LiveTrackStore();
    this.#userId = options.userId;
  }

  public reconcile(liveState: LiveState, selectedRunIds: ReadonlySet<string>): void {
    if (!this.#active) {
      return;
    }

    const selectedRuns = new Map(
      liveState.runs
        .filter(({ runId }) => selectedRunIds.has(runId))
        .map((run) => [run.runId, run]),
    );
    let changed = false;

    for (const runId of this.#entries.keys()) {
      if (!selectedRuns.has(runId)) {
        this.#remove(runId);
        changed = true;
      }
    }

    const synchronize: SelectedTrackEntry[] = [];
    for (const run of selectedRuns.values()) {
      let entry = this.#entries.get(run.runId);
      if (entry !== undefined && entry.algorithmVersion !== liveState.algorithmVersion) {
        this.#remove(run.runId);
        entry = undefined;
        changed = true;
      }

      if (entry === undefined) {
        entry = {
          algorithmVersion: liveState.algorithmVersion,
          inFlight: null,
          message: null,
          runId: run.runId,
          status: 'loading',
          targetRevision: run.dataRevision,
          track: null,
        };
        this.#entries.set(run.runId, entry);
        changed = true;
      } else {
        const targetRevision = laterRevision(entry.targetRevision, run.dataRevision);
        if (targetRevision !== entry.targetRevision) {
          entry.targetRevision = targetRevision;
          entry.message = null;
          entry.status = 'loading';
          changed = true;
        }
      }

      if (
        entry.track === null
        || entry.track.algorithmVersion !== entry.algorithmVersion
        || BigInt(entry.track.revision) < BigInt(entry.targetRevision)
        || entry.status === 'error'
      ) {
        entry.status = 'loading';
        synchronize.push(entry);
      }
    }

    if (changed) {
      this.#emit();
    }
    for (const entry of synchronize) {
      this.#start(entry);
    }
  }

  public clear(): void {
    if (!this.#active) {
      return;
    }
    for (const runId of [...this.#entries.keys()]) {
      this.#remove(runId);
    }
    this.#emit();
  }

  public dispose(): void {
    if (!this.#active) {
      return;
    }
    this.#active = false;
    for (const runId of [...this.#entries.keys()]) {
      this.#remove(runId);
    }
  }

  #scope(runId: string): LiveTrackStoreScope {
    return { orgId: this.#orgId, runId, userId: this.#userId };
  }

  #remove(runId: string): void {
    this.#store.remove(this.#scope(runId));
    this.#entries.delete(runId);
  }

  #start(entry: SelectedTrackEntry): void {
    let synchronization: Promise<LiveTrackState>;
    try {
      synchronization = this.#store.synchronize(
        this.#scope(entry.runId),
        entry.targetRevision,
      );
    } catch (error) {
      entry.status = 'error';
      entry.message = errorMessage(error);
      this.#emit();
      return;
    }

    if (entry.inFlight === synchronization) {
      return;
    }
    entry.inFlight = synchronization;
    void synchronization.then(
      (track) => {
        if (!this.#active || this.#entries.get(entry.runId) !== entry) {
          return;
        }
        entry.inFlight = null;
        entry.message = null;
        entry.status = 'ready';
        entry.track = track;
        this.#emit();
      },
      (error: unknown) => {
        if (
          isAbortError(error)
          || !this.#active
          || this.#entries.get(entry.runId) !== entry
        ) {
          return;
        }
        entry.inFlight = null;
        entry.message = errorMessage(error);
        entry.status = 'error';
        entry.track = this.#store.get(this.#scope(entry.runId));
        this.#emit();
      },
    );
  }

  #emit(): void {
    this.#onChange(
      [...this.#entries.values()]
        .sort((left, right) => left.runId.localeCompare(right.runId))
        .map((entry) => ({
          message: entry.message,
          runId: entry.runId,
          status: entry.status,
          targetRevision: entry.targetRevision,
          track: entry.track,
        })),
    );
  }
}

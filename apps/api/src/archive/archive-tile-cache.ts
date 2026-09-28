import { createHash } from 'node:crypto';

import type { TilePath, TileQuery } from '@running-tracker/contracts';

import type { Clock } from '../clock.js';

export const ARCHIVE_TILE_CACHE_FORMAT_VERSION = 'archive-mvt-v1';
export const ARCHIVE_TILE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
export const ARCHIVE_TILE_CACHE_MAX_ENTRIES = 4_096;
export const ARCHIVE_TILE_CACHE_TTL_MS = 5 * 60 * 1_000;

interface ArchiveTileCacheEntry {
  expiresAtMs: number;
  tile: Buffer;
}

interface ArchiveTileFlight {
  controller: AbortController;
  promise: Promise<Buffer>;
  settled: boolean;
  waiters: number;
}

export interface ArchiveTileCacheIdentity {
  path: TilePath;
  query: TileQuery;
  userId: string;
}

interface ArchiveTileCacheOptions {
  clock: Pick<Clock, 'monotonicNow'>;
  maxBytes?: number;
  maxEntries?: number;
  ttlMs?: number;
}

export interface ArchiveTileCacheStore {
  get(key: string): Buffer | undefined | Promise<Buffer | undefined>;
  getOrCreate(key: string, load: () => Promise<Buffer>): Promise<Buffer>;
  runSingleFlight(
    key: string,
    load: (signal: AbortSignal) => Promise<Buffer>,
    signal?: AbortSignal,
  ): Promise<Buffer>;
  set(key: string, tile: Buffer): void;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Archive tile request was aborted');
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('Archive tile generation failed', { cause: error });
}

function canonicalTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/u.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) {
    throw new TypeError('Archive tile cache timestamps must be valid');
  }
  const fraction = match[2]?.replace(/0+$/u, '') ?? '';
  return `${match[1]}${fraction ? `.${fraction}` : ''}Z`;
}

export function createArchiveTileCacheKey({
  path,
  query,
  userId,
}: ArchiveTileCacheIdentity): string {
  const canonicalFilter = JSON.stringify([
    canonicalTimestamp(query.from),
    canonicalTimestamp(query.to),
  ]);
  const canonicalFilterHash = createHash('sha256')
    .update(canonicalFilter)
    .digest('hex');

  return [
    ARCHIVE_TILE_CACHE_FORMAT_VERSION,
    path.orgId.toLowerCase(),
    userId.toLowerCase(),
    BigInt(query.revision).toString(),
    canonicalFilterHash,
    path.z.toString(),
    path.x.toString(),
    path.y.toString(),
  ].join('/');
}

export class ArchiveTileCache implements ArchiveTileCacheStore {
  readonly #clock: Pick<Clock, 'monotonicNow'>;
  readonly #entries = new Map<string, ArchiveTileCacheEntry>();
  readonly #inFlight = new Map<string, ArchiveTileFlight>();
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  #totalBytes = 0;

  public constructor({
    clock,
    maxBytes = ARCHIVE_TILE_CACHE_MAX_BYTES,
    maxEntries = ARCHIVE_TILE_CACHE_MAX_ENTRIES,
    ttlMs = ARCHIVE_TILE_CACHE_TTL_MS,
  }: ArchiveTileCacheOptions) {
    this.#clock = clock;
    this.#maxBytes = positiveSafeInteger(maxBytes, 'maxBytes');
    this.#maxEntries = positiveSafeInteger(maxEntries, 'maxEntries');
    this.#ttlMs = positiveSafeInteger(ttlMs, 'ttlMs');
  }

  public get entryCount(): number {
    return this.#entries.size;
  }

  public get totalBytes(): number {
    return this.#totalBytes;
  }

  public getOrCreate(key: string, load: () => Promise<Buffer>): Promise<Buffer> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }

    return this.runSingleFlight(key, async () => {
      const tile = await load();
      this.set(key, tile);
      return tile;
    });
  }

  public get(key: string): Buffer | undefined {
    return this.#read(key);
  }

  public runSingleFlight(
    key: string,
    load: (signal: AbortSignal) => Promise<Buffer>,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }
    let flight = this.#inFlight.get(key);
    if (!flight) {
      const controller = new AbortController();
      flight = {
        controller,
        promise: Promise.resolve()
          .then(() => load(controller.signal))
          .then((tile) => {
            if (!Buffer.isBuffer(tile)) {
              throw new TypeError('Archive tile loaders must return a Buffer');
            }
            return tile;
          })
          .finally(() => {
            const current = this.#inFlight.get(key);
            if (current) {
              current.settled = true;
            }
            this.#inFlight.delete(key);
          }),
        settled: false,
        waiters: 0,
      };
      this.#inFlight.set(key, flight);
    }
    return this.#joinFlight(flight, signal);
  }

  #joinFlight(flight: ArchiveTileFlight, signal?: AbortSignal): Promise<Buffer> {
    if (signal?.aborted) {
      if (flight.waiters === 0 && !flight.settled) {
        flight.controller.abort();
      }
      return Promise.reject(abortReason(signal));
    }
    flight.waiters += 1;
    return new Promise<Buffer>((resolve, reject) => {
      let complete = false;
      const finish = (settle: () => void): void => {
        if (complete) {
          return;
        }
        complete = true;
        if (signal) {
          signal.removeEventListener('abort', abort);
        }
        flight.waiters -= 1;
        if (flight.waiters === 0 && !flight.settled) {
          flight.controller.abort();
        }
        settle();
      };
      const abort = (): void => {
        finish(() =>
          reject(signal ? abortReason(signal) : new Error('Archive tile request was aborted')),
        );
      };
      signal?.addEventListener('abort', abort, { once: true });
      void flight.promise.then(
        (tile) => finish(() => resolve(tile)),
        (error: unknown) => finish(() => reject(asError(error))),
      );
    });
  }

  public set(key: string, tile: Buffer): void {
    if (!Buffer.isBuffer(tile)) {
      throw new TypeError('Archive tile cache values must be a Buffer');
    }
    this.#store(key, tile);
  }

  #delete(key: string, entry: ArchiveTileCacheEntry): void {
    if (this.#entries.delete(key)) {
      this.#totalBytes -= entry.tile.byteLength;
    }
  }

  #read(key: string): Buffer | undefined {
    const entry = this.#entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAtMs <= this.#clock.monotonicNow()) {
      this.#delete(key, entry);
      return undefined;
    }

    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.tile;
  }

  #store(key: string, tile: Buffer): void {
    if (tile.byteLength > this.#maxBytes) {
      return;
    }

    const now = this.#clock.monotonicNow();
    for (const [candidateKey, entry] of this.#entries) {
      if (entry.expiresAtMs <= now) {
        this.#delete(candidateKey, entry);
      }
    }

    const previous = this.#entries.get(key);
    if (previous) {
      this.#delete(key, previous);
    }
    this.#entries.set(key, { expiresAtMs: now + this.#ttlMs, tile });
    this.#totalBytes += tile.byteLength;

    while (
      this.#entries.size > this.#maxEntries ||
      this.#totalBytes > this.#maxBytes
    ) {
      const oldest = this.#entries.entries().next().value;
      if (!oldest) {
        break;
      }
      this.#delete(oldest[0], oldest[1]);
    }
  }
}

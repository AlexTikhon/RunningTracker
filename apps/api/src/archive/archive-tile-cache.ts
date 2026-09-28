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

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
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

export class ArchiveTileCache {
  readonly #clock: Pick<Clock, 'monotonicNow'>;
  readonly #entries = new Map<string, ArchiveTileCacheEntry>();
  readonly #inFlight = new Map<string, Promise<Buffer>>();
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

  public async getOrCreate(key: string, load: () => Promise<Buffer>): Promise<Buffer> {
    const cached = this.#read(key);
    if (cached) {
      return cached;
    }

    const existingFlight = this.#inFlight.get(key);
    if (existingFlight) {
      return existingFlight;
    }

    const flight = Promise.resolve()
      .then(load)
      .then((tile) => {
        if (!Buffer.isBuffer(tile)) {
          throw new TypeError('Archive tile loaders must return a Buffer');
        }
        this.#store(key, tile);
        return tile;
      })
      .finally(() => {
        this.#inFlight.delete(key);
      });
    this.#inFlight.set(key, flight);
    return flight;
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

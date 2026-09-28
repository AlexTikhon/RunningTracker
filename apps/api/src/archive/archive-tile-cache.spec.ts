import { describe, expect, it, vi } from 'vitest';

import {
  ARCHIVE_TILE_CACHE_FORMAT_VERSION,
  ArchiveTileCache,
  createArchiveTileCacheKey,
  type ArchiveTileCacheIdentity,
} from './archive-tile-cache.js';

const identity: ArchiveTileCacheIdentity = {
  path: {
    orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    x: 142,
    y: 84,
    z: 8,
  },
  query: {
    from: '2026-09-01T00:00:00Z',
    revision: '7',
    to: '2026-10-01T00:00:00Z',
  },
  userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

function controlledCache(options: { maxBytes?: number; maxEntries?: number; ttlMs?: number } = {}) {
  let now = 0;
  const cache = new ArchiveTileCache({
    clock: { monotonicNow: () => now },
    ...options,
  });
  return {
    cache,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe('P09.3 archive tile cache identity', () => {
  it('uses every SDD key component and canonicalizes equivalent values', () => {
    const key = createArchiveTileCacheKey(identity);
    const equivalent = createArchiveTileCacheKey({
      path: { ...identity.path, orgId: identity.path.orgId.toUpperCase() },
      query: {
        from: '2026-09-01T00:00:00.000Z',
        revision: '007',
        to: '2026-10-01T00:00:00.000Z',
      },
      userId: identity.userId.toUpperCase(),
    });

    expect(equivalent).toBe(key);
    expect(key.startsWith(`${ARCHIVE_TILE_CACHE_FORMAT_VERSION}/`)).toBe(true);

    const variants: ArchiveTileCacheIdentity[] = [
      { ...identity, path: { ...identity.path, orgId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } },
      { ...identity, userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      { ...identity, query: { ...identity.query, revision: '8' } },
      { ...identity, query: { ...identity.query, from: '2026-09-02T00:00:00Z' } },
      { ...identity, query: { ...identity.query, from: '2026-09-01T00:00:00.0001Z' } },
      { ...identity, query: { ...identity.query, to: '2026-10-02T00:00:00Z' } },
      { ...identity, path: { ...identity.path, z: 9 } },
      { ...identity, path: { ...identity.path, x: 143 } },
      { ...identity, path: { ...identity.path, y: 85 } },
    ];
    expect(new Set(variants.map((variant) => createArchiveTileCacheKey(variant))).size).toBe(
      variants.length,
    );
    for (const variant of variants) {
      expect(createArchiveTileCacheKey(variant)).not.toBe(key);
    }
  });
});

describe('P09.3 byte-bounded archive tile LRU', () => {
  it('promotes hits and evicts least-recently-used buffers by total bytes', async () => {
    const { cache } = controlledCache({ maxBytes: 5, maxEntries: 10 });
    const loads = new Map<string, number>();
    const read = (key: string, bytes: number) =>
      cache.getOrCreate(key, () => {
        loads.set(key, (loads.get(key) ?? 0) + 1);
        return Promise.resolve(Buffer.alloc(bytes, key.charCodeAt(0)));
      });

    await read('a', 3);
    await read('b', 2);
    await read('a', 3);
    await read('c', 2);
    await read('b', 2);

    expect(loads).toEqual(new Map([['a', 1], ['b', 2], ['c', 1]]));
    expect(cache.totalBytes).toBeLessThanOrEqual(5);
  });

  it('expires entries at five-minute-style boundaries and starts TTL after generation', async () => {
    const { cache, setNow } = controlledCache({ maxBytes: 10, ttlMs: 300_000 });
    const load = vi.fn(() => Promise.resolve(Buffer.from([1])));

    setNow(50);
    await cache.getOrCreate('tile', load);
    setNow(300_049);
    await cache.getOrCreate('tile', load);
    setNow(300_050);
    await cache.getOrCreate('tile', load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('coalesces one in-flight load and never caches failures', async () => {
    const { cache } = controlledCache({ maxBytes: 10 });
    let resolve!: (tile: Buffer) => void;
    const load = vi.fn(
      () => new Promise<Buffer>((settle) => {
        resolve = settle;
      }),
    );

    const first = cache.getOrCreate('tile', load);
    const second = cache.getOrCreate('tile', load);
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();
    resolve(Buffer.from([1, 2]));
    await expect(Promise.all([first, second])).resolves.toEqual([
      Buffer.from([1, 2]),
      Buffer.from([1, 2]),
    ]);

    const failure = vi.fn(() => Promise.reject(new Error('generation failed')));
    await expect(cache.getOrCreate('failure', failure)).rejects.toThrow('generation failed');
    await expect(cache.getOrCreate('failure', failure)).rejects.toThrow('generation failed');
    expect(failure).toHaveBeenCalledTimes(2);
  });

  it('caches empty tiles while bounding zero-byte metadata entries', async () => {
    const { cache } = controlledCache({ maxBytes: 10, maxEntries: 2 });
    const load = vi.fn(() => Promise.resolve(Buffer.alloc(0)));

    await cache.getOrCreate('a', load);
    await cache.getOrCreate('a', load);
    await cache.getOrCreate('b', load);
    await cache.getOrCreate('c', load);

    expect(load).toHaveBeenCalledTimes(3);
    expect(cache.entryCount).toBe(2);
    expect(cache.totalBytes).toBe(0);
  });

  it('returns but does not retain a buffer larger than the cache capacity', async () => {
    const { cache } = controlledCache({ maxBytes: 2 });
    const load = vi.fn(() => Promise.resolve(Buffer.alloc(3)));

    await expect(cache.getOrCreate('large', load)).resolves.toHaveLength(3);
    await expect(cache.getOrCreate('large', load)).resolves.toHaveLength(3);
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.entryCount).toBe(0);
    expect(cache.totalBytes).toBe(0);
  });
});

import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { createApiMetrics } from '../observability/api-metrics.js';
import { ArchiveTileCache } from './archive-tile-cache.js';
import {
  ARCHIVE_TILE_MAX_UNCOMPRESSED_BYTES,
  ArchiveTileCoordinator,
} from './archive-tile-coordinator.js';
import { ArchiveTileGenerationScheduler } from './archive-tile-scheduler.js';
import type { ArchiveTilePipeline, ArchiveTileRequest } from './archive-service.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface PoolHarness {
  readonly checkedOut: number;
  readonly maximumCheckedOut: number;
  pool: Pick<Pool, 'connect'>;
}

function createPoolHarness(): PoolHarness {
  let checkedOut = 0;
  let maximumCheckedOut = 0;
  return {
    get checkedOut() {
      return checkedOut;
    },
    get maximumCheckedOut() {
      return maximumCheckedOut;
    },
    pool: {
      connect: () => {
        checkedOut += 1;
        maximumCheckedOut = Math.max(maximumCheckedOut, checkedOut);
        let released = false;
        const client = {
          query: (sql: string) => {
            if (sql === 'COMMIT' || sql === 'ROLLBACK' || sql === 'BEGIN') {
              return Promise.resolve({ command: sql, rows: [] });
            }
            if (sql.includes('SELECT EXISTS')) {
              return Promise.resolve({ command: 'SELECT', rows: [{ allowed: true }] });
            }
            if (sql.includes('lock_archive_revision_for_tile')) {
              return Promise.resolve({
                command: 'SELECT',
                rows: [{ archive_revision: '0' }],
              });
            }
            return Promise.resolve({ command: 'SELECT', rows: [] });
          },
          release: () => {
            if (released) {
              throw new Error('Client released twice');
            }
            released = true;
            checkedOut -= 1;
          },
        } as unknown as PoolClient;
        return Promise.resolve(client);
      },
    },
  };
}

function request(x: number): ArchiveTileRequest {
  return {
    path: { orgId, x, y: 84, z: 8 },
    query: {
      from: '2026-09-01T00:00:00Z',
      revision: '0',
      to: '2026-10-01T00:00:00Z',
    },
  };
}

function createCache(): ArchiveTileCache {
  return new ArchiveTileCache({ clock: { monotonicNow: () => 0 } });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 1_000; index += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('Deterministic test condition was not reached');
}

describe('P09.6 archive tile coordinator', () => {
  it('accepts empty and exactly 1 MiB tiles, but rejects and never caches larger output', async () => {
    const harness = createPoolHarness();
    const calls = new Map<number, number>();
    const pipeline: ArchiveTilePipeline = {
      render: (_client, tileRequest) => {
        const x = tileRequest.path.x;
        calls.set(x, (calls.get(x) ?? 0) + 1);
        if (x === 1) {
          return Promise.resolve(Buffer.alloc(0));
        }
        if (x === 2) {
          return Promise.resolve(Buffer.alloc(128));
        }
        if (x === 3) {
          return Promise.resolve(Buffer.alloc(ARCHIVE_TILE_MAX_UNCOMPRESSED_BYTES));
        }
        return Promise.resolve(Buffer.alloc(ARCHIVE_TILE_MAX_UNCOMPRESSED_BYTES + 1));
      },
    };
    const coordinator = new ArchiveTileCoordinator({
      cache: createCache(),
      pipeline,
      pool: harness.pool,
      scheduler: new ArchiveTileGenerationScheduler(),
    });

    await expect(coordinator.read({ userId }, request(1), 'empty')).resolves.toHaveLength(0);
    await expect(coordinator.read({ userId }, request(2), 'normal')).resolves.toHaveLength(128);
    await expect(coordinator.read({ userId }, request(3), 'boundary')).resolves.toHaveLength(
      ARCHIVE_TILE_MAX_UNCOMPRESSED_BYTES,
    );
    await expect(coordinator.read({ userId }, request(3), 'boundary')).resolves.toHaveLength(
      ARCHIVE_TILE_MAX_UNCOMPRESSED_BYTES,
    );
    await expect(coordinator.read({ userId }, request(4), 'oversize')).rejects.toMatchObject({
      code: 'TILE_TOO_COMPLEX',
      statusCode: 422,
    });
    await expect(coordinator.read({ userId }, request(4), 'oversize')).rejects.toMatchObject({
      code: 'TILE_TOO_COMPLEX',
      statusCode: 422,
    });

    expect(calls).toEqual(new Map([[1, 1], [2, 1], [3, 1], [4, 2]]));
    expect(harness.checkedOut).toBe(0);
  });

  it('keeps queued misses outside the pool and preserves one SQL generator per key', async () => {
    const harness = createPoolHarness();
    const scheduler = new ArchiveTileGenerationScheduler();
    const gates: Array<() => void> = [];
    let renderCalls = 0;
    const pipeline: ArchiveTilePipeline = {
      render: async () => {
        renderCalls += 1;
        await new Promise<void>((resolve) => gates.push(resolve));
        return Buffer.from('tile');
      },
    };
    const coordinator = new ArchiveTileCoordinator({
      cache: createCache(),
      pipeline,
      pool: harness.pool,
      scheduler,
    });

    const jobs: Array<Promise<Buffer>> = [];
    jobs.push(coordinator.read({ userId }, request(20), 'key-20'));
    jobs.push(coordinator.read({ userId }, request(21), 'key-21'));
    await waitFor(() => renderCalls === 2);

    for (let index = 0; index < 16; index += 1) {
      jobs.push(coordinator.read({ userId }, request(22 + index), `key-${22 + index}`));
      await waitFor(() => scheduler.queueDepth === index + 1);
    }
    expect(scheduler.activeCount).toBe(2);
    expect(scheduler.queueDepth).toBe(16);
    expect(harness.checkedOut).toBe(2);

    await expect(
      withAuthenticatedTenantTransaction(harness.pool, { userId }, orgId, () => Promise.resolve('ok')),
    ).resolves.toBe('ok');
    expect(harness.maximumCheckedOut).toBe(3);

    await expect(
      coordinator.read({ userId }, request(40), 'key-40'),
    ).rejects.toMatchObject({ code: 'TILE_BUSY', statusCode: 503 });
    expect(scheduler.queueDepth).toBe(16);
    expect(harness.checkedOut).toBe(2);

    let released = 0;
    while (released < 18) {
      await waitFor(() => gates.length > released);
      gates[released]?.();
      released += 1;
    }
    await Promise.all(jobs);
    expect(renderCalls).toBe(18);
    expect(scheduler.activeCount).toBe(0);
    expect(scheduler.queueDepth).toBe(0);
    expect(harness.checkedOut).toBe(0);

    const sharedGate = new Promise<void>((resolve) => gates.push(resolve));
    const sharedRender = vi.fn(async () => {
        await sharedGate;
        return Buffer.from('shared');
      });
    const sharedPipeline: ArchiveTilePipeline = {
      render: sharedRender,
    };
    const sharedCoordinator = new ArchiveTileCoordinator({
      cache: createCache(),
      pipeline: sharedPipeline,
      pool: harness.pool,
      scheduler: new ArchiveTileGenerationScheduler(),
    });
    const first = sharedCoordinator.read({ userId }, request(50), 'shared-key');
    await waitFor(() => sharedRender.mock.calls.length === 1);
    const second = sharedCoordinator.read({ userId }, request(50), 'shared-key');
    await waitFor(() => harness.checkedOut === 1);
    gates.at(-1)?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      Buffer.from('shared'),
      Buffer.from('shared'),
    ]);
    expect(sharedRender).toHaveBeenCalledOnce();
  });
});

describe('P11.1 archive tile metrics', () => {
  function build(render: ArchiveTilePipeline['render']) {
    const harness = createPoolHarness();
    const metrics = createApiMetrics();
    let now = 0;
    const coordinator = new ArchiveTileCoordinator({
      cache: createCache(),
      clock: { monotonicNow: () => (now += 40) },
      metrics: metrics.archive,
      pipeline: { render },
      pool: harness.pool,
      scheduler: new ArchiveTileGenerationScheduler(),
    });
    return { coordinator, metrics };
  }

  it('counts a generated tile as a miss, then a repeat as a hit, and records bytes and SQL time once', async () => {
    const { coordinator, metrics } = build(() => Promise.resolve(Buffer.alloc(3_000)));
    const session = { userId };

    await coordinator.read(session, request(1), 'k1');
    await coordinator.read(session, request(1), 'k1');

    const output = metrics.registry.render();
    expect(output).toContain('archive_tile_requests_total{result="miss"} 1');
    expect(output).toContain('archive_tile_requests_total{result="hit"} 1');
    expect(output).toContain('archive_tile_bytes_count 2');
    expect(output).toContain('archive_tile_bytes_bucket{le="4096"} 2');
    expect(output).toContain('archive_tile_generation_seconds_count 1');
  });

  it('classifies over-limit tiles and busy or failing generation as errors without caching them', async () => {
    const { coordinator, metrics } = build((_client, tileRequest) =>
      tileRequest.path.x === 9
        ? Promise.reject(new Error('render failed'))
        : Promise.resolve(Buffer.alloc(ARCHIVE_TILE_MAX_UNCOMPRESSED_BYTES + 1)),
    );
    const session = { userId };

    await expect(coordinator.read(session, request(1), 'big')).rejects.toMatchObject({
      code: 'TILE_TOO_COMPLEX',
    });
    await expect(coordinator.read(session, request(9), 'bad')).rejects.toThrow('render failed');

    const output = metrics.registry.render();
    expect(output).toContain('archive_tile_requests_total{result="error"} 2');
    expect(output).not.toContain('archive_tile_requests_total{result="hit"}');
    expect(output).not.toContain('archive_tile_bytes_count');
    expect(output).not.toContain('render failed');
  });
});

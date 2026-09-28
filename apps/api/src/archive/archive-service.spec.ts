import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { postgisArchiveTilePipeline } from './archive-service.js';

describe('P09.2 PostGIS archive tile pipeline', () => {
  it('passes canonical tile/filter values to one spatial MVT query', async () => {
    const tile = Buffer.from([0x1a, 0x00]);
    const query = vi.fn().mockResolvedValue({ rows: [{ tile }] });

    await expect(
      postgisArchiveTilePipeline.render({ query } as unknown as PoolClient, {
        path: {
          orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          x: 142,
          y: 84,
          z: 8,
        },
        query: {
          from: '2026-09-01T00:00:00Z',
          revision: '0',
          to: '2026-10-01T00:00:00Z',
        },
      }),
    ).resolves.toEqual(tile);

    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(values).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      8,
      142,
      84,
      '2026-09-01T00:00:00Z',
      '2026-10-01T00:00:00Z',
    ]);
    expect(sql).toContain('summary.display_geom && bounds.search_4326');
    expect(sql).toContain('public.ST_AsMVTGeom');
    expect(sql).toContain("public.ST_AsMVT(mvt_rows, 'runs'");
    expect(sql).toContain('summary.run_id::text AS run_id');
  });

  it('rejects an invalid database payload instead of emitting a false empty tile', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{}] });

    await expect(
      postgisArchiveTilePipeline.render({ query } as unknown as PoolClient, {
        path: {
          orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          x: 0,
          y: 0,
          z: 8,
        },
        query: {
          from: '2026-09-01T00:00:00Z',
          revision: '0',
          to: '2026-10-01T00:00:00Z',
        },
      }),
    ).rejects.toThrow('PostGIS did not return an archive MVT payload');
  });
});

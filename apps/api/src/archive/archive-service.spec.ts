import { describe, expect, it } from 'vitest';

import { unavailableArchiveTilePipeline } from './archive-service.js';

describe('P09.1 archive tile pipeline boundary', () => {
  it('fails closed until the P09.2 PostGIS pipeline is installed', async () => {
    await expect(
      unavailableArchiveTilePipeline.render({} as never, {
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
    ).rejects.toMatchObject({ code: 'TILE_BUSY', statusCode: 503 });
  });
});

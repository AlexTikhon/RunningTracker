import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadHealth } from './health.js';

describe('loadHealth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps API and database status independent', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ checks: { database: 'down' } }), { status: 503 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadHealth()).resolves.toEqual({ api: 'up', database: 'down' });
  });
});


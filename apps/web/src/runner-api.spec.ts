import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRun, loadSession, readRun, sendRunCommand, uploadPointBatch } from './runner-api.js';
import type { RunnerApiError } from './runner-api.js';

const csrf = { headerName: 'x-csrf-token' as const, token: 'a'.repeat(43) };
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runner API', () => {
  it('loads and validates the current same-origin session', async () => {
    const session = {
      csrf,
      expiresAt: '2026-09-26T18:00:00.000Z',
      identity: { userId: '11111111-1111-4111-8111-111111111111' },
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(session)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadSession()).resolves.toEqual(session);
    expect(fetchMock).toHaveBeenCalledWith('/api/session', {
      credentials: 'same-origin',
    });
  });

  it('creates a run with CSRF protection and the canonical API path', async () => {
    const run = {
      controlRevision: '0',
      dataRevision: '0',
      finishedAt: null,
      rawState: 'available',
      runId,
      startedAt: '2026-09-26T08:00:00.000Z',
      status: 'recording',
      summary: null,
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(run)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createRun({ orgId, runId, startedAt: run.startedAt }, csrf)).resolves.toEqual(run);
    expect(fetchMock).toHaveBeenCalledWith(`/api/orgs/${orgId}/runs/${runId}`, {
      body: JSON.stringify({ startedAt: run.startedAt }),
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.token },
      method: 'PUT',
    });
  });

  it('sends an idempotent command with the current control revision', async () => {
    const result = {
      commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      controlRevision: '1',
      dataRevision: '1',
      finishedAt: null,
      status: 'paused',
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(result)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sendRunCommand(
        {
          commandId: result.commandId,
          expectedControlRevision: '0',
          orgId,
          runId,
          type: 'pause',
        },
        csrf,
      ),
    ).resolves.toEqual(result);
  });

  it('reads the authoritative run and uploads the exact bounded point payload', async () => {
    const run = {
      controlRevision: '1',
      dataRevision: '2',
      finishedAt: null,
      rawState: 'available',
      runId,
      startedAt: '2026-09-26T08:00:00.000Z',
      status: 'paused',
      summary: null,
    };
    const point = {
      accuracyM: 4.5,
      latitude: 52.2297,
      longitude: 21.0122,
      recordedAt: run.startedAt,
      segmentId: 0,
      seq: '1',
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(run)))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        dataRevision: '3',
        duplicateCount: 0,
        insertedCount: 1,
      })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(readRun(orgId, runId)).resolves.toEqual(run);
    await expect(uploadPointBatch({ orgId, points: [point], runId }, csrf)).resolves.toEqual({
      dataRevision: '3',
      duplicateCount: 0,
      insertedCount: 1,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, `/api/orgs/${orgId}/runs/${runId}`, {
      credentials: 'same-origin',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/orgs/${orgId}/runs/${runId}/points`, {
      body: JSON.stringify({ points: [point] }),
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.token },
      method: 'POST',
    });
  });

  it('exposes Retry-After for rate-limit backoff', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        error: {
          code: 'RATE_LIMITED',
          message: 'Slow down',
          requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        },
      }), { headers: { 'retry-after': '4' }, status: 429 })),
    );

    await expect(readRun(orgId, runId)).rejects.toEqual(expect.objectContaining({
      code: 'RATE_LIMITED',
      retryAfterMs: 4_000,
      status: 429,
    }));
  });

  it('preserves structured API failures for actionable UI errors', async () => {
    const error = {
      error: {
        code: 'CONTROL_REVISION_CONFLICT',
        message: 'The command is stale',
        requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(error), { status: 409 }),
      ),
    );

    await expect(
      sendRunCommand(
        {
          commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          expectedControlRevision: '0',
          orgId,
          runId,
          type: 'pause',
        },
        csrf,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<RunnerApiError>>({
        code: 'CONTROL_REVISION_CONFLICT',
        requestId: error.error.requestId,
        status: 409,
      }),
    );
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRun,
  endSession,
  loadArchiveMetadata,
  loadOrganizations,
  loadSession,
  readLiveTrackChangesPage,
  readLiveTrackSnapshotPage,
  readRun,
  sendRunCommand,
  uploadPointBatch,
} from './runner-api.js';
import { onAuthenticationRequired } from './request.js';
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
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  it.each([
    [401, 'AUTH_REQUIRED', null],
    [403, 'ORIGIN_DENIED', null],
    [429, 'RATE_LIMITED', 3_000],
    [503, 'SERVICE_UNAVAILABLE', null],
  ])('reports a %i session answer with its status and code, and does not announce the 401 itself', async (status, code, retryAfter) => {
    const headers = retryAfter === null ? {} : { 'retry-after': String(retryAfter / 1_000) };
    const body = { error: { code, message: 'no', requestId: '22222222-2222-4222-8222-222222222222' } };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { headers, status })));
    const announced = vi.fn();
    const unsubscribe = onAuthenticationRequired(announced);

    await expect(loadSession()).rejects.toMatchObject({ code, retryAfterMs: retryAfter, status });
    expect(announced).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('loads the identifiers of the organizations the session belongs to, in the server order', async () => {
    const other = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ items: [{ organizationId: orgId }, { organizationId: other }] })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadOrganizations()).resolves.toEqual([orgId, other]);
    expect(fetchMock).toHaveBeenCalledWith('/api/organizations', {
      credentials: 'same-origin',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  it('refuses an organization list outside the contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ items: [{ organizationId: orgId, name: 'x' }] }))),
    );

    await expect(loadOrganizations()).rejects.toThrow();
  });

  it('ends the session with a DELETE that carries the CSRF token and tolerates the empty 204', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(endSession(csrf)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/session', {
      credentials: 'same-origin',
      headers: { 'x-csrf-token': csrf.token },
      method: 'DELETE',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  it('reports a refused sign-out as an API error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'CSRF_DENIED', message: 'The CSRF token is missing or invalid', requestId: runId } }),
          { status: 403 },
        ),
      ),
    );

    await expect(endSession(csrf)).rejects.toMatchObject({ code: 'CSRF_DENIED', status: 403 });
  });

  it('loads revision-bound archive metadata through the canonical period query', async () => {
    const metadata = {
      archiveRevision: '81',
      filter: {
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-10-01T00:00:00.000Z',
      },
      maxzoom: 16,
      minzoom: 8,
      sourceLayer: 'runs',
      tiles: [`/api/orgs/${orgId}/tiles/runs/{z}/{x}/{y}.mvt?revision=81`],
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(metadata)),
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(loadArchiveMetadata({
      from: metadata.filter.from,
      orgId,
      to: metadata.filter.to,
    }, controller.signal)).resolves.toEqual(metadata);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/orgs/${orgId}/archive/metadata?from=2026-09-01T00%3A00%3A00.000Z&to=2026-10-01T00%3A00%3A00.000Z`,
      { credentials: 'same-origin', signal: expect.any(AbortSignal) as AbortSignal },
    );
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
      signal: expect.any(AbortSignal) as AbortSignal,
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
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/orgs/${orgId}/runs/${runId}/points`, {
      body: JSON.stringify({ points: [point] }),
      credentials: 'same-origin',
      signal: expect.any(AbortSignal) as AbortSignal,
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

  it('reads and validates snapshot and change pages through their canonical queries', async () => {
    const snapshot = {
      algorithmVersion: 'v1',
      fromRevision: null,
      nextCursor: 'snapshot-cursor',
      toRevision: '4',
      upserts: [],
    };
    const changes = {
      algorithmVersion: 'v1',
      fromRevision: '4',
      nextCursor: null,
      toRevision: '6',
      upserts: [],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot)))
      .mockResolvedValueOnce(new Response(JSON.stringify(changes)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      readLiveTrackSnapshotPage({ cursor: 'snapshot-cursor', orgId, runId }),
    ).resolves.toEqual(snapshot);
    await expect(
      readLiveTrackChangesPage({ afterRevision: '4', orgId, runId }),
    ).resolves.toEqual(changes);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/orgs/${orgId}/runs/${runId}/live-track?cursor=snapshot-cursor`,
      { credentials: 'same-origin', signal: expect.any(AbortSignal) as AbortSignal },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/orgs/${orgId}/runs/${runId}/live-track/changes?afterRevision=4`,
      { credentials: 'same-origin', signal: expect.any(AbortSignal) as AbortSignal },
    );
  });
});

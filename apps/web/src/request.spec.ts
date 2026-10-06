import { afterEach, describe, expect, it, vi } from 'vitest';

import { onAuthenticationRequired, REQUEST_TIMEOUT_MS, requestJson } from './request.js';
import { createRun } from './runner-api.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('request lifetime', () => {
  it.each(['headers', 'body'])('times out stalled %s even if transport ignores cancellation', async (phase) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => {
      signal = options.signal as AbortSignal;
      return phase === 'headers' ? new Promise(() => {})
        : Promise.resolve({ status: 200, ok: true, json: () => new Promise(() => {}) });
    }));
    const result = requestJson('/test');
    const assertion = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels body consumption and does not send an already cancelled request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true, json: () => new Promise(() => {}) });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const result = requestJson('/test', { signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    await expect(requestJson('/test', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('announces 401 before reading a stalled error body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401, ok: false, json: () => new Promise(() => {}) }));
    const required = vi.fn();
    const unsubscribe = onAuthenticationRequired(required);
    const controller = new AbortController();
    const result = requestJson('/test', { signal: controller.signal });
    await Promise.resolve();
    expect(required).toHaveBeenCalledOnce();
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    unsubscribe();
  });

  it('reuses the exact mutation URL and body after an unknown timed-out outcome', async () => {
    vi.useFakeTimers();
    const input = { orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', startedAt: '2026-10-05T10:00:00.000Z' };
    const csrf = { headerName: 'x-csrf-token' as const, token: 'a'.repeat(43) };
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(new Response(JSON.stringify({
      runId: input.runId, startedAt: input.startedAt, finishedAt: null, status: 'recording', dataRevision: '0', controlRevision: '0', rawState: 'available', summary: null,
    })));
    vi.stubGlobal('fetch', fetchMock);
    const first = createRun(input, csrf);
    const assertion = expect(first).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await assertion;
    await expect(createRun(input, csrf)).resolves.toMatchObject({ runId: input.runId });
    const [before, after] = fetchMock.mock.calls;
    expect(before?.[0]).toEqual(after?.[0]);
    expect(before?.[1]?.body).toEqual(after?.[1]?.body);
  });
});

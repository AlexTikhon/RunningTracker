import { GPX_IMPORT_MAX_BYTES, type ActivityView, type GpxImportPreview } from '@running-tracker/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  GpxImportController,
  type GpxConfirmer,
  type GpxImportSnapshot,
  type GpxPreviewer,
} from './gpx-import-controller.js';
import { RunnerApiError } from './runner-api.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const csrf = { headerName: 'x-csrf-token' as const, token: 'a'.repeat(43) };
const id = (n: number) => `a9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = (n: number) => `b9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const file = (name = 'ride.gpx', size = 120) => new File(['x'.repeat(size)], name, { type: '' });
const preview = (duplicateOf: string | null = null): GpxImportPreview => ({
  duplicateOf: duplicateOf === null ? null : { activityId: duplicateOf },
  summary: {
    distanceM: 334,
    elapsedDurationS: 370,
    endedAt: '2026-11-09T07:06:10.000Z',
    metricsVersion: 'gpx-summary-1',
    pointCount: 8,
    segmentCount: 2,
    startedAt: '2026-11-09T07:00:00.000Z',
  },
});
const saved = (n: number, type: ActivityView['type'] = 'ride'): ActivityView => ({
  activityId: id(n),
  createdAt: '2026-11-10T12:00:00.000Z',
  distanceM: 334,
  durationS: 370,
  notes: null,
  rpe: null,
  source: 'gpx',
  startedAt: '2026-11-09T07:00:00.000Z',
  type,
});
const apiError = (status: number, code: string, details: Record<string, unknown> | null = null, message = 'Refused') =>
  new RunnerApiError(message, status, code, '22222222-2222-4222-8222-222222222222', null, details);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(options: { confirm?: GpxConfirmer; preview?: GpxPreviewer; signal?: AbortSignal } = {}) {
  const snapshots: GpxImportSnapshot[] = [];
  const onSaved = vi.fn<(activity: ActivityView, created: boolean) => void>();
  let ids = 0;
  let keys = 0;
  const preview = vi.fn<GpxPreviewer>(options.preview ?? (() => Promise.resolve(previewOf())));
  const confirm = vi.fn<GpxConfirmer>(options.confirm ?? ((target) => Promise.resolve({ activity: saved(Number(target.activityId.slice(-2))), created: true })));
  const controller = new GpxImportController({
    confirm,
    csrf: () => csrf,
    newId: () => id(++ids),
    newKey: () => key(++keys),
    onChange: (snapshot) => snapshots.push(snapshot),
    onSaved,
    orgId,
    preview,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { confirm, controller, last: () => snapshots.at(-1)!, onSaved, preview, snapshots };
}
const previewOf = () => preview();

describe('GPX import controller (ADR-0086)', () => {
  it('previews a selected file, then confirms it with the chosen type, one id and one key, sending nothing else', async () => {
    const h = harness();
    const selected = file();
    h.controller.select(selected);
    expect(h.last()).toMatchObject({ fileName: 'ride.gpx', phase: 'previewing' });
    await flush();
    expect(h.preview).toHaveBeenCalledWith({ orgId }, selected, csrf, expect.any(AbortSignal));
    expect(h.last()).toMatchObject({ phase: 'preview', preview: preview() });

    expect(h.controller.confirm('ride')).toBe(true);
    expect(h.last().phase).toBe('saving');
    await flush();
    expect(h.confirm).toHaveBeenCalledWith({ activityId: id(1), orgId }, { idempotencyKey: key(1), type: 'ride' }, selected, csrf, expect.any(AbortSignal));
    expect(h.last()).toMatchObject({ message: 'GPX activity imported.', phase: 'saved', saved: saved(1) });
    expect(h.onSaved).toHaveBeenCalledWith(saved(1), true);
    // The identity is used up: nothing is confirmed again.
    expect(h.controller.confirm('ride')).toBe(false);
  });

  it('refuses an empty or too large file without sending it', () => {
    const h = harness();
    h.controller.select(file('empty.gpx', 0));
    expect(h.last()).toMatchObject({ message: 'This file is empty, so it cannot be imported.', phase: 'invalid' });
    h.controller.select(new File([new Uint8Array(GPX_IMPORT_MAX_BYTES + 1)], 'big.gpx'));
    expect(h.last()).toMatchObject({ message: 'This file is larger than 10 MB, so it cannot be imported.', phase: 'invalid' });
    expect(h.preview).not.toHaveBeenCalled();
    expect(h.controller.confirm('run')).toBe(false);
  });

  it('explains an unsupported file with the server message and offers nothing to confirm', async () => {
    const h = harness({ preview: () => Promise.reject(apiError(422, 'GPX_UNSUPPORTED', { reason: 'not_gpx_1_1' }, 'The file is GPX 1.0; only GPX 1.1 is supported')) });
    h.controller.select(file());
    await flush();
    expect(h.last()).toMatchObject({
      message: 'This file cannot be imported: The file is GPX 1.0; only GPX 1.1 is supported. Reference 22222222-2222-4222-8222-222222222222.',
      phase: 'invalid',
      preview: null,
    });
    expect(h.controller.confirm('run')).toBe(false);
    const large = harness({ preview: () => Promise.reject(apiError(413, 'GPX_FILE_TOO_LARGE', { maxBytes: GPX_IMPORT_MAX_BYTES })) });
    large.controller.select(file());
    await flush();
    expect(large.last()).toMatchObject({ message: 'This file is larger than 10 MB, so it cannot be imported.', phase: 'invalid' });
  });

  it('retries a preview that failed for a transient reason, and maps lost access', async () => {
    let attempt = 0;
    const h = harness({ preview: () => (++attempt === 1 ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(preview())) });
    h.controller.select(file());
    await flush();
    expect(h.last()).toMatchObject({ message: 'The file could not be checked. Check your connection and try again.', phase: 'preview-failed' });
    h.controller.retryPreview();
    await flush();
    expect(h.last().phase).toBe('preview');

    const denied = harness({ preview: () => Promise.reject(apiError(403, 'FORBIDDEN')) });
    denied.controller.select(file());
    await flush();
    expect(denied.last().phase).toBe('access-denied');
  });

  it('drops the preview of a file replaced by another selection', async () => {
    const first = deferred<GpxImportPreview>();
    const second = deferred<GpxImportPreview>();
    const signals: AbortSignal[] = [];
    let call = 0;
    const h = harness({
      preview: (_input, _file, _csrf, signal) => {
        signals.push(signal);
        return ++call === 1 ? first.promise : second.promise;
      },
    });
    h.controller.select(file('old.gpx'));
    h.controller.select(file('new.gpx'));
    expect(signals[0]?.aborted).toBe(true);
    second.resolve(preview());
    await flush();
    first.resolve(preview(id(9)));
    await flush();
    expect(h.last()).toMatchObject({ fileName: 'new.gpx', phase: 'preview', preview: preview() });
  });

  it('keeps the import identity after an unknown outcome: the retry sends the same file, id, key and type', async () => {
    let attempt = 0;
    const h = harness({
      confirm: () => (++attempt === 1 ? Promise.reject(apiError(503, 'DB_STATEMENT_TIMEOUT', null, 'The database did not finish')) : Promise.resolve({ activity: saved(1), created: false })),
    });
    const selected = file();
    h.controller.select(selected);
    await flush();
    h.controller.confirm('ride');
    await flush();
    expect(h.last()).toMatchObject({ phase: 'save-failed', preview: preview(), uncertain: true });
    expect(h.last().message).toMatch(/^The import was not confirmed: The database did not finish\. .*Importing again is safe and will not create a duplicate\.$/u);
    expect(h.controller.wouldRepeat('ride')).toBe(true);
    expect(h.controller.wouldRepeat('run')).toBe(false);

    h.controller.confirm('ride');
    await flush();
    expect(h.confirm.mock.calls.map(([target, choice, sent]) => [target.activityId, choice, sent])).toEqual([
      [id(1), { idempotencyKey: key(1), type: 'ride' }, selected],
      [id(1), { idempotencyKey: key(1), type: 'ride' }, selected],
    ]);
    expect(h.last()).toMatchObject({ phase: 'saved', saved: saved(1) });
    expect(h.onSaved).toHaveBeenCalledWith(saved(1), false);
  });

  it('keeps the key but takes a new id when the type changes after an unknown outcome, and reports an earlier save', async () => {
    let attempt = 0;
    const h = harness({
      confirm: () =>
        ++attempt === 1
          ? Promise.reject(new DOMException('Request deadline exceeded', 'TimeoutError'))
          : Promise.reject(apiError(409, 'ACTIVITY_ALREADY_SAVED', { activityId: id(1) })),
    });
    h.controller.select(file());
    await flush();
    h.controller.confirm('ride');
    await flush();
    expect(h.last().message).toMatch(/the server did not answer in time/u);
    h.controller.confirm('run');
    await flush();
    expect(h.confirm.mock.calls.map(([target, choice]) => [target.activityId, choice])).toEqual([
      [id(1), { idempotencyKey: key(1), type: 'ride' }],
      [id(2), { idempotencyKey: key(1), type: 'run' }],
    ]);
    expect(h.last()).toMatchObject({ existingActivityId: id(1), phase: 'already-saved', uncertain: false });
    expect(h.controller.confirm('run')).toBe(false);
  });

  it('reports a track that is already imported, naming the activity, and never as saved', async () => {
    const h = harness({ confirm: () => Promise.reject(apiError(409, 'GPX_ALREADY_IMPORTED', { activityId: id(7) })) });
    h.controller.select(file());
    await flush();
    h.controller.confirm('walk');
    await flush();
    expect(h.last()).toMatchObject({
      existingActivityId: id(7),
      message: 'This track is already one of your activities, so it was not imported again.',
      phase: 'already-imported',
    });
    expect(h.onSaved).not.toHaveBeenCalled();
  });

  it('treats a taken id as definitive and retries under a new id with the same key', async () => {
    let attempt = 0;
    const h = harness({
      confirm: (target) => (++attempt === 1 ? Promise.reject(apiError(409, 'ACTIVITY_CONFLICT')) : Promise.resolve({ activity: saved(Number(target.activityId.slice(-2))), created: true })),
    });
    h.controller.select(file());
    await flush();
    h.controller.confirm('hike');
    await flush();
    expect(h.last()).toMatchObject({ phase: 'save-failed', uncertain: false });
    h.controller.confirm('hike');
    await flush();
    expect(h.confirm.mock.calls.map(([target, choice]) => [target.activityId, choice.idempotencyKey])).toEqual([
      [id(1), key(1)],
      [id(2), key(1)],
    ]);
    expect(h.last().phase).toBe('saved');
  });

  it('refuses another selection or a reset while a confirmation is on its way', async () => {
    const pending = deferred<{ activity: ActivityView; created: boolean }>();
    const h = harness({ confirm: () => pending.promise });
    h.controller.select(file());
    await flush();
    h.controller.confirm('ride');
    expect(h.controller.select(file('other.gpx'))).toBe(false);
    h.controller.reset();
    expect(h.last().phase).toBe('saving');
    pending.resolve({ activity: saved(1), created: true });
    await flush();
    expect(h.last().phase).toBe('saved');
  });

  it('stops at once when the session ends or the controller is disposed: requests are aborted and answers dropped', async () => {
    const session = new AbortController();
    const previewAnswer = deferred<GpxImportPreview>();
    const seen: AbortSignal[] = [];
    const h = harness({
      preview: (_input, _file, _csrf, signal) => {
        seen.push(signal);
        return previewAnswer.promise;
      },
      signal: session.signal,
    });
    h.controller.select(file());
    const before = h.snapshots.length;
    session.abort();
    expect(seen[0]?.aborted).toBe(true);
    previewAnswer.resolve(preview());
    await flush();
    expect(h.snapshots).toHaveLength(before);
    expect(h.controller.select(file())).toBe(false);

    const confirmAnswer = deferred<{ activity: ActivityView; created: boolean }>();
    const other = harness({ confirm: () => confirmAnswer.promise });
    other.controller.select(file());
    await flush();
    other.controller.confirm('ride');
    const count = other.snapshots.length;
    other.controller.dispose();
    confirmAnswer.resolve({ activity: saved(1), created: true });
    await flush();
    expect(other.snapshots).toHaveLength(count);
    expect(other.onSaved).not.toHaveBeenCalled();
  });
});

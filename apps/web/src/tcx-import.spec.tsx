import {
  GPX_ALREADY_IMPORTED,
  TCX_IMPORT_MAX_BYTES,
  type ActivityView,
  type TcxImportPreview,
} from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { FileConfirmer, FilePreviewer } from './file-import-controller.js';
import { RunnerApiError } from './runner-api.js';
import { idleTcxImport, TcxImportController, type TcxImportSnapshot } from './tcx-import-controller.js';
import { TcxImportView, type TcxImportViewProps } from './TcxImportPanel.js';

// ADR-0091: the TCX import is the shared file import controller with TCX's codes and wording, and its own preview.
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const csrf = { headerName: 'x-csrf-token' as const, token: 'a'.repeat(43) };
const id = (n: number) => `a9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = (n: number) => `b9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const file = (size = 120) => new File(['x'.repeat(size)], 'swim.tcx', { type: '' });
const previewOf = (duplicateOf: string | null = null): TcxImportPreview => ({
  duplicateOf: duplicateOf === null ? null : { activityId: duplicateOf },
  summary: {
    distanceM: 4000,
    lapCount: 2,
    lapTotals: { distanceMeters: '3999.75', totalTimeSeconds: '3600.5' },
    metricsVersion: 'tcx-summary-1',
    reportedDurationS: 3601,
    startedAt: '2026-11-12T07:00:00.000Z',
  },
});
const saved = (n: number, type: ActivityView['type'] = 'swim'): ActivityView => ({
  activityId: id(n),
  createdAt: '2026-11-13T12:00:00.000Z',
  distanceM: 4000,
  durationS: 3601,
  notes: null,
  rpe: null,
  source: 'tcx',
  startedAt: '2026-11-12T07:00:00.000Z',
  type,
});
const apiError = (status: number, code: string, details: Record<string, unknown> | null = null, message = 'Refused') =>
  new RunnerApiError(message, status, code, '22222222-2222-4222-8222-222222222222', null, details);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(options: { confirm?: FileConfirmer; preview?: FilePreviewer<TcxImportPreview> } = {}) {
  const snapshots: TcxImportSnapshot[] = [];
  let ids = 0;
  let keys = 0;
  const preview = vi.fn<FilePreviewer<TcxImportPreview>>(options.preview ?? (() => Promise.resolve(previewOf())));
  const confirm = vi.fn<FileConfirmer>(options.confirm ?? ((target) => Promise.resolve({ activity: saved(Number(target.activityId.slice(-2))), created: true })));
  const onSaved = vi.fn();
  const controller = new TcxImportController({
    confirm,
    csrf: () => csrf,
    newId: () => id((ids += 1)),
    newKey: () => key((keys += 1)),
    onChange: (snapshot) => snapshots.push(snapshot),
    onSaved,
    orgId,
    preview,
  });
  return { confirm, controller, onSaved, preview, snapshots, last: () => snapshots.at(-1)! };
}

describe('TcxImportController', () => {
  it('previews, requires a confirmation, and saves once', async () => {
    const { confirm, controller, last, onSaved } = harness();
    controller.select(file());
    await flush();
    expect(last()).toMatchObject({ fileName: 'swim.tcx', phase: 'preview', preview: previewOf() });
    expect(confirm).not.toHaveBeenCalled();
    controller.confirm('swim');
    await flush();
    expect(confirm.mock.calls[0]!.slice(0, 2)).toEqual([{ activityId: id(1), orgId }, { idempotencyKey: key(1), type: 'swim' }]);
    expect(last()).toMatchObject({ message: 'TCX activity imported.', phase: 'saved', saved: saved(1) });
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('retries an unknown outcome with the same file, id, key and type, and keeps the key for another type', async () => {
    const outcomes = [Promise.reject(apiError(503, 'SERVICE_UNAVAILABLE')), Promise.reject(new DOMException('t', 'TimeoutError'))];
    for (const outcome of outcomes) outcome.catch(() => undefined);
    const { confirm, controller, last } = harness({ confirm: () => outcomes.shift() ?? Promise.resolve({ activity: saved(2), created: false }) });
    controller.select(file());
    await flush();
    controller.confirm('swim');
    await flush();
    expect(last()).toMatchObject({ phase: 'save-failed', uncertain: true });
    expect(last().message).toMatch(/may already be saved\. Importing again is safe/u);
    expect(controller.wouldRepeat('swim')).toBe(true);
    controller.confirm('swim');
    await flush();
    expect(confirm.mock.calls[1]!.slice(0, 2)).toEqual([{ activityId: id(1), orgId }, { idempotencyKey: key(1), type: 'swim' }]);
    // Another type after an unknown outcome: the same key, a new id.
    controller.confirm('ride');
    await flush();
    expect(confirm.mock.calls[2]!.slice(0, 2)).toEqual([{ activityId: id(2), orgId }, { idempotencyKey: key(1), type: 'ride' }]);
    expect(last().phase).toBe('saved');
  });

  it('reports a TCX duplicate by its own code, naming the existing activity', async () => {
    const duplicate = Promise.reject(apiError(409, 'TCX_ALREADY_IMPORTED', { activityId: id(9) }));
    duplicate.catch(() => undefined);
    const { controller, last } = harness({ confirm: () => duplicate });
    controller.select(file());
    await flush();
    controller.confirm('swim');
    await flush();
    expect(last()).toMatchObject({ existingActivityId: id(9), phase: 'already-imported', uncertain: false });
    expect(last().message).toBe('This TCX activity is already one of your imports, so it was not imported again.');
  });

  it('never treats a GPX duplicate code as a TCX duplicate', async () => {
    const gpx = Promise.reject(apiError(409, GPX_ALREADY_IMPORTED, { activityId: id(9) }));
    gpx.catch(() => undefined);
    const { controller, last } = harness({ confirm: () => gpx });
    controller.select(file());
    await flush();
    controller.confirm('swim');
    await flush();
    expect(last().phase).toBe('save-failed');
    expect(last().existingActivityId).toBeNull();
  });

  it('explains an unsupported or too large file and refuses one above the limit before sending it', async () => {
    const unsupported = Promise.reject(apiError(422, 'TCX_UNSUPPORTED', { reason: 'lap_order' }, 'lap 2: starts at or before the previous lap'));
    unsupported.catch(() => undefined);
    const first = harness({ preview: () => unsupported });
    first.controller.select(file());
    await flush();
    expect(first.last()).toMatchObject({ phase: 'invalid' });
    expect(first.last().message).toBe('This file cannot be imported: lap 2: starts at or before the previous lap. Reference 22222222-2222-4222-8222-222222222222.');

    const tooLarge = Promise.reject(apiError(413, 'TCX_FILE_TOO_LARGE', { maxBytes: TCX_IMPORT_MAX_BYTES }));
    tooLarge.catch(() => undefined);
    const second = harness({ preview: () => tooLarge });
    second.controller.select(file());
    await flush();
    expect(second.last()).toMatchObject({ message: 'This file is larger than 10 MB, so it cannot be imported.', phase: 'invalid' });

    const third = harness();
    third.controller.select(file(TCX_IMPORT_MAX_BYTES + 1));
    expect(third.preview).not.toHaveBeenCalled();
    expect(third.last()).toMatchObject({ phase: 'invalid' });
  });
});

const noop = () => undefined;
function render(snapshot: Partial<TcxImportSnapshot>, props: Partial<TcxImportViewProps> = {}): string {
  return renderToStaticMarkup(
    <TcxImportView
      onChoose={noop}
      onRetry={noop}
      onStartOver={noop}
      onSubmit={noop}
      onType={noop}
      repeats={false}
      snapshot={{ ...idleTcxImport, ...snapshot }}
      timeZone="Europe/Warsaw"
      type=""
      unit="km"
      {...props}
    />,
  );
}

describe('TCX import view', () => {
  it('explains the subset and what is kept before a file is chosen', () => {
    const markup = render({});
    expect(markup).toContain('<h2 id="tcx-import-title">Import a TCX file</h2>');
    expect(markup).toMatch(/TCX v2.*up to 10 MB and 1 000\s+laps/su);
    expect(markup).toMatch(/GPS positions are not needed/u);
    expect(markup).toMatch(/the file, its laps, track, heart rate, calories, notes and\s+device are not kept/u);
    expect(markup).not.toContain('Preview of the TCX file');
  });

  it('names the reported duration, explains the exact sum and its rounding, and requires an explicit type', () => {
    const markup = render({ fileName: 'swim.tcx', phase: 'preview', preview: previewOf() });
    for (const text of ['<dt>Started</dt><dd>12 Nov 2026, 08:00</dd>', '<dt>Reported duration</dt><dd>1:00:01</dd>', '<dt>Distance</dt><dd>4.00 km</dd>', '<dt>Laps</dt><dd>2</dd>']) {
      expect(markup).toContain(text);
    }
    expect(markup).toMatch(/The laps report 3 600\.5 s and\s*3 999\.75 m in total\. Each total is added exactly and rounded once,\s+to the nearest whole second and metre \(halves up\): 3 601 s and\s*4 000 m are saved\./u);
    expect(markup).toMatch(/It is not elapsed time and\s+not moving time/u);
    expect(markup).not.toMatch(/<dt>(Elapsed time|Moving time|Ended)/u);
    expect(markup).toMatch(/not compared with GPX imports, manual entries or GPS runs/u);
    expect(markup).toContain('<option value="" selected="">Choose a type</option>');
    expect(markup).toMatch(/<button class="primary-action" disabled="" type="submit">Import activity<\/button>/u);
    expect(render({ fileName: 'swim.tcx', phase: 'preview', preview: previewOf() }, { type: 'swim' })).toMatch(
      /<button class="primary-action" type="submit">Import activity<\/button>/u,
    );
  });

  it('disables the import of a duplicate and offers an exact retry after an unknown outcome', () => {
    const duplicate = render({ fileName: 'swim.tcx', phase: 'preview', preview: previewOf(id(4)) }, { type: 'swim' });
    expect(duplicate).toMatch(/You already imported this TCX activity/u);
    expect(duplicate).toMatch(/<button class="primary-action" disabled="" type="submit">/u);
    const uncertain = render({ fileName: 'swim.tcx', message: 'The import was not confirmed', phase: 'save-failed', preview: previewOf(), uncertain: true }, { repeats: true, type: 'swim' });
    expect(uncertain).toContain('>Import again</button>');
  });
});

import type { GpxImportPreview } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { activityDurationLabels, activitySourceLabels } from './activity-form.js';
import { idleGpxImport, type GpxImportSnapshot } from './gpx-import-controller.js';
import { GpxImportView, type GpxImportViewProps } from './GpxImportPanel.js';

const preview = (duplicateOf: string | null = null): GpxImportPreview => ({
  duplicateOf: duplicateOf === null ? null : { activityId: duplicateOf },
  summary: {
    distanceM: 12_345,
    elapsedDurationS: 3_725,
    endedAt: '2026-11-09T08:02:05.000Z',
    metricsVersion: 'gpx-summary-1',
    pointCount: 12_000,
    segmentCount: 2,
    startedAt: '2026-11-09T07:00:00.000Z',
  },
});

const noop = () => undefined;
function render(snapshot: Partial<GpxImportSnapshot>, props: Partial<GpxImportViewProps> = {}): string {
  return renderToStaticMarkup(
    <GpxImportView
      onChoose={noop}
      onRetry={noop}
      onStartOver={noop}
      onSubmit={noop}
      onType={noop}
      repeats={false}
      snapshot={{ ...idleGpxImport, ...snapshot }}
      timeZone="Europe/Warsaw"
      type=""
      unit="km"
      {...props}
    />,
  );
}

describe('GPX import view (ADR-0086)', () => {
  it('explains the supported subset and what is kept before a file is chosen', () => {
    const markup = render({});
    expect(markup).toContain('<h2 id="gpx-import-title">Import a GPX file</h2>');
    expect(markup).toMatch(/One GPX 1\.1 track .*up to 10 MB and.*100 000.*points, every point with a time/su);
    expect(markup).toMatch(/the file, its route and its points are not kept, and no map is shown/u);
    expect(markup).toContain('type="file"');
    expect(markup).not.toContain('Preview of the GPX file');
    expect(markup).not.toContain('role="alert"');
  });

  it('shows the server preview with elapsed time named as such, never as moving time, and requires an explicit type', () => {
    const markup = render({ fileName: 'ride.gpx', phase: 'preview', preview: preview() });
    expect(markup).toContain('aria-label="Preview of the GPX file"');
    expect(markup).toContain('What the server read from ride.gpx');
    for (const text of ['<dt>Started</dt><dd>9 Nov 2026, 08:00</dd>', '<dt>Ended</dt><dd>9 Nov 2026, 09:02</dd>', '<dt>Elapsed time</dt><dd>1:02:05</dd>', '<dt>Distance</dt><dd>12.35 km</dd>', '<dt>Points</dt><dd>12 000</dd>', '<dt>Segments</dt><dd>2</dd>']) {
      expect(markup).toContain(text);
    }
    expect(markup).toMatch(/pauses and gaps between segments included; it is not moving\s+time/u);
    expect(markup).not.toMatch(/<dt>Moving time/u);
    expect(markup).toMatch(/not compared with GPS runs recorded in SomaLane/u);
    expect(markup).toContain('<option value="" selected="">Choose a type</option>');
    expect(markup).toMatch(/<button class="primary-action" disabled="" type="submit">Import activity<\/button>/u);
    expect(render({ fileName: 'ride.gpx', phase: 'preview', preview: preview() }, { type: 'ride' })).toMatch(
      /<button class="primary-action" type="submit">Import activity<\/button>/u,
    );
    // Miles when the screen uses miles.
    expect(render({ phase: 'preview', preview: preview() }, { unit: 'mi' })).toContain('<dt>Distance</dt><dd>7.67 mi</dd>');
  });

  it('says a previewed track is already imported and offers no import', () => {
    const markup = render({ phase: 'preview', preview: preview('a9000000-0000-4000-8000-000000000001') }, { type: 'ride' });
    expect(markup).toMatch(/You already imported this track, so it cannot be imported again/u);
    expect(markup).toMatch(/<button class="primary-action" disabled="" type="submit">Import activity<\/button>/u);
    expect(markup).not.toContain('a9000000-0000-4000-8000-000000000001');
  });

  it('shows checking, importing, an uncertain outcome with an exact retry, and the states that only allow another file', () => {
    expect(render({ fileName: 'ride.gpx', phase: 'previewing' })).toContain('<p class="activity-form__status" role="status">Checking ride.gpx…</p>');
    expect(render({ phase: 'saving', preview: preview() }, { type: 'ride' })).toMatch(/disabled="" type="submit">Importing…<\/button>/u);

    const uncertain = { message: 'The import was not confirmed: the connection failed. It may already be saved.', phase: 'save-failed' as const, preview: preview(), uncertain: true };
    const repeat = render(uncertain, { repeats: true, type: 'ride' });
    expect(repeat).toContain('type="submit">Import again</button>');
    expect(repeat).toContain('<p class="activity-form__warning" role="alert">The import was not confirmed');
    const changed = render(uncertain, { repeats: false, type: 'run' });
    expect(changed).toMatch(/Your previous attempt may already have gone through/u);
    expect(changed).toContain('type="submit">Import activity</button>');

    for (const phase of ['invalid', 'already-imported', 'already-saved', 'access-denied'] as const) {
      const markup = render({ message: 'Explained.', phase });
      expect(markup).toContain('<p class="activity-form__failure" role="alert">Explained.</p>');
      expect(markup).toContain('Choose another file');
      expect(markup).not.toContain('Preview of the GPX file');
    }
    const failed = render({ message: 'The file could not be checked.', phase: 'preview-failed' });
    expect(failed).toContain('>Retry</button>');
    expect(render({ message: 'GPX activity imported.', phase: 'saved' })).toContain('<p class="activity-form__status" role="status">GPX activity imported.</p>');
  });

  it('labels provenance and duration by source, so an import is never shown as manually entered', () => {
    expect(activitySourceLabels).toEqual({ gpx: 'GPX import', manual: 'Entered manually' });
    expect(activityDurationLabels).toEqual({ gpx: 'Elapsed time', manual: 'Duration' });
  });
});

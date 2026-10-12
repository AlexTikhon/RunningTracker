import type { RunSearchItem } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AppliedFilters, RunSearchResults } from './RunSearchResults.js';
import type { RunSearchSnapshot } from './run-search-controller.js';
import type { RunSearchFilters } from './run-search.js';

const noop = () => undefined;
const filters: RunSearchFilters = {
  maxDistance: null,
  minDistance: null,
  period: { kind: 'preset', preset: 'this-month' },
  sort: 'newest',
  timeZone: 'Europe/Warsaw',
  unit: 'km',
};
const runItem = (patch: Partial<RunSearchItem> = {}): RunSearchItem => ({
  distanceM: 10_000,
  gpsQuality: 'good',
  observedDurationS: 1_800,
  runId: 'c1000000-0000-4000-8000-000000000001',
  startedAt: '2026-10-31T23:30:00.000Z',
  ...patch,
});
const snapshot = (patch: Partial<RunSearchSnapshot> = {}): RunSearchSnapshot => ({
  hasMore: false,
  items: [],
  loadingMore: false,
  message: null,
  moreMessage: null,
  outdated: false,
  pendingSummaryCount: 0,
  resolved: { fromDate: '2026-10-01', toDate: '2026-10-31' },
  status: 'ready',
  ...patch,
});

function render(state: RunSearchSnapshot, applied: RunSearchFilters = filters): string {
  return renderToStaticMarkup(
    <RunSearchResults filters={applied} onLoadMore={noop} onRetry={noop} snapshot={state} />,
  );
}

describe('RunSearchResults', () => {
  it('says it is searching while the first page loads', () => {
    const markup = render(snapshot({ status: 'loading' }));
    expect(markup).toContain('Searching your runs');
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('Load more');
  });

  it('says plainly that nothing of the person’s own matches', () => {
    const markup = render(snapshot());
    expect(markup).toContain('No finished runs of yours match these filters');
    expect(markup).not.toContain('Load more');
    expect(markup).not.toContain('<ol');
  });

  it('shows an error with a retry', () => {
    const markup = render(snapshot({ message: 'The database is busy.', status: 'error' }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('The database is busy.');
    expect(markup).toContain('Retry');
    expect(markup).not.toContain('No finished runs');
  });

  it('shows lost access as an alert and no results', () => {
    const markup = render(snapshot({ message: 'You no longer have access to your runs in this organization.', status: 'access-denied' }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('no longer have access');
    expect(markup).not.toContain('<ol');
  });

  it('shows each run with its start in the selected zone, distance, observed duration and GPS indicator', () => {
    const markup = render(snapshot({ items: [runItem()] }));
    expect(markup).toContain('1 Nov 2026, 00:30');
    expect(markup).toContain('dateTime="2026-10-31T23:30:00.000Z"');
    expect(markup).toContain('10.00 km');
    expect(markup).toContain('Observed duration');
    expect(markup).toContain('30:00');
    expect(markup).toContain('GPS data good');
  });

  it('uses the unit of the applied filters', () => {
    const markup = render(snapshot({ items: [runItem()] }), { ...filters, unit: 'mi' });
    expect(markup).toContain('6.21 mi');
    expect(markup).not.toContain('10.00 km');
  });

  it('states the meaning of observed duration and does not call it moving time', () => {
    const markup = render(snapshot({ items: [runItem()] }));
    expect(markup).toMatch(/sum of the time between consecutive accepted GPS measurements/iu);
    expect(markup).toMatch(/gaps/iu);
    // The summary adds up accepted edges; it is not the span from the first to the last measurement.
    expect(markup).not.toMatch(/between the first and (the )?last/iu);
    expect(markup).not.toMatch(/moving time|workout time|pace/iu);
  });

  it.each([
    ['poor', 'Poor GPS data'],
    ['insufficient', 'Insufficient GPS data'],
    ['good', 'GPS data good'],
  ] as const)('labels %s GPS quality in words', (gpsQuality, label) => {
    const markup = render(snapshot({ items: [runItem({ gpsQuality })] }));
    expect(markup).toContain(label);
    expect(markup).toContain(`run-card__quality--${gpsQuality}`);
  });

  describe('runs still being processed', () => {
    it('explains them, in the singular and the plural, without claiming they match', () => {
      const withBounds = { ...filters, minDistance: '5' };
      const many = render(snapshot({ items: [runItem()], pendingSummaryCount: 2 }), withBounds);
      expect(many).toContain('2 finished runs');
      expect(many).toContain('still being processed');
      expect(many).toMatch(/not (yet )?known whether|not known whether/iu);
      const one = render(snapshot({ items: [runItem()], pendingSummaryCount: 1 }), withBounds);
      expect(one).toContain('1 finished run ');
      expect(one).not.toContain('1 finished runs');
    });

    it('speaks of the distance filter only when one is applied', () => {
      const plain = render(snapshot({ items: [runItem()], pendingSummaryCount: 3 }));
      expect(plain).toContain('still being processed');
      expect(plain).not.toMatch(/distance filter/iu);
    });

    it('is absent when there are none and is shown with an empty list too', () => {
      expect(render(snapshot({ items: [runItem()] }))).not.toContain('still being processed');
      const empty = render(snapshot({ pendingSummaryCount: 4 }));
      expect(empty).toContain('No finished runs of yours match these filters');
      expect(empty).toContain('4 finished runs');
    });
  });

  describe('pages', () => {
    it('offers the next page when the server has one', () => {
      const markup = render(snapshot({ hasMore: true, items: [runItem()] }));
      expect(markup).toContain('Load more runs');
      expect(markup).not.toContain('disabled=""');
    });

    it('shows the next page loading and disables the button', () => {
      const markup = render(snapshot({ hasMore: true, items: [runItem()], loadingMore: true }));
      expect(markup).toContain('Loading more');
      expect(markup).toContain('disabled=""');
    });

    it('keeps the runs and offers to try the next page again after a failure', () => {
      const markup = render(
        snapshot({ hasMore: true, items: [runItem()], moreMessage: 'The server is busy.' }),
      );
      expect(markup).toContain('The server is busy.');
      expect(markup).toContain('Try again');
      expect(markup).toContain('1 Nov 2026, 00:30');
    });

    it('offers a new search instead of a next page when the list is out of date', () => {
      const markup = render(
        snapshot({
          hasMore: true,
          items: [runItem()],
          moreMessage: 'These results are out of date. Search again to see the current list.',
          outdated: true,
        }),
      );
      expect(markup).toContain('out of date');
      expect(markup).toContain('Search again');
      expect(markup).not.toContain('Load more runs');
    });
  });

  it('keeps internal vocabulary out of the screen', () => {
    const markup = render(snapshot({ items: [runItem()], pendingSummaryCount: 2 }));
    expect(markup).not.toMatch(/revision|\bSQL\b|stage|source_revision|summary|cursor|keyset/iu);
  });
});

describe('AppliedFilters', () => {
  it('lists what was applied, apart from the editable fields, with the zone', () => {
    const markup = renderToStaticMarkup(
      <AppliedFilters
        filters={{ ...filters, maxDistance: '10', minDistance: '5', sort: 'longest' }}
        resolved={{ fromDate: '2026-10-01', toDate: '2026-10-31' }}
      />,
    );
    expect(markup).toContain('Applied filters');
    expect(markup).toContain('This month · 1 Oct 2026 – 31 Oct 2026');
    expect(markup).toContain('5–10 km');
    expect(markup).toContain('Longest first');
    expect(markup).toContain('Europe/Warsaw');
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('<select');
  });
});

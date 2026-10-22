import type { RunSearchItem } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ArchiveRunShare, openSharingItem } from './ArchiveRunShare.js';
import type { RunSearchSnapshot } from './run-search-controller.js';

const runA = 'a1000000-0000-4000-8000-0000000000aa';
const runB = 'b2000000-0000-4000-8000-0000000000bb';
const item = (runId: string): RunSearchItem => ({
  distanceM: 10_000,
  gpsQuality: 'good',
  observedDurationS: 1_800,
  runId,
  startedAt: '2026-10-21T06:00:00.000Z',
});
const snapshot = (patch: Partial<RunSearchSnapshot> = {}): RunSearchSnapshot => ({
  hasMore: false,
  items: [item(runA), item(runB)],
  loadingMore: false,
  message: null,
  moreMessage: null,
  outdated: false,
  pendingSummaryCount: 0,
  resolved: { fromDate: '2026-10-01', toDate: '2026-10-31' },
  status: 'ready',
  ...patch,
});
const search = 'user/org/3';

describe('the run whose sharing panel is open in My runs', () => {
  it('is none until the person chooses one', () => {
    expect(openSharingItem(null, search, snapshot())).toBeNull();
  });

  it('is the chosen run while the shown search lists it, also while and after another page loads', () => {
    const selection = { runId: runB, searchKey: search };
    expect(openSharingItem(selection, search, snapshot())?.runId).toBe(runB);
    expect(openSharingItem(selection, search, snapshot({ hasMore: true, loadingMore: true }))?.runId).toBe(runB);
    expect(
      openSharingItem(selection, search, snapshot({ items: [item(runA), item(runB), item('c3000000-0000-4000-8000-0000000000cc')] }))
        ?.runId,
    ).toBe(runB);
    // A next page that failed or went out of date leaves the shown list, and the panel, as they are.
    expect(openSharingItem(selection, search, snapshot({ moreMessage: 'x', outdated: true }))?.runId).toBe(runB);
  });

  it('closes for a newly applied search, even one that lists the same run', () => {
    expect(openSharingItem({ runId: runB, searchKey: search }, 'user/org/4', snapshot())).toBeNull();
  });

  it('closes when the first page is read again, access is lost, or the search fails', () => {
    const selection = { runId: runA, searchKey: search };
    expect(openSharingItem(selection, search, snapshot({ items: [], status: 'loading' }))).toBeNull();
    expect(openSharingItem(selection, search, snapshot({ items: [], status: 'access-denied' }))).toBeNull();
    expect(openSharingItem(selection, search, snapshot({ items: [], status: 'error' }))).toBeNull();
  });

  it('closes when the authoritative list no longer has the run', () => {
    expect(openSharingItem({ runId: runA, searchKey: search }, search, snapshot({ items: [item(runB)] }))).toBeNull();
  });
});

describe('ArchiveRunShare', () => {
  const html = renderToStaticMarkup(
    <ArchiveRunShare
      id="panel-1"
      onClose={() => undefined}
      runId={runA}
      scope={{
        csrfToken: 't'.repeat(43),
        orgId: '11111111-1111-4111-8111-111111111111',
        signal: new AbortController().signal,
        userId: '22222222-2222-4222-8222-222222222222',
      }}
      startedAtLabel="21 Oct 2026, 08:00"
    />,
  );

  it('names the run by the date the card shows and the start of its identifier', () => {
    const labelledBy = /<section aria-labelledby="([^"]+)" class="archive-share" id="panel-1"/u.exec(html)?.[1];
    expect(labelledBy).toBeDefined();
    expect(html).toContain(`id="${labelledBy}"`);
    expect(html).toContain('Sharing for your run of 21 Oct 2026, 08:00 <span class="run-id">#a1000000</span>');
    expect(html).toContain('#a1000000');
    expect(html).not.toContain(runA);
  });

  it('offers Close, and starts by loading with nothing to act on yet', () => {
    expect(html).toMatch(/<button type="button">Close<\/button>/u);
    expect(html).toContain('Loading coaches and current sharing');
    expect(html).not.toContain('>Share<');
    expect(html).not.toContain('>Revoke<');
    expect(html).toContain('This run is finished');
  });

  it('never puts the CSRF token or the person on the screen', () => {
    expect(html).not.toContain('t'.repeat(43));
    expect(html).not.toContain('22222222-2222-4222-8222-222222222222');
  });
});

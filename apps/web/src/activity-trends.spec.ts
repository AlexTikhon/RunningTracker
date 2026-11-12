import { describe, expect, it } from 'vitest';

import {
  activityChartDescription,
  activityChartGeometry,
  activitySummaryLines,
  activityTableRows,
  activityTrendMeasureLabels,
  activityTrendTypesFor,
  dayLengthNotes,
  displayDays,
  NONE_LOGGED,
  SKIPPED_DATE,
  UNKNOWN,
} from './activity-trends.js';
import { activityTrendsFixture } from './activity-trends-fixtures.js';

describe('activity trends presentation', () => {
  it('names each source’s duration and offers a recorded run only as a run', () => {
    expect(activityTrendMeasureLabels('manual')).toEqual({ count: 'Entries', distance: 'Distance', duration: 'Entered duration' });
    expect(activityTrendMeasureLabels('gpx').duration).toBe('Elapsed time');
    expect(activityTrendMeasureLabels('recorded_run')).toMatchObject({ count: 'Runs', duration: 'Observed duration' });
    expect(activityTrendTypesFor('recorded_run')).toEqual(['run']);
    expect(activityTrendTypesFor('manual')).toContain('swim');
  });

  it('says that nothing logged is not inactivity', () => {
    const lines = activitySummaryLines(activityTrendsFixture());
    expect(lines).toEqual([
      'No manually entered activities of type ride on any of these 28 days. That only means nothing of this kind was logged here; it does not mean you were inactive.',
    ]);
  });

  it('gives coverage and totals over exactly the items that record them', () => {
    const trends = activityTrendsFixture({
      days: {
        '2026-11-10': { count: 2, distance: { totalM: 12_345, withValue: 1 }, duration: { totalS: 5_400, withValue: 2 } },
        '2026-11-12': { count: 1, distance: { totalM: 0, withValue: 1 }, duration: { totalS: 600, withValue: 1 } },
      },
    });
    expect(activitySummaryLines(trends)).toEqual([
      '3 entries on 2 of 28 days. On the other 26 days none was logged, which does not mean you were inactive.',
      'Entered duration: 1:40:00 in total, from all 3 entries.',
      'Distance: 12.35 km from 2 of 3 entries. The other entry is unknown, not zero, and adds nothing.',
    ]);
  });

  it('counts pending and stale runs and gives their metrics as unknown', () => {
    const trends = activityTrendsFixture({
      days: {
        '2026-11-03': { count: 3, distance: { totalM: 5_012, withValue: 1 }, duration: { totalS: 2_400, withValue: 1 }, summaries: { current: 1, pending: 1, stale: 1 } },
        '2026-11-04': { count: 1, summaries: { current: 0, pending: 0, stale: 1 } },
      },
      source: 'recorded_run',
    });
    expect(activitySummaryLines(trends)).toEqual([
      '4 runs on 2 of 28 days. On the other 26 days none was logged, which does not mean you were inactive.',
      'Observed duration: 40:00 from 1 of 4 runs. The other 3 are unknown, not zero, and add nothing.',
      'Distance: 5.01 km from 1 of 4 runs. The other 3 are unknown, not zero, and add nothing.',
      'GPS summaries: 1 current, 1 still being prepared, 2 being updated after new data. Only a current summary gives a duration or distance.',
    ]);
    const rows = activityTableRows(trends);
    const stale = rows.find((row) => row.localDate === '2026-11-04')!;
    expect(stale).toMatchObject({ count: '1', distance: UNKNOWN, duration: UNKNOWN, summaryDetail: 'Summary 1 being updated' });
    expect(rows.find((row) => row.localDate === '2026-11-03')).toMatchObject({ distance: '5.01 km', distanceDetail: 'From 1 of 3 runs', summaryDetail: 'Summary 1 being prepared, 1 being updated' });
  });

  it('lists every date newest first, with nothing logged, unknown and a recorded zero apart', () => {
    const trends = activityTrendsFixture({
      days: {
        '2026-11-11': { count: 1, distance: { totalM: 0, withValue: 1 }, duration: { totalS: 60, withValue: 1 } },
        '2026-11-12': { count: 2, duration: { totalS: 1_200, withValue: 2 } },
      },
    });
    const rows = activityTableRows(trends);
    expect(rows).toHaveLength(28);
    expect(rows[0]).toMatchObject({ count: '2', distance: UNKNOWN, distanceDetail: 'Not recorded for any of 2 entries', duration: '20:00', localDate: '2026-11-12', logged: true });
    expect(rows[1]).toMatchObject({ distance: '0.00 km', distanceDetail: null, localDate: '2026-11-11' });
    expect(rows[2]).toMatchObject({ count: NONE_LOGGED, distance: '–', duration: '–', localDate: '2026-11-10', logged: false });
  });

  it('draws a bar per value, a baseline dot for a recorded zero, an open marker for unknown and a tick for nothing logged', () => {
    const trends = activityTrendsFixture({
      days: {
        '2026-11-10': { count: 1, distance: { totalM: 10_000, withValue: 1 } },
        '2026-11-11': { count: 1, distance: { totalM: 0, withValue: 1 } },
        '2026-11-12': { count: 2 },
      },
    });
    const geometry = activityChartGeometry(trends, 'distance');
    const kinds = Object.fromEntries(geometry.marks.map((mark) => [mark.localDate, mark.kind]));
    expect(kinds['2026-11-10']).toBe('bar');
    expect(kinds['2026-11-11']).toBe('zero');
    expect(kinds['2026-11-12']).toBe('unknown');
    expect(kinds['2026-11-09']).toBe('none');
    expect(geometry.yTicks.map((tick) => tick.label)).toEqual(['0', '10.00 km']);
    // Counts: every date with items is a bar; nothing is unknown.
    const counts = activityChartGeometry(trends, 'count').marks;
    expect(counts.filter((mark) => mark.kind === 'bar')).toHaveLength(3);
    expect(counts.filter((mark) => mark.kind === 'unknown')).toHaveLength(0);
    // Bars stay inside the plot, with a gap between neighbours.
    const bar = geometry.marks.find((mark) => mark.kind === 'bar');
    expect(bar?.kind === 'bar' && bar.height).toBeCloseTo(geometry.plot.bottom - geometry.plot.top, 5);
    expect(activityChartDescription(trends, 'distance')).toBe(
      'Distance of manually entered activities of type ride per date over 28 days: 2 with a value, 1 with items but an unknown value, 25 with nothing logged. The table below lists every date.',
    );
  });

  it('names a 23- or 25-hour date in the zone', () => {
    const warsaw = (localDate: string) => Date.parse(`${localDate}T00:00:00Z`) - (localDate <= '2026-10-25' ? 7_200_000 : 3_600_000);
    const next = (localDate: string) => new Date(Date.parse(`${localDate}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const trends = activityTrendsFixture({
      bounds: (localDate) => ({ endsAt: new Date(warsaw(next(localDate))).toISOString(), startsAt: new Date(warsaw(localDate)).toISOString() }),
      timeZone: 'Europe/Warsaw',
    });
    expect(dayLengthNotes(trends)).toEqual(['Sun, 25 Oct 2026 has 25 hours in Europe/Warsaw because the clocks change.']);
    expect(displayDays(trends)).toHaveLength(28);
  });

  it('says a date the zone skipped did not happen, instead of calling it a clock change (Pacific/Apia, 2011-12-30)', () => {
    const apia = (localDate: string) => Date.parse(`${localDate}T00:00:00Z`) + (localDate <= '2011-12-30' ? 10 : -14) * 3_600_000;
    const next = (localDate: string) => new Date(Date.parse(`${localDate}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const trends = activityTrendsFixture({
      bounds: (localDate) => ({ endsAt: new Date(apia(next(localDate))).toISOString(), startsAt: new Date(apia(localDate)).toISOString() }),
      days: { '2011-12-29': { count: 1 }, '2011-12-31': { count: 1 } },
      endDate: '2012-01-05',
      timeZone: 'Pacific/Apia',
      today: '2026-11-12',
    });
    expect(dayLengthNotes(trends)).toEqual([
      'Fri, 30 Dec 2011 did not happen in Pacific/Apia: its clocks went from the end of the day before straight to the day after, so this date had no hours and nothing can be logged on it.',
    ]);
    const rows = activityTableRows(trends);
    expect(rows).toHaveLength(28);
    expect(rows.find((row) => row.localDate === '2011-12-30')).toMatchObject({ count: SKIPPED_DATE, distance: '–', duration: '–', logged: false });
    expect(rows.find((row) => row.localDate === '2011-12-28')).toMatchObject({ count: NONE_LOGGED });
    const mark = activityChartGeometry(trends, 'count').marks.find((entry) => entry.localDate === '2011-12-30');
    expect(mark).toMatchObject({ kind: 'none', label: 'Fri, 30 Dec 2011: skipped in this time zone, no hours to log' });
    expect(activitySummaryLines(trends)[0]).toBe(
      '2 entries on 2 of 28 days. On the other 26 days none was logged (1 of them did not happen in this time zone), which does not mean you were inactive.',
    );
    expect(activityChartDescription(trends, 'count')).toContain('26 with nothing logged (1 of them did not happen in this time zone)');
  });

  it('never writes judgements, targets, predictions or advice', () => {
    const text = [
      ...activitySummaryLines(activityTrendsFixture()),
      ...activitySummaryLines(activityTrendsFixture({ days: { '2026-11-12': { count: 1 } } })),
      ...activitySummaryLines(activityTrendsFixture({ days: { '2026-11-12': { count: 1 } }, source: 'recorded_run' })),
    ].join(' ');
    expect(text).not.toMatch(/\b(goal|target|should|great|well done|too (little|much)|healthy|lazy|recommend|consider|try to|predict|forecast|streak|improv)\w*/iu);
  });
});

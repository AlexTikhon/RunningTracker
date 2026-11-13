import { describe, expect, it } from 'vitest';

import {
  activityChartDescription,
  activityChartGeometry,
  activityComparisonView,
  activitySummaryLines,
  activityTableRows,
  activityTrendMeasureLabels,
  activityTrendTypesFor,
  dayLengthNotes,
  displayDays,
  formatPercentChange,
  formatSignedChange,
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

describe('activity trends comparison presentation (ADR-0090)', () => {
  // A finished range: 15 Oct – 11 Nov 2026, the previous period 17 Sep – 14 Oct 2026.
  const finished = { endDate: '2026-11-11', today: '2026-11-12' };
  const ride = (count: number, totalS: number, totalM: number | null, withDistance = totalM === null ? 0 : count) => ({
    count,
    distance: { totalM, withValue: withDistance },
    duration: { totalS, withValue: count },
  });

  it('formats server-computed changes with their sign and one decimal, never computing them', () => {
    expect(formatSignedChange('count', 2)).toBe('+2');
    expect(formatSignedChange('count', 0)).toBe('0');
    expect(formatSignedChange('duration', -1_800)).toBe('−30:00');
    expect(formatSignedChange('distance', 6_000)).toBe('+6.00 km');
    expect(formatPercentChange(50)).toBe('+50.0%');
    expect(formatPercentChange(-12.3)).toBe('−12.3%');
    expect(formatPercentChange(0)).toBe('0.0%');
  });

  it('shows both periods, values with coverage, and signed changes with percentages', () => {
    const trends = activityTrendsFixture({
      ...finished,
      days: { '2026-11-01': ride(3, 5_400, 30_000) },
      previous: { '2026-10-01': ride(2, 7_200, 24_000) },
    });
    const view = activityComparisonView(trends)!;
    expect(view.periods).toEqual({ current: '15 Oct 2026 – 11 Nov 2026 (28 dates)', previous: '17 Sep 2026 – 14 Oct 2026 (28 dates)' });
    expect(view.notes).toEqual(['Coverage counts only what was logged: a total from all entries does not mean that every activity was logged.']);
    expect(view.rows).toEqual([
      {
        change: { detail: null, status: 'available', value: '+1 (+50.0%)' },
        current: { detail: null, value: '3' },
        label: 'Entries',
        measure: 'count',
        previous: { detail: null, value: '2' },
      },
      {
        change: { detail: null, status: 'available', value: '−30:00 (−25.0%)' },
        current: { detail: 'From all 3 entries', value: '1:30:00' },
        label: 'Entered duration',
        measure: 'duration',
        previous: { detail: 'From all 2 entries', value: '2:00:00' },
      },
      {
        change: { detail: null, status: 'available', value: '+6.00 km (+25.0%)' },
        current: { detail: 'From all 3 entries', value: '30.00 km' },
        label: 'Distance',
        measure: 'distance',
        previous: { detail: 'From all 2 entries', value: '24.00 km' },
      },
    ]);
  });

  it('keeps an absolute change for a zero baseline and explains partial coverage instead of a change', () => {
    const trends = activityTrendsFixture({
      ...finished,
      days: { '2026-11-01': ride(2, 1_200, 2_000, 1) },
      previous: { '2026-10-01': ride(1, 0, 0) },
    });
    const [, duration, distance] = activityComparisonView(trends)!.rows;
    expect(duration!.change).toEqual({ detail: 'No percentage: the previous total is 0.', status: 'available', value: '+20:00' });
    expect(distance!.current).toEqual({ detail: 'From 1 of 2 entries', value: '2.00 km' });
    expect(distance!.change).toEqual({ detail: '1 entry does not record it in this period.', status: 'unavailable', value: 'Not compared' });
  });

  it('describes empty periods without calling them zero', () => {
    const [count, duration] = activityComparisonView(activityTrendsFixture(finished))!.rows;
    expect(count!.change).toEqual({ detail: 'No percentage: the previous total is 0.', status: 'available', value: '0' });
    expect(count!.current).toEqual({ detail: NONE_LOGGED, value: '0' });
    expect(duration!.current).toEqual({ detail: NONE_LOGGED, value: '–' });
    expect(duration!.change.detail).toBe('Nothing was logged in this period, so it has no total. Nothing was logged in the previous period, so it has no total.');
  });

  it('says a range ending today is in progress and compares nothing, keeping both periods’ values', () => {
    const trends = activityTrendsFixture({ days: { '2026-11-12': ride(1, 600, 1_000) }, previous: { '2026-10-01': ride(1, 600, 1_000) } });
    const view = activityComparisonView(trends)!;
    expect(view.notes[0]).toBe(
      'This period includes today, so it can still change. Changes are shown only for periods that have ended: choose an end date before today to compare.',
    );
    expect(view.rows.map((row) => row.change.value)).toEqual(['Not compared', 'Not compared', 'Not compared']);
    // The period reason is said once, as a note, not in every row.
    expect(view.rows.map((row) => row.change.detail)).toEqual([null, null, null]);
    expect(view.rows[0]!.previous.value).toBe('1');
  });

  it('never presents a shortened or missing previous period as a full one', () => {
    const shortened = activityComparisonView(activityTrendsFixture({ endDate: '2000-02-10', today: '2026-11-12' }))!;
    expect(shortened.periods.previous).toBe('1 Jan 2000 – 13 Jan 2000 (13 dates)');
    expect(shortened.notes[0]).toBe('The previous period is cut short by 1 Jan 2000 (13 of 28 dates), so it is not compared as a full period.');
    const missing = activityComparisonView(activityTrendsFixture({ endDate: '2000-01-10', today: '2026-11-12' }))!;
    expect(missing.periods.previous).toBe('none (before 1 Jan 2000)');
    expect(missing.notes.slice(0, 2)).toEqual([
      'This period starts on 1 Jan 2000, the earliest date, so it has 10 of 28 dates and is not compared.',
      'The previous 28 dates (16 Nov 1999 – 13 Dec 1999) are before 1 Jan 2000, the earliest date, so there is nothing to compare with.',
    ]);
    expect(missing.rows[0]!.previous).toEqual({ detail: 'Before 1 Jan 2000', value: '–' });
  });

  it('names pending and stale run summaries in each period', () => {
    const trends = activityTrendsFixture({
      ...finished,
      days: { '2026-11-02': { count: 2, distance: { totalM: 5_000, withValue: 1 }, duration: { totalS: 1_800, withValue: 1 }, summaries: { current: 1, pending: 1, stale: 0 } } },
      previous: { '2026-10-02': { count: 1, summaries: { current: 0, pending: 0, stale: 1 } } },
      source: 'recorded_run',
    });
    const [count, duration] = activityComparisonView(trends)!.rows;
    expect(count!.change.value).toBe('+1 (+100.0%)');
    expect(duration!.label).toBe('Observed duration');
    expect(duration!.current.detail).toBe('From 1 of 2 runs (summary 1 being prepared)');
    expect(duration!.previous).toEqual({ detail: 'None of 1 run records it (summary 1 being updated)', value: UNKNOWN });
    expect(duration!.change.detail).toBe(
      '1 run has a GPS summary still being prepared in this period. 1 run has a GPS summary being updated after new data in the previous period.',
    );
  });

  it('is absent from an answer without a comparison', () => {
    expect(activityComparisonView(activityTrendsFixture({ comparison: false }))).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import {
  checkInRows,
  computedLine,
  dayLengthNote,
  formatEnteredDuration,
  gpsDistanceText,
  gpsRunsSummary,
  isNoteOnlyCheckIn,
  manualActivityRows,
  manualActivitiesSummary,
  movementRows,
  storedZoneNote,
} from './daily-overview.js';
import { noteOnlyCheckIn, overviewFixture } from './daily-overview-fixtures.js';

describe('daily overview presentation', () => {
  it('shows recorded check-in values, a recorded zero as zero and the rest as not recorded', () => {
    expect(checkInRows({ recorded: false })).toEqual([]);
    expect(checkInRows({ ...noteOnlyCheckIn, hasNote: false, mood: 4, sleepMinutes: 450, soreness: 0 })).toEqual([
      { label: 'Sleep', value: '7 h 30 min' },
      { label: 'Sleep quality', value: 'Not recorded' },
      { label: 'Mood', value: '4 of 5' },
      { label: 'Soreness', value: '0 of 10' },
      { label: 'Weight', value: 'Not recorded' },
    ]);
    expect(checkInRows({ ...noteOnlyCheckIn, sleepMinutes: 0, weightKg: 72.35 }).filter((row) => row.value !== 'Not recorded')).toEqual([
      { label: 'Sleep', value: '0 h 00 min' },
      { label: 'Weight', value: '72.35 kg' },
    ]);
  });

  it('recognises a note-only check-in, and only that', () => {
    expect(isNoteOnlyCheckIn(noteOnlyCheckIn)).toBe(true);
    expect(isNoteOnlyCheckIn({ ...noteOnlyCheckIn, soreness: 0 })).toBe(false);
    expect(isNoteOnlyCheckIn({ recorded: false })).toBe(false);
  });

  it('shows movement as entered: zero is zero, empty is not recorded', () => {
    expect(movementRows({ recorded: false })).toEqual([]);
    expect(movementRows({ activeEnergyKcal: null, recorded: true, source: 'manual', steps: 0, timeZone: 'UTC' })).toEqual([
      { label: 'Steps', value: '0 steps' },
      { label: 'Active energy', value: 'Not recorded' },
    ]);
    expect(movementRows({ activeEnergyKcal: 412.5, recorded: true, source: 'manual', steps: 8042, timeZone: 'UTC' })).toEqual([
      { label: 'Steps', value: '8,042 steps' },
      { label: 'Active energy', value: '412.5 kcal' },
    ]);
  });

  it('formats entered durations', () => {
    expect([30, 60, 90, 2700, 3600, 5400, 10_800, 172_800].map(formatEnteredDuration)).toEqual([
      '30 s',
      '1 min',
      '1 min 30 s',
      '45 min',
      '1 h 00 min',
      '1 h 30 min',
      '3 h 00 min',
      '48 h 00 min',
    ]);
  });

  it('summarises manual activities as started on the day, with the full entered duration, by type', () => {
    expect(manualActivitiesSummary(overviewFixture())).toBe('No manual activity started on this day.');
    const overview = overviewFixture({
      manualActivities: {
        byType: [
          { count: 1, enteredDurationS: 10_800, type: 'run' },
          { count: 2, enteredDurationS: 1800, type: 'strength' },
        ],
        count: 3,
        enteredDurationS: 12_600,
      },
    });
    expect(manualActivitiesSummary(overview)).toBe('3 activities started on this day, 3 h 30 min entered in total.');
    expect(manualActivityRows(overview)).toEqual([
      { label: 'Run', value: '1 · 3 h 00 min entered' },
      { label: 'Strength', value: '2 · 30 min entered' },
    ]);
  });

  it('gives a GPS distance only from current summaries, and names a partial total by its runs', () => {
    const runs = (count: number, withCurrentDistance: number, currentDistanceM: number | null) => ({
      count,
      currentDistanceM,
      withCurrentDistance,
      withoutCurrentDistance: count - withCurrentDistance,
    });
    expect(gpsRunsSummary(runs(0, 0, null))).toBe('No finished GPS run started on this day.');
    expect(gpsDistanceText(runs(0, 0, null))).toBeNull();
    expect(gpsRunsSummary(runs(1, 1, 5012))).toBe('1 finished GPS run started on this day.');
    expect(gpsDistanceText(runs(1, 1, 5012))).toBe('Distance: 5.01 km.');
    expect(gpsDistanceText(runs(2, 2, 10_000))).toBe('Distance: 10.00 km in total.');
    expect(gpsDistanceText(runs(3, 1, 5012))).toBe('Distance: 5.01 km from 1 of 3 runs; 2 runs have no distance yet, so the total is partial.');
    expect(gpsDistanceText(runs(2, 1, 5012))).toBe('Distance: 5.01 km from 1 of 2 runs; 1 run has no distance yet, so the total is partial.');
    expect(gpsDistanceText(runs(1, 0, null))).toBe('No distance is available yet for this run.');
    expect(gpsDistanceText(runs(2, 0, null))).toBe('No distance is available yet for these runs.');
    expect(gpsDistanceText(runs(2, 0, null))).not.toContain('0.00 km');
  });

  it('explains a stored zone that differs from the view zone without moving the record', () => {
    const day = { timeZone: 'Europe/Warsaw' };
    expect(storedZoneNote({ timeZone: 'Europe/Warsaw' }, day, 'check-in')).toBeNull();
    expect(storedZoneNote({ timeZone: 'Asia/Tokyo' }, day, 'check-in')).toBe(
      'This check-in was saved in Asia/Tokyo. It belongs to this calendar date in any time zone; activities and GPS runs below are counted by when they started in Europe/Warsaw.',
    );
    expect(storedZoneNote({ timeZone: 'Pacific/Kiritimati' }, day, 'movement')).toMatch(/^This movement day was saved in Pacific\/Kiritimati\./u);
  });

  it('notes a 23- or 25-hour date only', () => {
    expect(dayLengthNote({ endsAt: '2026-11-05T23:00:00.000Z', startsAt: '2026-11-04T23:00:00.000Z', timeZone: 'Europe/Warsaw' })).toBeNull();
    expect(dayLengthNote({ endsAt: '2026-03-29T22:00:00.000Z', startsAt: '2026-03-28T23:00:00.000Z', timeZone: 'Europe/Warsaw' })).toBe(
      'This date has 23 hours in Europe/Warsaw because the clocks change.',
    );
    expect(dayLengthNote({ endsAt: '2026-10-25T23:00:00.000Z', startsAt: '2026-10-24T22:00:00.000Z', timeZone: 'Europe/Warsaw' })).toBe(
      'This date has 25 hours in Europe/Warsaw because the clocks change.',
    );
  });

  it('states the computation time in UTC and that nothing is stored', () => {
    expect(computedLine(overviewFixture())).toBe('Computed 2026-11-08 10:00 UTC from your current data; not stored.');
  });
});

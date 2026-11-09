import type { DailyOverview, DailyOverviewCheckIn, DailyOverviewDay, DailyOverviewGpsRuns, DailyOverviewMovement } from '@running-tracker/contracts';

import { activityTypeLabels } from './activity-form.js';
import { formatSleep } from './daily-checkin.js';
import { formatActiveEnergy, formatSteps } from './daily-movement.js';
import { formatDistance } from './run-search.js';

// Presentation of the daily overview (Today, ADR-0082). Pure functions: every sentence and label the screen shows comes
// from here, so each state can be tested without a DOM. Missing is "Not recorded" (unknown), never 0; a recorded 0 is
// shown as 0. No target, judgement, trend or recommendation is ever written.

/** What a Today action asks the application to open. The date travels with the two editor intents only. */
export type TodayAction =
  | { kind: 'check-in'; localDate: string }
  | { kind: 'meals'; localDate: string }
  | { kind: 'movement'; localDate: string }
  | { kind: 'activities' }
  | { kind: 'runner' };

export interface LabelledValue {
  label: string;
  value: string;
}

const NOT_RECORDED = 'Not recorded';

/** The check-in's values in the editor's order, each recorded or "Not recorded". Empty for a day without a check-in. */
export function checkInRows(checkIn: DailyOverviewCheckIn): LabelledValue[] {
  if (!checkIn.recorded) return [];
  const value = <T>(recorded: T | null, format: (value: T) => string) => (recorded === null ? NOT_RECORDED : format(recorded));
  return [
    { label: 'Sleep', value: value(checkIn.sleepMinutes, formatSleep) },
    { label: 'Sleep quality', value: value(checkIn.sleepQuality, (rating) => `${rating} of 5`) },
    { label: 'Mood', value: value(checkIn.mood, (rating) => `${rating} of 5`) },
    { label: 'Soreness', value: value(checkIn.soreness, (rating) => `${rating} of 10`) },
    // A stored weight has at most two decimals, so the shortest spelling is exact.
    { label: 'Weight', value: value(checkIn.weightKg, (kg) => `${String(kg)} kg`) },
  ];
}

/** True for a check-in that holds only a note: a record, but no value the overview can show. */
export function isNoteOnlyCheckIn(checkIn: DailyOverviewCheckIn): boolean {
  return checkIn.recorded && checkIn.hasNote && checkInRows(checkIn).every((row) => row.value === NOT_RECORDED);
}

/** Steps and active energy as entered. Empty for a day without a movement record. */
export function movementRows(movement: DailyOverviewMovement): LabelledValue[] {
  if (!movement.recorded) return [];
  return [
    { label: 'Steps', value: movement.steps === null ? NOT_RECORDED : formatSteps(movement.steps) },
    { label: 'Active energy', value: movement.activeEnergyKcal === null ? NOT_RECORDED : formatActiveEnergy(movement.activeEnergyKcal) },
  ];
}

/** "1 h 05 min", "45 min" or "30 s": a duration the person entered. */
export function formatEnteredDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min`;
  if (minutes > 0) return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  return `${rest} s`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function manualActivitiesSummary(overview: Pick<DailyOverview, 'manualActivities'>): string {
  const { count, enteredDurationS } = overview.manualActivities;
  if (count === 0) return 'No manual activity started on this day.';
  return `${plural(count, 'activity', 'activities')} started on this day, ${formatEnteredDuration(enteredDurationS)} entered in total.`;
}

export function manualActivityRows(overview: Pick<DailyOverview, 'manualActivities'>): LabelledValue[] {
  return overview.manualActivities.byType.map((entry) => ({
    label: activityTypeLabels[entry.type],
    value: `${entry.count} · ${formatEnteredDuration(entry.enteredDurationS)} entered`,
  }));
}

export function gpsRunsSummary(gpsRuns: DailyOverviewGpsRuns): string {
  if (gpsRuns.count === 0) return 'No finished GPS run started on this day.';
  return `${plural(gpsRuns.count, 'finished GPS run', 'finished GPS runs')} started on this day.`;
}

/**
 * The distance, with the runs it covers. A partial total says how many runs it covers and that the others are not
 * known yet; with no current summary at all no distance is given, never 0 km.
 */
export function gpsDistanceText(gpsRuns: DailyOverviewGpsRuns): string | null {
  if (gpsRuns.count === 0) return null;
  if (gpsRuns.currentDistanceM === null) {
    return gpsRuns.count === 1 ? 'No distance is available yet for this run.' : 'No distance is available yet for these runs.';
  }
  const distance = formatDistance(gpsRuns.currentDistanceM, 'km');
  if (gpsRuns.withoutCurrentDistance === 0) return gpsRuns.count === 1 ? `Distance: ${distance}.` : `Distance: ${distance} in total.`;
  return `Distance: ${distance} from ${gpsRuns.withCurrentDistance} of ${gpsRuns.count} runs; ${plural(gpsRuns.withoutCurrentDistance, 'run has', 'runs have')} no distance yet, so the total is partial.`;
}

/** Explains a stored zone that differs from the view zone. A record never moves to another date because of it. */
export function storedZoneNote(record: { timeZone: string }, day: Pick<DailyOverviewDay, 'timeZone'>, what: 'check-in' | 'movement'): string | null {
  if (record.timeZone === day.timeZone) return null;
  const noun = what === 'check-in' ? 'This check-in' : 'This movement day';
  return `${noun} was saved in ${record.timeZone}. It belongs to this calendar date in any time zone; activities and GPS runs below are counted by when they started in ${day.timeZone}.`;
}

/** Hours of the date in the view zone, when not 24 (a daylight saving change). */
export function dayLengthNote(day: Pick<DailyOverviewDay, 'endsAt' | 'startsAt' | 'timeZone'>): string | null {
  const hours = (Date.parse(day.endsAt) - Date.parse(day.startsAt)) / 3_600_000;
  if (hours === 24) return null;
  return `This date has ${String(hours)} hours in ${day.timeZone} because the clocks change.`;
}

/** "Computed 2026-11-08 10:00 UTC": the server's computation time, in UTC so it is the same on every device. */
export function computedLine(overview: Pick<DailyOverview, 'provenance'>): string {
  return `Computed ${overview.provenance.computedAt.slice(0, 16).replace('T', ' ')} UTC from your current data; not stored.`;
}

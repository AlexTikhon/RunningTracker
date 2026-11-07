import { ACTIVITY_TYPES, WEEKDAY_NAMES, addLocalDays, type ActivityType } from '@running-tracker/contracts';

import { localDateOf, startOfLocalDate } from '../runs/run-search-period.js';

// Deterministic weekly aggregation (ADR-0076). Every number a weekly insight may mention is computed here, by code,
// from the person's own records; the language model only writes text about this object and is checked against it.
// Pure: no clock, no database, no randomness. The same records always give the same object, key for key, which is
// what the input hash of a stored insight is computed from.
//
// Not used, by design: free-text notes (check-in notes, activity notes) and activity effort (RPE). They never reach
// this function, so they can never reach the model.

export const WEEKDAYS = WEEKDAY_NAMES;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * The aggregation, fact, grounding and safety policy (ADR-0076). Stored with every insight; a row of another policy is
 * never presented as current. Change it whenever any of those rules changes meaning, so older answers are not trusted
 * implicitly. Policy 1 was the Stop 1 checker (numbers anywhere in the aggregate, metric keys, safety lexicon only).
 */
export const WEEKLY_INSIGHT_POLICY_VERSION = 'weekly-insight-policy-2';

/** Soreness at or above this value on any day makes the week "extreme": the suggestion may then only advise rest. */
export const EXTREME_SORENESS_MIN = 8;
/** A night shorter than this (4 h) makes the week "extreme". */
export const EXTREME_SHORT_SLEEP_MAX_MINUTES = 240;
/** A night longer than this (12 h) makes the week "extreme". */
export const EXTREME_LONG_SLEEP_MIN_MINUTES = 720;
/** A first-to-last weight change of at least this many kilograms within the week is flagged. */
export const LARGE_WEIGHT_CHANGE_KG = 2;
/** One to this many check-in days is a sparse week. */
export const SPARSE_CHECK_IN_MAX_DAYS = 3;

export const EXTREME_FLAGS = ['extreme_soreness', 'extreme_short_sleep', 'extreme_long_sleep'] as const;

export type WeeklyFlag =
  | (typeof EXTREME_FLAGS)[number]
  | 'gps_distance_pending'
  | 'large_weight_change'
  | 'manual_and_gps_runs_may_overlap'
  | 'multiple_time_zones'
  | 'no_activities'
  | 'no_check_ins'
  | 'sparse_check_ins'
  | 'week_in_progress';

export interface CheckInRecord {
  localDate: string;
  mood: number | null;
  sleepMinutes: number | null;
  sleepQuality: number | null;
  soreness: number | null;
  timeZone: string;
  weightKg: number | null;
}

export interface ManualActivityRecord {
  distanceM: number | null;
  durationS: number;
  startedAtMs: number;
  type: ActivityType;
}

export interface GpsRunRecord {
  /**
   * From the run's published summary, only when that summary is current (its source_revision equals the run's
   * data_revision). Null when no summary is published yet or a late upload made it stale: a data gap, never a distance.
   */
  distanceM: number | null;
  finishedAtMs: number;
  startedAtMs: number;
}

export interface WeekWindow {
  /** Local date of the Sunday the week ends on. */
  end: string;
  /** Instant at which the Monday begins in `timeZone`. */
  rangeEndMs: number;
  /** Instant at which the Monday after the week begins in `timeZone` (exclusive end). */
  rangeStartMs: number;
  /** Local date of the Monday the week starts on. */
  start: string;
  timeZone: string;
  timeZoneSource: 'check_ins' | 'request';
  /** Distinct zones on the week's check-ins, sorted. */
  zonesOnCheckIns: readonly string[];
}

export interface DayValue {
  day: Weekday;
  value: number | null;
}

export interface ActivityTypeTotals {
  count: number;
  /** Sum over the activities of this type that have a distance; null when none has one. */
  distanceKm: number | null;
  durationMinutes: number;
}

/** The whole model input. Every key path of it is a valid `metricKey`. */
export interface WeeklyAggregate {
  checkIns: {
    coveragePercent: number;
    daysInWeek: 7;
    daysMissing: number;
    daysWithData: number;
  };
  flags: WeeklyFlag[];
  gpsRuns: {
    count: number;
    /** Sum over the runs with a current summary; null when there is none. Never added to manual runs. */
    distanceKm: number | null;
    /** Runs whose distance is in `distanceKm`. */
    runsWithCurrentDistance: number;
    /** Runs without a current summary (none published yet, or stale after a late upload). */
    runsWithoutCurrentDistance: number;
    totalDurationMinutes: number;
  };
  manualActivities: {
    byType: Partial<Record<ActivityType, ActivityTypeTotals>>;
    count: number;
    totalDurationMinutes: number;
  };
  mood: { average: number | null; byDay: DayValue[]; daysReported: number };
  sleep: {
    avgHours: number | null;
    avgMinutes: number | null;
    avgQuality: number | null;
    daysReported: number;
    /** The earliest day with the longest night. */
    maxDay: Weekday | null;
    maxMinutes: number | null;
    /** The earliest day with the shortest night. */
    minDay: Weekday | null;
    minMinutes: number | null;
    qualityDaysReported: number;
  };
  soreness: {
    average: number | null;
    byDay: DayValue[];
    daysReported: number;
    max: number | null;
    /** The earliest day with the highest soreness. */
    maxDay: Weekday | null;
  };
  week: { end: string; inProgress: boolean; start: string; timeZone: string; timeZoneSource: 'check_ins' | 'request' };
  weight: {
    daysReported: number;
    deltaKg: number | null;
    firstDay: Weekday | null;
    firstKg: number | null;
    lastDay: Weekday | null;
    lastKg: number | null;
  };
}

const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Rounds half away from zero to `decimals` places, without producing -0. */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = (Math.sign(value) * Math.round(Math.abs(value) * factor + Number.EPSILON)) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function average(values: readonly number[], decimals: number): number | null {
  if (values.length === 0) return null;
  return roundTo(values.reduce((sum, value) => sum + value, 0) / values.length, decimals);
}

/**
 * Which zone the week is read in. The zone stored on the person's check-ins of that week wins (the most frequent one;
 * a tie goes to the zone of the earliest of the tied days); without a check-in, the zone the request names. Week
 * membership of a check-in is its stored calendar date, so finding the check-ins needs no zone.
 */
export function resolveWeekWindow(input: {
  checkIns: readonly Pick<CheckInRecord, 'localDate' | 'timeZone'>[];
  requestTimeZone: string;
  weekStart: string;
}): WeekWindow {
  const end = addLocalDays(input.weekStart, 6);
  const inWeek = input.checkIns
    .filter((row) => row.localDate >= input.weekStart && row.localDate <= end)
    .toSorted((left, right) => byCodeUnit(left.localDate, right.localDate));
  const counts = new Map<string, { count: number; firstDate: string }>();
  for (const row of inWeek) {
    const entry = counts.get(row.timeZone);
    if (entry) entry.count += 1;
    else counts.set(row.timeZone, { count: 1, firstDate: row.localDate });
  }
  let chosen: string | undefined;
  let best: { count: number; firstDate: string } | undefined;
  for (const [zone, entry] of counts) {
    if (!best || entry.count > best.count || (entry.count === best.count && entry.firstDate < best.firstDate)) {
      chosen = zone;
      best = entry;
    }
  }
  const timeZone = chosen ?? input.requestTimeZone;
  return {
    end,
    rangeEndMs: startOfLocalDate(addLocalDays(input.weekStart, 7), timeZone),
    rangeStartMs: startOfLocalDate(input.weekStart, timeZone),
    start: input.weekStart,
    timeZone,
    timeZoneSource: chosen === undefined ? 'request' : 'check_ins',
    zonesOnCheckIns: [...counts.keys()].sort(),
  };
}

function weekdayOf(window: WeekWindow, localDate: string): Weekday {
  for (let index = 0; index < 7; index += 1) {
    if (addLocalDays(window.start, index) === localDate) return WEEKDAYS[index]!;
  }
  throw new RangeError(`${localDate} is not in the week starting ${window.start}`);
}

function byDay(window: WeekWindow, days: readonly CheckInRecord[], pick: (day: CheckInRecord) => number | null): DayValue[] {
  return WEEKDAYS.map((day, index) => {
    const date = addLocalDays(window.start, index);
    const row = days.find((candidate) => candidate.localDate === date);
    return { day, value: row ? pick(row) : null };
  });
}

const hasNumericValue = (row: CheckInRecord) =>
  [row.weightKg, row.sleepMinutes, row.sleepQuality, row.mood, row.soreness].some((value) => value !== null);

/**
 * The weekly summary. Records outside the window are ignored (check-ins by calendar date, activities and runs by
 * start instant in `[rangeStartMs, rangeEndMs)`), so the caller may pass a superset. `todayLocalDate` (in the week's
 * zone) only decides the `week_in_progress` flag.
 */
export function aggregateWeek(input: {
  activities: readonly ManualActivityRecord[];
  checkIns: readonly CheckInRecord[];
  gpsRuns: readonly GpsRunRecord[];
  todayLocalDate: string;
  window: WeekWindow;
}): WeeklyAggregate {
  const { window } = input;
  const inRange = (instantMs: number) => instantMs >= window.rangeStartMs && instantMs < window.rangeEndMs;
  const days = input.checkIns
    .filter((row) => row.localDate >= window.start && row.localDate <= window.end)
    .toSorted((left, right) => byCodeUnit(left.localDate, right.localDate));
  const activities = input.activities.filter((activity) => inRange(activity.startedAtMs));
  const gpsRuns = input.gpsRuns.filter((run) => inRange(run.startedAtMs));

  // Check-in coverage counts days with at least one numeric value: a note-only day carries nothing the model sees.
  const daysWithData = days.filter(hasNumericValue).length;

  const sleepMinutes = days.flatMap((row) => (row.sleepMinutes === null ? [] : [row.sleepMinutes]));
  const sleepQuality = days.flatMap((row) => (row.sleepQuality === null ? [] : [row.sleepQuality]));
  const moods = days.flatMap((row) => (row.mood === null ? [] : [row.mood]));
  const soreness = days.flatMap((row) => (row.soreness === null ? [] : [row.soreness]));
  const weights = days.filter((row) => row.weightKg !== null);
  const avgSleepMinutes = average(sleepMinutes, 0);
  const minSleep = sleepMinutes.length === 0 ? null : Math.min(...sleepMinutes);
  const maxSleep = sleepMinutes.length === 0 ? null : Math.max(...sleepMinutes);
  const maxSoreness = soreness.length === 0 ? null : Math.max(...soreness);
  // The earliest day (days are sorted) whose value equals `target`.
  const dayOf = (pick: (row: CheckInRecord) => number | null, target: number | null): Weekday | null => {
    if (target === null) return null;
    const row = days.find((candidate) => pick(candidate) === target);
    return row ? weekdayOf(window, row.localDate) : null;
  };

  const firstWeight = weights[0];
  const lastWeight = weights.at(-1);
  const deltaKg =
    firstWeight && lastWeight && weights.length >= 2 ? roundTo(lastWeight.weightKg! - firstWeight.weightKg!, 2) : null;

  const byType: Partial<Record<ActivityType, ActivityTypeTotals>> = {};
  for (const type of ACTIVITY_TYPES) {
    const ofType = activities.filter((activity) => activity.type === type);
    if (ofType.length === 0) continue;
    const distances = ofType.flatMap((activity) => (activity.distanceM === null ? [] : [activity.distanceM]));
    byType[type] = {
      count: ofType.length,
      distanceKm: distances.length === 0 ? null : roundTo(distances.reduce((sum, value) => sum + value, 0) / 1000, 2),
      durationMinutes: Math.round(ofType.reduce((sum, activity) => sum + activity.durationS, 0) / 60),
    };
  }

  const gpsDistances = gpsRuns.flatMap((run) => (run.distanceM === null ? [] : [run.distanceM]));

  const flags = new Set<WeeklyFlag>();
  if (daysWithData === 0) flags.add('no_check_ins');
  else if (daysWithData <= SPARSE_CHECK_IN_MAX_DAYS) flags.add('sparse_check_ins');
  if (activities.length === 0 && gpsRuns.length === 0) flags.add('no_activities');
  if ((byType.run?.count ?? 0) > 0 && gpsRuns.length > 0) flags.add('manual_and_gps_runs_may_overlap');
  if (gpsRuns.length > gpsDistances.length) flags.add('gps_distance_pending');
  if (soreness.some((value) => value >= EXTREME_SORENESS_MIN)) flags.add('extreme_soreness');
  if (sleepMinutes.some((value) => value < EXTREME_SHORT_SLEEP_MAX_MINUTES)) flags.add('extreme_short_sleep');
  if (sleepMinutes.some((value) => value > EXTREME_LONG_SLEEP_MIN_MINUTES)) flags.add('extreme_long_sleep');
  if (deltaKg !== null && Math.abs(deltaKg) >= LARGE_WEIGHT_CHANGE_KG) flags.add('large_weight_change');
  if (window.zonesOnCheckIns.length > 1) flags.add('multiple_time_zones');
  if (input.todayLocalDate >= window.start && input.todayLocalDate <= window.end) flags.add('week_in_progress');

  return {
    checkIns: {
      coveragePercent: Math.round((daysWithData / 7) * 100),
      daysInWeek: 7,
      daysMissing: 7 - daysWithData,
      daysWithData,
    },
    flags: [...flags].sort(),
    gpsRuns: {
      count: gpsRuns.length,
      distanceKm: gpsDistances.length === 0 ? null : roundTo(gpsDistances.reduce((sum, value) => sum + value, 0) / 1000, 2),
      runsWithCurrentDistance: gpsDistances.length,
      runsWithoutCurrentDistance: gpsRuns.length - gpsDistances.length,
      totalDurationMinutes: Math.round(gpsRuns.reduce((sum, run) => sum + (run.finishedAtMs - run.startedAtMs), 0) / 60_000),
    },
    manualActivities: {
      byType,
      count: activities.length,
      totalDurationMinutes: Math.round(activities.reduce((sum, activity) => sum + activity.durationS, 0) / 60),
    },
    mood: { average: average(moods, 1), byDay: byDay(window, days, (row) => row.mood), daysReported: moods.length },
    sleep: {
      avgHours: avgSleepMinutes === null ? null : roundTo(avgSleepMinutes / 60, 1),
      avgMinutes: avgSleepMinutes,
      avgQuality: average(sleepQuality, 1),
      daysReported: sleepMinutes.length,
      maxDay: dayOf((row) => row.sleepMinutes, maxSleep),
      maxMinutes: maxSleep,
      minDay: dayOf((row) => row.sleepMinutes, minSleep),
      minMinutes: minSleep,
      qualityDaysReported: sleepQuality.length,
    },
    soreness: {
      average: average(soreness, 1),
      byDay: byDay(window, days, (row) => row.soreness),
      daysReported: soreness.length,
      max: maxSoreness,
      maxDay: dayOf((row) => row.soreness, maxSoreness),
    },
    week: {
      end: window.end,
      inProgress: flags.has('week_in_progress'),
      start: window.start,
      timeZone: window.timeZone,
      timeZoneSource: window.timeZoneSource,
    },
    weight: {
      daysReported: weights.length,
      deltaKg,
      firstDay: firstWeight ? weekdayOf(window, firstWeight.localDate) : null,
      firstKg: firstWeight ? firstWeight.weightKg : null,
      lastDay: lastWeight ? weekdayOf(window, lastWeight.localDate) : null,
      lastKg: lastWeight ? lastWeight.weightKg : null,
    },
  };
}

/** Today's calendar date in the week's zone, for the `week_in_progress` flag. */
export function todayIn(timeZone: string, nowMs: number): string {
  return localDateOf(nowMs, timeZone);
}

/** True when the week has a soreness or sleep value for which code, not the model, selects the suggestion. */
export function hasExtremeValues(aggregate: Pick<WeeklyAggregate, 'flags'>): boolean {
  return aggregate.flags.some((flag) => (EXTREME_FLAGS as readonly string[]).includes(flag));
}

/**
 * JSON with object keys sorted by UTF-16 code unit at every level (never by locale): the one serialisation the prompt
 * and the input hash use.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (child === null || typeof child !== 'object' || Array.isArray(child)) return child;
    return Object.fromEntries(Object.entries(child).sort(([left], [right]) => byCodeUnit(left, right)));
  });
}

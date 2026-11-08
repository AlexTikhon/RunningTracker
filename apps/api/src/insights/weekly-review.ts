import {
  ACTIVITY_TYPES,
  WEEKLY_REVIEW_STATEMENT_MAX_LENGTH,
  WEEKLY_REVIEW_VERSION,
  addLocalDays,
  weeklyReviewSchema,
  type ActivityType,
  type DailyMovementSource,
  type WeeklyReview,
  type WeeklyReviewCoverage,
  type WeeklyReviewMovement,
  type WeeklyReviewMovementDay,
  type WeeklyReviewStatement,
  type WeeklyReviewStatementCode,
} from '@running-tracker/contracts';

import { buildFacts, dataGapsOf } from './insight-facts.js';
import {
  WEEKLY_INSIGHT_POLICY_VERSION,
  type CheckInRecord,
  type ManualActivityRecord,
  type WeekWindow,
  type WeeklyAggregate,
} from './weekly-aggregate.js';

// The deterministic weekly review: descriptive sentences written by code from the week's aggregate (the same object an
// AI insight is generated from), a few counts the aggregate does not carry, and the week's manual daily movement, which
// is review-only (ADR-0079). Pure: no clock, no database.
//
// Rules every statement follows:
// - Denominators are explicit: days in the week (7), days with numeric check-in values, days with the metric. A
//   note-only check-in is a record but not a day with values. A sleep-quality rating is never a recorded sleep duration.
// - A value that was not recorded is described as not recorded, never as zero. No weight change from one measurement.
//   No GPS distance from a missing or stale summary; a partial GPS distance names the runs it covers.
// - Manual runs and GPS runs are described separately and never added together.
// - Description only: no judgement ("good", "low"), no cause, no advice, no comparison with an undefined "usual".

/** Counts the review needs that the aggregate does not carry. They do not change the aggregate or its input hash. */
export interface ReviewDetail {
  /** Days in the week with any check-in record, a note-only one included. */
  checkInRecordDays: number;
  /** Manual activities with an entered distance, per type. */
  manualWithDistance: Partial<Record<ActivityType, number>>;
  /** Days with a sleep-quality rating and no sleep duration. */
  sleepQualityWithoutDurationDays: number;
  /** Distinct zones stored on the week's check-ins, sorted. */
  zonesOnCheckIns: readonly string[];
}

/** The detail counts from the same records (and the same week filter) the aggregate was computed from. */
export function reviewDetailOf(input: {
  activities: readonly ManualActivityRecord[];
  checkIns: readonly CheckInRecord[];
  window: WeekWindow;
}): ReviewDetail {
  const { window } = input;
  const days = input.checkIns.filter((row) => row.localDate >= window.start && row.localDate <= window.end);
  const activities = input.activities.filter(
    (activity) => activity.startedAtMs >= window.rangeStartMs && activity.startedAtMs < window.rangeEndMs,
  );
  const manualWithDistance: Partial<Record<ActivityType, number>> = {};
  for (const activity of activities) {
    if (activity.distanceM === null) continue;
    manualWithDistance[activity.type] = (manualWithDistance[activity.type] ?? 0) + 1;
  }
  return {
    checkInRecordDays: new Set(days.map((row) => row.localDate)).size,
    manualWithDistance,
    sleepQualityWithoutDurationDays: days.filter((row) => row.sleepQuality !== null && row.sleepMinutes === null).length,
    zonesOnCheckIns: window.zonesOnCheckIns,
  };
}

const count = (value: number, singular: string, plural: string) => `${value} ${value === 1 ? singular : plural}`;

/** "45 min", "7 h", "7 h 30 min". */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * Where a metric was recorded, against the days with check-in values (`withValues` > 0):
 * "on all 4 days with check-in values", "on 3 of 4 days with check-in values", "on the only day with check-in values".
 */
function onDays(recorded: number, withValues: number): string {
  if (recorded === withValues) return withValues === 1 ? 'on the only day with check-in values' : `on all ${withValues} days with check-in values`;
  return `on ${recorded} of ${withValues} days with check-in values`;
}

/** "on any of the 4 days with check-in values", "on the only day with check-in values". */
function onNoDay(withValues: number): string {
  return withValues === 1 ? 'on the only day with check-in values' : `on any of the ${withValues} days with check-in values`;
}

const activityNames: Record<ActivityType, { plural: string; singular: string }> = {
  hike: { plural: 'hikes', singular: 'hike' },
  other: { plural: 'other activities', singular: 'other activity' },
  ride: { plural: 'rides', singular: 'ride' },
  run: { plural: 'manual runs', singular: 'manual run' },
  strength: { plural: 'strength sessions', singular: 'strength session' },
  swim: { plural: 'swims', singular: 'swim' },
  walk: { plural: 'walks', singular: 'walk' },
};

/** The week's statements, in a stable order: week, check-ins, sleep, mood, soreness, weight, manual, GPS, sources. */
export function describeWeek(aggregate: WeeklyAggregate, detail: ReviewDetail): WeeklyReviewStatement[] {
  const statements: WeeklyReviewStatement[] = [];
  const say = (code: WeeklyReviewStatementCode, text: string) => statements.push({ code, text });
  const { checkIns, gpsRuns, manualActivities, mood, sleep, soreness, week, weight } = aggregate;
  const withValues = checkIns.daysWithData;
  const noteOnly = detail.checkInRecordDays - withValues;

  // The week.
  if (week.inProgress) say('week.in_progress', 'This week is not over yet, so these counts can still change.');
  if (week.timeZoneSource === 'request') {
    say('week.time_zone_from_request', `No check-in this week has a time zone, so the week is read in ${week.timeZone}, the zone this device sent.`);
  }
  if (detail.zonesOnCheckIns.length > 1) {
    say(
      'week.multiple_time_zones',
      `Check-ins this week were saved in ${detail.zonesOnCheckIns.length} time zones (${detail.zonesOnCheckIns.join(', ')}); the week is read in ${week.timeZone}.`,
    );
  }

  // Check-ins. Days with values are the denominator of every metric below.
  if (withValues === 0) {
    say('check_ins.none', detail.checkInRecordDays === 0 ? 'No check-ins were recorded this week.' : 'No check-ins with values were recorded this week.');
  } else {
    say(
      'check_ins.coverage',
      withValues === checkIns.daysInWeek
        ? `Check-ins with values on all ${checkIns.daysInWeek} days of the week.`
        : `Check-ins with values on ${withValues} of ${checkIns.daysInWeek} days of the week.`,
    );
  }
  if (noteOnly > 0) {
    say(
      'check_ins.note_only_days',
      noteOnly === 1
        ? '1 day has a check-in with only a note; it is not counted as a day with values.'
        : `${noteOnly} days have check-ins with only a note; they are not counted as days with values.`,
    );
  }

  if (withValues > 0) {
    // Sleep duration and sleep quality are separate values and are described separately.
    if (sleep.daysReported === 0) {
      say('sleep_duration.not_recorded', `Sleep duration was not recorded ${onNoDay(withValues)}.`);
    } else {
      say('sleep_duration.coverage', `Sleep duration was recorded ${onDays(sleep.daysReported, withValues)}.`);
      if (sleep.daysReported === 1 && sleep.minMinutes !== null) {
        say('sleep_duration.values', `Recorded sleep duration: ${formatDuration(sleep.minMinutes)} (${sleep.minDay}).`);
      } else if (sleep.avgMinutes !== null && sleep.minMinutes !== null && sleep.maxMinutes !== null) {
        say(
          'sleep_duration.values',
          `Average recorded sleep duration: ${formatDuration(sleep.avgMinutes)} over ${sleep.daysReported} days; shortest ${formatDuration(sleep.minMinutes)} (${sleep.minDay}), longest ${formatDuration(sleep.maxMinutes)} (${sleep.maxDay}).`,
        );
      }
    }
    if (sleep.qualityDaysReported === 0) {
      say('sleep_quality.not_rated', `Sleep quality was not rated ${onNoDay(withValues)}.`);
    } else if (sleep.avgQuality !== null) {
      say(
        'sleep_quality.coverage',
        sleep.qualityDaysReported === 1
          ? `Sleep quality was rated ${onDays(1, withValues)}: ${sleep.avgQuality} of 5.`
          : `Sleep quality was rated ${onDays(sleep.qualityDaysReported, withValues)}; average ${sleep.avgQuality} of 5.`,
      );
    }
    const qualityOnly = detail.sleepQualityWithoutDurationDays;
    if (qualityOnly > 0) {
      say(
        'sleep_quality.without_duration',
        qualityOnly === 1
          ? 'On 1 day sleep quality was rated without a sleep duration; that day does not count as a day with recorded sleep duration.'
          : `On ${qualityOnly} days sleep quality was rated without a sleep duration; those days do not count as days with recorded sleep duration.`,
      );
    }

    if (mood.daysReported === 0 || mood.average === null) {
      say('mood.not_rated', `Mood was not rated ${onNoDay(withValues)}.`);
    } else {
      say(
        'mood.coverage',
        mood.daysReported === 1
          ? `Mood was rated ${onDays(1, withValues)}: ${mood.average} of 5.`
          : `Mood was rated ${onDays(mood.daysReported, withValues)}; average ${mood.average} of 5.`,
      );
    }

    if (soreness.daysReported === 0 || soreness.average === null || soreness.max === null) {
      say('soreness.not_rated', `Soreness was not rated ${onNoDay(withValues)}.`);
    } else {
      say(
        'soreness.coverage',
        soreness.daysReported === 1
          ? `Soreness was rated ${onDays(1, withValues)}: ${soreness.max} of 10 (${soreness.maxDay}).`
          : `Soreness was rated ${onDays(soreness.daysReported, withValues)}; average ${soreness.average} of 10, highest ${soreness.max} of 10 (${soreness.maxDay}).`,
      );
    }

    if (weight.daysReported === 0 || weight.firstKg === null) {
      say('weight.not_recorded', `Weight was not recorded ${onNoDay(withValues)}.`);
    } else if (weight.daysReported === 1 || weight.deltaKg === null || weight.lastKg === null) {
      say(
        'weight.single_measurement',
        `Weight was recorded ${onDays(1, withValues)}: ${weight.firstKg} kg (${weight.firstDay}). A change needs at least two measurements.`,
      );
    } else {
      const delta = weight.deltaKg;
      const change =
        delta > 0
          ? `up ${delta} kg from the first to the last measurement`
          : delta < 0
            ? `down ${Math.abs(delta)} kg from the first to the last measurement`
            : 'the same at the first and the last measurement';
      say(
        'weight.change',
        `Weight was recorded ${onDays(weight.daysReported, withValues)}: ${weight.firstKg} kg (${weight.firstDay}) first and ${weight.lastKg} kg (${weight.lastDay}) last, ${change}.`,
      );
    }
  }

  // Manual activities: in total, then per type (with the distance only for those it was entered for).
  if (manualActivities.count === 0) {
    say('manual.none', 'No manual activities were recorded.');
  } else {
    say(
      'manual.total',
      `${count(manualActivities.count, 'manual activity', 'manual activities')}, ${formatDuration(manualActivities.totalDurationMinutes)} in total.`,
    );
    for (const type of ACTIVITY_TYPES) {
      const totals = manualActivities.byType[type];
      if (!totals) continue;
      const name = activityNames[type];
      const withDistance = detail.manualWithDistance[type] ?? 0;
      const distance =
        totals.distanceKm === null || withDistance === 0
          ? ''
          : withDistance === totals.count
            ? `, ${totals.distanceKm} km entered`
            : `, ${totals.distanceKm} km entered for ${withDistance} of ${totals.count}`;
      say(`manual.${type}`, `${totals.count} ${totals.count === 1 ? name.singular : name.plural}: ${formatDuration(totals.durationMinutes)}${distance}.`);
    }
  }

  // GPS runs: a distance only from current summaries, naming the runs it covers.
  if (gpsRuns.count === 0) {
    say('gps.none', 'No GPS runs were recorded.');
  } else {
    const runs = count(gpsRuns.count, 'GPS run', 'GPS runs');
    const time = formatDuration(gpsRuns.totalDurationMinutes);
    if (gpsRuns.runsWithoutCurrentDistance === 0 && gpsRuns.distanceKm !== null) {
      say('gps.totals', `${runs}: ${time}, ${gpsRuns.distanceKm} km.`);
    } else if (gpsRuns.distanceKm !== null) {
      say(
        'gps.partial_distance',
        `${runs}: ${time} in total. The distance of ${gpsRuns.distanceKm} km covers ${gpsRuns.runsWithCurrentDistance} of the ${gpsRuns.count} runs; ${count(gpsRuns.runsWithoutCurrentDistance, 'run has', 'runs have')} no current distance yet.`,
      );
    } else {
      say(
        'gps.no_distance',
        `${runs}: ${time} in total. No current distance is available yet for ${gpsRuns.count === 1 ? 'this run' : 'these runs'}.`,
      );
    }
  }

  if (aggregate.flags.includes('manual_and_gps_runs_may_overlap')) {
    say(
      'sources.manual_and_gps_runs_separate',
      'Manual runs and GPS runs may describe the same runs, so their totals are shown separately and not added together.',
    );
  }
  return statements;
}

// --- Manual daily movement (ADR-0079) --------------------------------------------------------------------------------
//
// Review-only: movement is not part of the aggregate, the facts, the coverage or the data gaps that AI insights share,
// so it cannot change an insight's input hash. Days are the stored local dates of the week (a daily total is never
// re-read as an instant in some zone), only manual rows count, and each metric is described against the 7 calendar
// days on its own. Totals add recorded values only; energy is added as integer tenths of a kcal.

/** One stored manual movement day, as the review query reads it. */
export interface MovementDayRecord {
  /** Integer tenths of a kcal (412.5 kcal is 4125), or null when not recorded. */
  activeEnergyTenths: number | null;
  localDate: string;
  source: DailyMovementSource;
  steps: number | null;
  timeZone: string;
}

/**
 * Exact integer tenths of a kcal from PostgreSQL's text form of a stored value ("412.5", "0.0", "250", "412.50").
 * The database refuses a meaningful second decimal (migration 0035); anything else here is a defect and throws rather
 * than being rounded.
 */
export function kcalTenthsOf(text: string): number {
  const matched = /^(\d{1,5})(?:\.(\d)0*)?$/u.exec(text);
  if (!matched) throw new Error('PostgreSQL returned active energy with more than one meaningful decimal');
  return Number(matched[1]) * 10 + Number(matched[2] ?? '0');
}

/** "662.5", "250", "0": the shortest exact spelling of integer tenths, written from integers. */
export function formatKcalTenths(tenths: number): string {
  const whole = Math.trunc(tenths / 10);
  const tenth = tenths % 10;
  return `${groupThousands(whole)}${tenth === 0 ? '' : `.${tenth}`}`;
}

/** "8,042": digit groups without a locale, so the text is the same on every server. */
export function groupThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

/** The week's movement payload: seven days from Monday, recorded days as stored, totals in exact integers. */
export function movementOf(records: readonly MovementDayRecord[], weekStart: string): WeeklyReviewMovement {
  const weekEnd = addLocalDays(weekStart, 6);
  const byDate = new Map(
    records
      .filter((record) => record.source === 'manual' && record.localDate >= weekStart && record.localDate <= weekEnd)
      .map((record) => [record.localDate, record]),
  );
  const days: WeeklyReviewMovementDay[] = [];
  let stepsDays = 0;
  let stepsTotal = 0;
  let energyDays = 0;
  let energyTenths = 0;
  for (let index = 0; index < 7; index += 1) {
    const localDate = addLocalDays(weekStart, index);
    const record = byDate.get(localDate);
    if (!record) {
      days.push({ localDate, recorded: false });
      continue;
    }
    if (record.steps !== null) {
      stepsDays += 1;
      stepsTotal += record.steps;
    }
    if (record.activeEnergyTenths !== null) {
      energyDays += 1;
      energyTenths += record.activeEnergyTenths;
    }
    days.push({
      activeEnergyKcal: record.activeEnergyTenths === null ? null : record.activeEnergyTenths / 10,
      localDate,
      recorded: true,
      source: record.source,
      steps: record.steps,
      timeZone: record.timeZone,
    });
  }
  return {
    activeEnergyKcal: { daysRecorded: energyDays, recordedTotal: energyDays === 0 ? null : energyTenths / 10 },
    days,
    daysInWeek: 7,
    daysWithRecord: byDate.size,
    source: 'manual',
    steps: { daysRecorded: stepsDays, recordedTotal: stepsDays === 0 ? null : stepsTotal },
  };
}

/** "on all 7 days, 56,000 steps in total" / "on 2 of 7 days, 8,042 steps in total on those days; the other 5 days are unknown". */
function recordedOn(daysRecorded: number, total: string): string {
  if (daysRecorded === 7) return `on all 7 days, ${total} in total`;
  const rest = 7 - daysRecorded;
  const unknown = rest === 1 ? 'the other day is unknown' : `the other ${rest} days are unknown`;
  return daysRecorded === 1
    ? `on 1 of 7 days, ${total} on that day; ${unknown}`
    : `on ${daysRecorded} of 7 days, ${total} in total on those days; ${unknown}`;
}

/** The movement statements, in a stable order: none, or steps, active energy, source and zones. */
export function describeMovement(movement: WeeklyReviewMovement, weekTimeZone: string): WeeklyReviewStatement[] {
  const statements: WeeklyReviewStatement[] = [];
  const say = (code: WeeklyReviewStatementCode, text: string) => statements.push({ code, text });
  if (movement.daysWithRecord === 0) {
    say('movement.none', 'No daily movement was recorded this week.');
    return statements;
  }
  const { activeEnergyKcal, steps } = movement;
  if (steps.recordedTotal === null) {
    say('movement.steps_not_recorded', 'Steps were not recorded on any day this week.');
  } else {
    const total = `${groupThousands(steps.recordedTotal)} ${steps.recordedTotal === 1 ? 'step' : 'steps'}`;
    say('movement.steps_recorded', `Steps were recorded ${recordedOn(steps.daysRecorded, total)}.`);
  }
  if (activeEnergyKcal.recordedTotal === null) {
    say('movement.active_energy_not_recorded', 'Active energy was not recorded on any day this week.');
  } else {
    const total = `${formatKcalTenths(Math.round(activeEnergyKcal.recordedTotal * 10))} kcal`;
    say('movement.active_energy_recorded', `Active energy was recorded ${recordedOn(activeEnergyKcal.daysRecorded, total)}.`);
  }
  say(
    'movement.manual_source',
    'Steps and active energy were entered manually; they are shown on their own and not added to the activity or GPS run figures.',
  );
  const zones = [...new Set(movement.days.flatMap((day) => (day.recorded ? [day.timeZone] : [])))].sort();
  if (zones.some((zone) => zone !== weekTimeZone)) {
    const rest = `each counts on the calendar date it was saved for, and the week's activities and GPS runs are still read in ${weekTimeZone}.`;
    const named =
      zones.length === 1 ? `Movement days were saved in ${zones[0]}; ${rest}` : `Movement days were saved in ${zones.length} time zones (${zones.join(', ')}); ${rest}`;
    const unnamed = `Movement days were saved in ${zones.length === 1 ? 'another time zone' : `${zones.length} time zones`}; ${rest}`;
    say('movement.time_zones', named.length <= WEEKLY_REVIEW_STATEMENT_MAX_LENGTH ? named : unnamed);
  }
  return statements;
}

/** Coverage with explicit denominators (see the contract). */
export function coverageOf(aggregate: WeeklyAggregate, detail: ReviewDetail): WeeklyReviewCoverage {
  const withDistance = Object.values(detail.manualWithDistance).reduce((sum, value) => sum + (value ?? 0), 0);
  return {
    daysInWeek: 7,
    daysWithCheckInRecord: detail.checkInRecordDays,
    daysWithCheckInValues: aggregate.checkIns.daysWithData,
    gpsRuns: {
      count: aggregate.gpsRuns.count,
      withCurrentDistance: aggregate.gpsRuns.runsWithCurrentDistance,
      withoutCurrentDistance: aggregate.gpsRuns.runsWithoutCurrentDistance,
    },
    manualActivities: { count: aggregate.manualActivities.count, withDistance },
    metrics: {
      mood: { daysRecorded: aggregate.mood.daysReported },
      sleepDuration: { daysRecorded: aggregate.sleep.daysReported },
      sleepQuality: { daysRecorded: aggregate.sleep.qualityDaysReported },
      soreness: { daysRecorded: aggregate.soreness.daysReported },
      weight: { daysRecorded: aggregate.weight.daysReported },
    },
    noteOnlyDays: detail.checkInRecordDays - aggregate.checkIns.daysWithData,
    sleepQualityWithoutDurationDays: detail.sleepQualityWithoutDurationDays,
  };
}

/**
 * The whole review, validated against the contract. `computedAt` is an ISO instant. `movement` are the week's stored
 * manual movement days, read in the same snapshot as the aggregate's sources.
 */
export function buildWeeklyReview(input: {
  aggregate: WeeklyAggregate;
  computedAt: string;
  detail: ReviewDetail;
  movement: readonly MovementDayRecord[];
}): WeeklyReview {
  const { aggregate, detail } = input;
  const movement = movementOf(input.movement, aggregate.week.start);
  return weeklyReviewSchema.parse({
    coverage: coverageOf(aggregate, detail),
    dataGaps: dataGapsOf(aggregate),
    facts: buildFacts(aggregate),
    movement,
    provenance: {
      computedAt: input.computedAt,
      persisted: false,
      policyVersion: WEEKLY_INSIGHT_POLICY_VERSION,
      reviewVersion: WEEKLY_REVIEW_VERSION,
      snapshot: 'single_read_only_transaction',
      source: 'computed_by_app',
    },
    statements: [...describeWeek(aggregate, detail), ...describeMovement(movement, aggregate.week.timeZone)],
    week: {
      end: aggregate.week.end,
      inProgress: aggregate.week.inProgress,
      start: aggregate.week.start,
      timeZone: aggregate.week.timeZone,
      timeZoneSource: aggregate.week.timeZoneSource,
      zonesOnCheckIns: [...detail.zonesOnCheckIns],
    },
  });
}

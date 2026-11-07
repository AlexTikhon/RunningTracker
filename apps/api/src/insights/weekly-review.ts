import {
  ACTIVITY_TYPES,
  WEEKLY_REVIEW_VERSION,
  weeklyReviewSchema,
  type ActivityType,
  type WeeklyReview,
  type WeeklyReviewCoverage,
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
// AI insight is generated from) and a few counts the aggregate does not carry. Pure: no clock, no database.
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

/** The whole review, validated against the contract. `computedAt` is an ISO instant. */
export function buildWeeklyReview(input: { aggregate: WeeklyAggregate; computedAt: string; detail: ReviewDetail }): WeeklyReview {
  const { aggregate, detail } = input;
  return weeklyReviewSchema.parse({
    coverage: coverageOf(aggregate, detail),
    dataGaps: dataGapsOf(aggregate),
    facts: buildFacts(aggregate),
    provenance: {
      computedAt: input.computedAt,
      persisted: false,
      policyVersion: WEEKLY_INSIGHT_POLICY_VERSION,
      reviewVersion: WEEKLY_REVIEW_VERSION,
      snapshot: 'single_read_only_transaction',
      source: 'computed_by_app',
    },
    statements: describeWeek(aggregate, detail),
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

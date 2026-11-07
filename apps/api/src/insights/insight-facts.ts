import {
  ACTIVITY_TYPES,
  type WeeklyInsightDataGap,
  type WeeklyInsightDay,
  type WeeklyInsightDirection,
  type WeeklyInsightFact,
  type WeeklyInsightUnit,
} from '@running-tracker/contracts';

import type { WeeklyAggregate, Weekday } from './weekly-aggregate.js';

// The fact catalogue of a week (ADR-0076): every number an insight may show, computed and rendered by code. The model
// never writes a number; it cites facts by id, repeating each fact's value, unit, direction and day as a claim, and the
// grounding check accepts a claim only when every field equals the fact's (grounding.ts).
//
// A fact exists only for a value that exists: a week without sleep entries has no sleep facts, so a claim about sleep
// is an unknown fact, never a zero. Counts (check-in days, activities, GPS runs) are real values and may be 0.
//
// The ids are a closed, documented set; `manual.<type>.*` uses the activity types of the contracts.

interface FactInput {
  day?: Weekday | null;
  direction?: WeeklyInsightDirection;
  id: string;
  label: string;
  unit: WeeklyInsightUnit;
  value: number;
  /** Rendering after the label, e.g. "435 min". Default: by unit. */
  valueText?: string;
}

const unitText: Record<WeeklyInsightUnit, (value: number) => string> = {
  count: (value) => String(value),
  days: (value) => `${value} ${value === 1 ? 'day' : 'days'}`,
  hours: (value) => `${value} h`,
  kg: (value) => `${value} kg`,
  km: (value) => `${value} km`,
  minutes: (value) => `${value} min`,
  percent: (value) => `${value}%`,
  score_0_10: (value) => `${value} / 10`,
  score_1_5: (value) => `${value} / 5`,
};

const activityLabel: Record<(typeof ACTIVITY_TYPES)[number], string> = {
  hike: 'Hikes',
  other: 'Other activities',
  ride: 'Rides',
  run: 'Manual runs',
  strength: 'Strength sessions',
  swim: 'Swims',
  walk: 'Walks',
};

function fact(input: FactInput): WeeklyInsightFact {
  const day: WeeklyInsightDay = input.day ?? 'none';
  const direction = input.direction ?? 'none';
  const rendered = input.valueText ?? unitText[input.unit](input.value);
  return {
    day,
    direction,
    id: input.id,
    label: input.label,
    text: `${input.label}: ${rendered}${day === 'none' ? '' : ` (${day})`}`,
    unit: input.unit,
    value: input.value,
  };
}

/** Every fact of the week, in a stable order. */
export function buildFacts(aggregate: WeeklyAggregate): WeeklyInsightFact[] {
  const { checkIns, gpsRuns, manualActivities, mood, sleep, soreness, weight } = aggregate;
  const facts: WeeklyInsightFact[] = [
    fact({ id: 'check_ins.days_with_data', label: 'Days with a check-in', unit: 'days', value: checkIns.daysWithData, valueText: `${checkIns.daysWithData} of ${checkIns.daysInWeek}` }),
    fact({ id: 'check_ins.days_missing', label: 'Days without a check-in', unit: 'days', value: checkIns.daysMissing }),
    fact({ id: 'check_ins.coverage', label: 'Check-in coverage', unit: 'percent', value: checkIns.coveragePercent }),
  ];

  if (sleep.daysReported > 0) {
    facts.push(fact({ id: 'sleep.nights_reported', label: 'Nights with sleep logged', unit: 'days', value: sleep.daysReported }));
  }
  if (sleep.avgMinutes !== null) {
    facts.push(fact({ id: 'sleep.average_minutes', label: 'Average sleep', unit: 'minutes', value: sleep.avgMinutes }));
  }
  if (sleep.avgHours !== null) {
    facts.push(fact({ id: 'sleep.average_hours', label: 'Average sleep', unit: 'hours', value: sleep.avgHours }));
  }
  if (sleep.minMinutes !== null) {
    facts.push(fact({ day: sleep.minDay, id: 'sleep.shortest', label: 'Shortest sleep', unit: 'minutes', value: sleep.minMinutes }));
  }
  if (sleep.maxMinutes !== null) {
    facts.push(fact({ day: sleep.maxDay, id: 'sleep.longest', label: 'Longest sleep', unit: 'minutes', value: sleep.maxMinutes }));
  }
  if (sleep.avgQuality !== null) {
    facts.push(fact({ id: 'sleep.quality_average', label: 'Average sleep quality', unit: 'score_1_5', value: sleep.avgQuality }));
  }
  if (mood.average !== null) {
    facts.push(fact({ id: 'mood.average', label: 'Average mood', unit: 'score_1_5', value: mood.average }));
    facts.push(fact({ id: 'mood.days_reported', label: 'Days with mood logged', unit: 'days', value: mood.daysReported }));
  }
  if (soreness.average !== null) {
    facts.push(fact({ id: 'soreness.average', label: 'Average soreness', unit: 'score_0_10', value: soreness.average }));
    facts.push(fact({ id: 'soreness.days_reported', label: 'Days with soreness logged', unit: 'days', value: soreness.daysReported }));
  }
  if (soreness.max !== null) {
    facts.push(fact({ day: soreness.maxDay, id: 'soreness.highest', label: 'Highest soreness', unit: 'score_0_10', value: soreness.max }));
  }
  if (weight.firstKg !== null) {
    facts.push(fact({ day: weight.firstDay, id: 'weight.first', label: 'First weight of the week', unit: 'kg', value: weight.firstKg }));
  }
  if (weight.lastKg !== null && weight.daysReported >= 2) {
    facts.push(fact({ day: weight.lastDay, id: 'weight.last', label: 'Last weight of the week', unit: 'kg', value: weight.lastKg }));
  }
  if (weight.deltaKg !== null) {
    const direction: WeeklyInsightDirection = weight.deltaKg > 0 ? 'up' : weight.deltaKg < 0 ? 'down' : 'same';
    const magnitude = Math.abs(weight.deltaKg);
    facts.push(
      fact({
        direction,
        id: 'weight.change',
        label: 'Weight change, first to last weigh-in',
        unit: 'kg',
        value: magnitude,
        valueText: direction === 'same' ? 'no change' : `${direction} ${magnitude} kg`,
      }),
    );
  }

  facts.push(fact({ id: 'manual.activities', label: 'Manual activities', unit: 'count', value: manualActivities.count }));
  if (manualActivities.count > 0) {
    facts.push(fact({ id: 'manual.duration', label: 'Manual activity time', unit: 'minutes', value: manualActivities.totalDurationMinutes }));
  }
  for (const type of ACTIVITY_TYPES) {
    const totals = manualActivities.byType[type];
    if (!totals) continue;
    facts.push(fact({ id: `manual.${type}.count`, label: activityLabel[type], unit: 'count', value: totals.count }));
    facts.push(fact({ id: `manual.${type}.duration`, label: `${activityLabel[type]}, time`, unit: 'minutes', value: totals.durationMinutes }));
    if (totals.distanceKm !== null) {
      facts.push(fact({ id: `manual.${type}.distance`, label: `${activityLabel[type]}, distance entered`, unit: 'km', value: totals.distanceKm }));
    }
  }

  facts.push(fact({ id: 'gps.runs', label: 'GPS runs', unit: 'count', value: gpsRuns.count }));
  if (gpsRuns.count > 0) {
    facts.push(fact({ id: 'gps.duration', label: 'GPS run time', unit: 'minutes', value: gpsRuns.totalDurationMinutes }));
  }
  if (gpsRuns.distanceKm !== null) {
    facts.push(
      fact({
        id: 'gps.distance',
        label: 'GPS distance',
        unit: 'km',
        value: gpsRuns.distanceKm,
        valueText:
          gpsRuns.runsWithoutCurrentDistance === 0
            ? `${gpsRuns.distanceKm} km`
            : `${gpsRuns.distanceKm} km (${gpsRuns.runsWithCurrentDistance} of ${gpsRuns.count} runs)`,
      }),
    );
  }
  if (gpsRuns.runsWithoutCurrentDistance > 0) {
    facts.push(
      fact({ id: 'gps.runs_without_current_distance', label: 'GPS runs without a current distance', unit: 'count', value: gpsRuns.runsWithoutCurrentDistance }),
    );
  }
  return facts;
}

/** The week's data gaps and source limitations, written by code from the aggregate's flags. */
export function dataGapsOf(aggregate: WeeklyAggregate): WeeklyInsightDataGap[] {
  const flags = new Set(aggregate.flags);
  const gaps: WeeklyInsightDataGap[] = [];
  const { checkIns, gpsRuns, week } = aggregate;
  if (flags.has('no_check_ins')) {
    gaps.push({ code: 'no_check_ins', text: 'No check-ins with values this week.' });
  } else if (checkIns.daysMissing > 0) {
    gaps.push({
      code: 'missing_check_in_days',
      // "values": a day whose check-in holds only a note is one of the missing days.
      text: `No check-in values on ${checkIns.daysMissing} of ${checkIns.daysInWeek} days; averages use the days that have them.`,
    });
  }
  if (flags.has('no_activities')) gaps.push({ code: 'no_activities', text: 'No manual activities or GPS runs this week.' });
  if (gpsRuns.runsWithoutCurrentDistance > 0) {
    gaps.push({
      code: 'gps_distance_pending',
      text: `${gpsRuns.runsWithoutCurrentDistance} of ${gpsRuns.count} GPS runs have no current distance yet (its summary is missing or older than the run's data).`,
    });
  }
  if (flags.has('manual_and_gps_runs_may_overlap')) {
    gaps.push({
      code: 'manual_and_gps_runs_may_overlap',
      text: 'Manual runs and GPS runs may describe the same run, so they are listed separately and never added together.',
    });
  }
  if (flags.has('multiple_time_zones')) {
    gaps.push({ code: 'multiple_time_zones', text: `Check-ins use more than one time zone; the week is read in ${week.timeZone}.` });
  }
  if (flags.has('week_in_progress')) gaps.push({ code: 'week_in_progress', text: 'This week is not over yet.' });
  return gaps;
}

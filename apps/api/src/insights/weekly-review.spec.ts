import { WEEKLY_REVIEW_VERSION, weeklyReviewSchema, type WeeklyReview, type WeeklyReviewStatementCode } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { validationCases } from '../evaluation/weekly-insight-evaluation.js';
import {
  WEEKLY_INSIGHT_POLICY_VERSION,
  aggregateWeek,
  resolveWeekWindow,
  type CheckInRecord,
  type GpsRunRecord,
  type ManualActivityRecord,
} from './weekly-aggregate.js';
import { inputHashOf } from './weekly-insight-service.js';
import {
  buildWeeklyReview,
  describeWeek,
  formatDuration,
  formatKcalTenths,
  kcalTenthsOf,
  movementOf,
  reviewDetailOf,
  type MovementDayRecord,
  type ReviewDetail,
} from './weekly-review.js';

const WEEK = '2026-11-02'; // a Monday; Europe/Warsaw is on CET (UTC+1) all week
const day = (offset: number) => `2026-11-0${2 + offset}`;
const at = (iso: string) => Date.parse(iso);

function checkIn(localDate: string, values: Partial<CheckInRecord> = {}): CheckInRecord {
  return { localDate, mood: null, sleepMinutes: null, sleepQuality: null, soreness: null, timeZone: 'Europe/Warsaw', weightKg: null, ...values };
}

const activity = (startedAt: string, values: Partial<ManualActivityRecord> = {}): ManualActivityRecord => ({
  distanceM: null,
  durationS: 1800,
  startedAtMs: at(startedAt),
  type: 'run',
  ...values,
});

const gpsRun = (startedAt: string, minutes: number, distanceM: number | null): GpsRunRecord => ({
  distanceM,
  finishedAtMs: at(startedAt) + minutes * 60_000,
  startedAtMs: at(startedAt),
});

function review(input: {
  activities?: ManualActivityRecord[];
  checkIns?: CheckInRecord[];
  gpsRuns?: GpsRunRecord[];
  movement?: MovementDayRecord[];
  requestTimeZone?: string;
  today?: string;
  weekStart?: string;
}): WeeklyReview {
  const checkIns = input.checkIns ?? [];
  const activities = input.activities ?? [];
  const window = resolveWeekWindow({ checkIns, requestTimeZone: input.requestTimeZone ?? 'Europe/Warsaw', weekStart: input.weekStart ?? WEEK });
  const aggregate = aggregateWeek({ activities, checkIns, gpsRuns: input.gpsRuns ?? [], todayLocalDate: input.today ?? '2026-11-20', window });
  return buildWeeklyReview({
    aggregate,
    computedAt: '2026-11-20T10:00:00.000Z',
    detail: reviewDetailOf({ activities, checkIns, window }),
    movement: input.movement ?? [],
  });
}

/** A stored manual movement day; energy in kcal is converted to integer tenths as the database read does. */
const moved = (localDate: string, steps: number | null, kcal: string | null, timeZone = 'Europe/Warsaw'): MovementDayRecord => ({
  activeEnergyTenths: kcal === null ? null : kcalTenthsOf(kcal),
  localDate,
  source: 'manual',
  steps,
  timeZone,
});

const codes = (built: WeeklyReview) => built.statements.map((statement) => statement.code);
const text = (built: WeeklyReview, code: WeeklyReviewStatementCode) => built.statements.find((statement) => statement.code === code)?.text;
const allText = (built: WeeklyReview) => built.statements.map((statement) => statement.text).join('\n');

describe('weekly review: the three-of-four sleep regression', () => {
  // Four days with recorded metrics, sleep duration on three of them: the contradiction an accepted model answer made
  // ("Sleep was logged on every check-in day") must be impossible here.
  const built = review({
    checkIns: [
      checkIn(day(0), { mood: 4, sleepMinutes: 400 }),
      checkIn(day(2), { mood: 3, sleepMinutes: 380 }),
      checkIn(day(4), { mood: 3, weightKg: 77.6 }),
      checkIn(day(5), { mood: 4, sleepMinutes: 430 }),
    ],
  });

  it('states the exact counts against explicit denominators', () => {
    expect(built.coverage).toMatchObject({ daysInWeek: 7, daysWithCheckInRecord: 4, daysWithCheckInValues: 4, noteOnlyDays: 0 });
    expect(built.coverage.metrics.sleepDuration.daysRecorded).toBe(3);
    expect(text(built, 'check_ins.coverage')).toBe('Check-ins with values on 4 of 7 days of the week.');
    expect(text(built, 'sleep_duration.coverage')).toBe('Sleep duration was recorded on 3 of 4 days with check-in values.');
    expect(text(built, 'sleep_duration.values')).toBe(
      'Average recorded sleep duration: 6 h 43 min over 3 days; shortest 6 h 20 min (Wednesday), longest 7 h 10 min (Saturday).',
    );
  });

  it('never says sleep was recorded on every or all check-in days', () => {
    const sleepStatements = built.statements.filter((statement) => /sleep/iu.test(statement.text));
    expect(sleepStatements.length).toBeGreaterThan(0);
    for (const statement of sleepStatements) expect(statement.text).not.toMatch(/\b(every|all|each)\b/iu);
    expect(allText(built)).not.toMatch(/every check-in day/iu);
  });

  it('describes the frozen validation case the accepted model answer contradicted the same way (input not edited)', () => {
    const frozen = validationCases().find((candidate) => candidate.id === 'val_weight_up_manual_runs');
    expect(frozen).toBeDefined();
    const aggregate = frozen!.aggregate;
    // The case's check-ins all carry values and its three activities all carry a distance (see the frozen input).
    const detail: ReviewDetail = { checkInRecordDays: 4, manualWithDistance: { run: 2, walk: 1 }, sleepQualityWithoutDurationDays: 0, zonesOnCheckIns: ['Europe/Warsaw'] };
    const statements = describeWeek(aggregate, detail);
    const sleep = statements.find((statement) => statement.code === 'sleep_duration.coverage');
    expect(sleep?.text).toBe('Sleep duration was recorded on 3 of 4 days with check-in values.');
    expect(statements.map((statement) => statement.text).join(' ')).not.toMatch(/every check-in day/iu);
    expect(statements.find((statement) => statement.code === 'weight.change')?.text).toBe(
      'Weight was recorded on all 4 days with check-in values: 77.1 kg (Monday) first and 77.9 kg (Saturday) last, up 0.8 kg from the first to the last measurement.',
    );
    expect(statements.find((statement) => statement.code === 'manual.run')?.text).toBe('2 manual runs: 1 h 25 min, 14.5 km entered.');
  });
});

describe('weekly review: empty, partial and complete weeks', () => {
  it('an empty week says nothing was recorded, has no metric facts and no zero values', () => {
    const built = review({ requestTimeZone: 'Europe/Warsaw' });
    expect(codes(built)).toEqual(['week.time_zone_from_request', 'check_ins.none', 'manual.none', 'gps.none', 'movement.none']);
    expect(text(built, 'movement.none')).toBe('No daily movement was recorded this week.');
    expect(text(built, 'check_ins.none')).toBe('No check-ins were recorded this week.');
    expect(built.facts.map((fact) => fact.id)).toEqual(['check_ins.days_with_data', 'check_ins.days_missing', 'check_ins.coverage', 'manual.activities', 'gps.runs']);
    expect(built.dataGaps.map((gap) => gap.code)).toEqual(['no_check_ins', 'no_activities']);
    expect(built.week).toEqual({ end: '2026-11-08', inProgress: false, start: WEEK, timeZone: 'Europe/Warsaw', timeZoneSource: 'request', zonesOnCheckIns: [] });
  });

  it('a partial week describes each metric against the days with values, and missing metrics as not recorded', () => {
    const built = review({ checkIns: [checkIn(day(1), { mood: 3, sleepMinutes: 450 }), checkIn(day(3), { mood: 4 })] });
    expect(text(built, 'check_ins.coverage')).toBe('Check-ins with values on 2 of 7 days of the week.');
    expect(text(built, 'sleep_duration.coverage')).toBe('Sleep duration was recorded on 1 of 2 days with check-in values.');
    expect(text(built, 'sleep_duration.values')).toBe('Recorded sleep duration: 7 h 30 min (Tuesday).');
    expect(text(built, 'sleep_quality.not_rated')).toBe('Sleep quality was not rated on any of the 2 days with check-in values.');
    expect(text(built, 'mood.coverage')).toBe('Mood was rated on all 2 days with check-in values; average 3.5 of 5.');
    expect(text(built, 'soreness.not_rated')).toBe('Soreness was not rated on any of the 2 days with check-in values.');
    expect(text(built, 'weight.not_recorded')).toBe('Weight was not recorded on any of the 2 days with check-in values.');
    expect(built.dataGaps[0]).toEqual({ code: 'missing_check_in_days', text: 'No check-in values on 5 of 7 days; averages use the days that have them.' });
  });

  it('a complete week says all 7 days, with every metric', () => {
    const checkIns = [0, 1, 2, 3, 4, 5, 6].map((offset) =>
      checkIn(day(offset), { mood: 4, sleepMinutes: 420 + offset * 10, sleepQuality: 4, soreness: 2, weightKg: 80 - offset * 0.1 }),
    );
    const built = review({ checkIns });
    expect(text(built, 'check_ins.coverage')).toBe('Check-ins with values on all 7 days of the week.');
    expect(text(built, 'sleep_duration.coverage')).toBe('Sleep duration was recorded on all 7 days with check-in values.');
    expect(text(built, 'sleep_quality.coverage')).toBe('Sleep quality was rated on all 7 days with check-in values; average 4 of 5.');
    expect(text(built, 'soreness.coverage')).toBe('Soreness was rated on all 7 days with check-in values; average 2 of 10, highest 2 of 10 (Monday).');
    expect(text(built, 'weight.change')).toBe(
      'Weight was recorded on all 7 days with check-in values: 80 kg (Monday) first and 79.4 kg (Sunday) last, down 0.6 kg from the first to the last measurement.',
    );
    expect(built.dataGaps.map((gap) => gap.code)).toEqual(['no_activities']);
  });
});

describe('weekly review: note-only, quality-only, missing versus zero', () => {
  it('a note-only check-in is a record but not a day with values, and is labelled as such', () => {
    const built = review({ checkIns: [checkIn(day(0), { mood: 4 }), checkIn(day(1))] });
    expect(built.coverage).toMatchObject({ daysWithCheckInRecord: 2, daysWithCheckInValues: 1, noteOnlyDays: 1 });
    expect(text(built, 'check_ins.coverage')).toBe('Check-ins with values on 1 of 7 days of the week.');
    expect(text(built, 'check_ins.note_only_days')).toBe('1 day has a check-in with only a note; it is not counted as a day with values.');
    expect(text(built, 'mood.coverage')).toBe('Mood was rated on the only day with check-in values: 4 of 5.');
  });

  it('a week of note-only check-ins has no check-ins with values', () => {
    const built = review({ checkIns: [checkIn(day(0)), checkIn(day(2))] });
    expect(text(built, 'check_ins.none')).toBe('No check-ins with values were recorded this week.');
    expect(text(built, 'check_ins.note_only_days')).toBe('2 days have check-ins with only a note; they are not counted as days with values.');
    expect(codes(built).some((code) => code.startsWith('sleep') || code.startsWith('mood') || code.startsWith('weight'))).toBe(false);
  });

  it('a sleep-quality-only entry never implies that sleep duration was recorded', () => {
    const built = review({ checkIns: [checkIn(day(0), { sleepQuality: 2 }), checkIn(day(1), { sleepMinutes: 420, sleepQuality: 4 })] });
    expect(built.coverage.metrics).toMatchObject({ sleepDuration: { daysRecorded: 1 }, sleepQuality: { daysRecorded: 2 } });
    expect(built.coverage.sleepQualityWithoutDurationDays).toBe(1);
    expect(text(built, 'sleep_duration.coverage')).toBe('Sleep duration was recorded on 1 of 2 days with check-in values.');
    expect(text(built, 'sleep_quality.coverage')).toBe('Sleep quality was rated on all 2 days with check-in values; average 3 of 5.');
    expect(text(built, 'sleep_quality.without_duration')).toBe(
      'On 1 day sleep quality was rated without a sleep duration; that day does not count as a day with recorded sleep duration.',
    );
    const only = review({ checkIns: [checkIn(day(0), { sleepQuality: 2 })] });
    expect(text(only, 'sleep_duration.not_recorded')).toBe('Sleep duration was not recorded on the only day with check-in values.');
    expect(only.facts.some((fact) => fact.id.startsWith('sleep.') && fact.id !== 'sleep.quality_average')).toBe(false);
  });

  it('a recorded zero is a value; a missing value is "not rated", never zero', () => {
    const zero = review({ checkIns: [checkIn(day(0), { mood: 3, soreness: 0 })] });
    expect(text(zero, 'soreness.coverage')).toBe('Soreness was rated on the only day with check-in values: 0 of 10 (Monday).');
    expect(zero.facts.find((fact) => fact.id === 'soreness.highest')?.value).toBe(0);
    const missing = review({ checkIns: [checkIn(day(0), { mood: 3 })] });
    expect(text(missing, 'soreness.not_rated')).toBe('Soreness was not rated on the only day with check-in values.');
    expect(missing.facts.some((fact) => fact.id.startsWith('soreness.'))).toBe(false);
    expect(allText(missing)).not.toMatch(/\b0\b/u);
  });
});

describe('weekly review: weight', () => {
  it('one measurement gives no change', () => {
    const built = review({ checkIns: [checkIn(day(0), { mood: 3 }), checkIn(day(2), { weightKg: 71.25 })] });
    expect(codes(built)).toContain('weight.single_measurement');
    expect(codes(built)).not.toContain('weight.change');
    expect(text(built, 'weight.single_measurement')).toBe(
      'Weight was recorded on 1 of 2 days with check-in values: 71.25 kg (Wednesday). A change needs at least two measurements.',
    );
    expect(built.facts.some((fact) => fact.id === 'weight.change' || fact.id === 'weight.last')).toBe(false);
  });

  it('two or more measurements give a direction from the first to the last', () => {
    const up = review({ checkIns: [checkIn(day(0), { weightKg: 70 }), checkIn(day(6), { weightKg: 70.4 })] });
    expect(text(up, 'weight.change')).toBe(
      'Weight was recorded on all 2 days with check-in values: 70 kg (Monday) first and 70.4 kg (Sunday) last, up 0.4 kg from the first to the last measurement.',
    );
    const same = review({ checkIns: [checkIn(day(0), { weightKg: 70 }), checkIn(day(3), { weightKg: 71 }), checkIn(day(6), { weightKg: 70 })] });
    expect(text(same, 'weight.change')).toMatch(/, the same at the first and the last measurement\.$/u);
  });
});

describe('weekly review: activities and GPS runs', () => {
  it('describes manual totals by type, naming partial entered distance', () => {
    const built = review({
      activities: [
        activity('2026-11-03T07:00:00Z', { distanceM: 5_000, durationS: 1_800 }),
        activity('2026-11-05T07:00:00Z', { durationS: 2_700 }),
        activity('2026-11-06T16:00:00Z', { durationS: 3_600, type: 'strength' }),
      ],
    });
    expect(text(built, 'manual.total')).toBe('3 manual activities, 2 h 15 min in total.');
    expect(text(built, 'manual.run')).toBe('2 manual runs: 1 h 15 min, 5 km entered for 1 of 2.');
    expect(text(built, 'manual.strength')).toBe('1 strength session: 1 h.');
    expect(built.coverage.manualActivities).toEqual({ count: 3, withDistance: 1 });
  });

  it('gives a GPS distance only from current summaries and names its coverage', () => {
    const all = review({ gpsRuns: [gpsRun('2026-11-03T06:00:00Z', 30, 5_000), gpsRun('2026-11-05T06:00:00Z', 40, 7_360)] });
    expect(text(all, 'gps.totals')).toBe('2 GPS runs: 1 h 10 min, 12.36 km.');
    const partial = review({ gpsRuns: [gpsRun('2026-11-03T06:00:00Z', 30, 5_000), gpsRun('2026-11-05T06:00:00Z', 40, null), gpsRun('2026-11-07T06:00:00Z', 20, 3_100)] });
    expect(text(partial, 'gps.partial_distance')).toBe(
      '3 GPS runs: 1 h 30 min in total. The distance of 8.1 km covers 2 of the 3 runs; 1 run has no current distance yet.',
    );
    expect(partial.coverage.gpsRuns).toEqual({ count: 3, withCurrentDistance: 2, withoutCurrentDistance: 1 });
    expect(partial.dataGaps.map((gap) => gap.code)).toContain('gps_distance_pending');
    const none = review({ gpsRuns: [gpsRun('2026-11-03T06:00:00Z', 30, null)] });
    expect(text(none, 'gps.no_distance')).toBe('1 GPS run: 30 min in total. No current distance is available yet for this run.');
    expect(none.facts.some((fact) => fact.id === 'gps.distance')).toBe(false);
    expect(allText(none)).not.toMatch(/\bkm\b/u);
  });

  it('keeps manual and GPS runs separate and says they may overlap, never adding them', () => {
    const built = review({
      activities: [activity('2026-11-03T07:00:00Z', { distanceM: 5_000 })],
      gpsRuns: [gpsRun('2026-11-03T07:00:00Z', 30, 5_020)],
    });
    expect(text(built, 'manual.run')).toBe('1 manual run: 30 min, 5 km entered.');
    expect(text(built, 'gps.totals')).toBe('1 GPS run: 30 min, 5.02 km.');
    expect(text(built, 'sources.manual_and_gps_runs_separate')).toBe(
      'Manual runs and GPS runs may describe the same runs, so their totals are shown separately and not added together.',
    );
    expect(allText(built)).not.toMatch(/10\.02|1 h\b/u);
  });
});

describe('weekly review: zones, DST and a week in progress', () => {
  it('reports check-ins in several zones and the zone the week is read in', () => {
    const built = review({
      checkIns: [checkIn(day(0), { mood: 3 }), checkIn(day(1), { mood: 3, timeZone: 'Asia/Tokyo' }), checkIn(day(2), { mood: 4 })],
    });
    expect(built.week).toMatchObject({ timeZone: 'Europe/Warsaw', timeZoneSource: 'check_ins', zonesOnCheckIns: ['Asia/Tokyo', 'Europe/Warsaw'] });
    expect(text(built, 'week.multiple_time_zones')).toBe(
      'Check-ins this week were saved in 2 time zones (Asia/Tokyo, Europe/Warsaw); the week is read in Europe/Warsaw.',
    );
    expect(codes(built)).not.toContain('week.time_zone_from_request');
  });

  it('places activities by the local week across the end of daylight saving time', () => {
    // Europe/Warsaw leaves CEST on Sunday 2026-10-25 at 03:00 local: that Sunday ends at 23:00 UTC, not 22:00 UTC.
    const lastMinutes = activity('2026-10-25T22:30:00Z', { type: 'walk' }); // 23:30 CET on Sunday: inside the week
    const nextWeek = activity('2026-10-25T23:00:00Z', { type: 'walk' }); // 00:00 CET on Monday: the next week
    const firstMinutes = activity('2026-10-18T22:00:00Z', { type: 'walk' }); // 00:00 CEST on Monday 2026-10-19: inside
    const built = review({ activities: [firstMinutes, lastMinutes, nextWeek], requestTimeZone: 'Europe/Warsaw', weekStart: '2026-10-19' });
    expect(text(built, 'manual.walk')).toBe('2 walks: 1 h.');
    const following = review({ activities: [firstMinutes, lastMinutes, nextWeek], requestTimeZone: 'Europe/Warsaw', weekStart: '2026-10-26' });
    expect(text(following, 'manual.walk')).toBe('1 walk: 30 min.');
  });

  it('says a week in progress can still change', () => {
    const built = review({ checkIns: [checkIn(day(0), { mood: 3 })], today: day(3) });
    expect(codes(built)[0]).toBe('week.in_progress');
    expect(built.week.inProgress).toBe(true);
  });
});

describe('weekly review: contract, provenance and wording', () => {
  const weeks = [
    review({}),
    review({ checkIns: [checkIn(day(0), { mood: 1, sleepMinutes: 200, soreness: 9, weightKg: 60 }), checkIn(day(6), { weightKg: 63 })] }),
    review({
      activities: [activity('2026-11-03T07:00:00Z', { distanceM: 5_000 }), activity('2026-11-04T07:00:00Z', { type: 'swim', distanceM: 1_500 })],
      checkIns: [checkIn(day(0)), checkIn(day(1), { sleepQuality: 1 }), checkIn(day(2), { sleepMinutes: 800, mood: 5 })],
      gpsRuns: [gpsRun('2026-11-03T07:00:00Z', 30, null), gpsRun('2026-11-05T07:00:00Z', 30, 4_000)],
      today: day(4),
    }),
    // Movement: extreme values, zeros, a single metric, and days saved in other zones.
    review({ movement: [moved(day(0), 200_000, '20000.0', 'America/New_York'), moved(day(1), 0, '0.0'), moved(day(2), null, '0.1', 'Asia/Tokyo')] }),
    review({ movement: [0, 1, 2, 3, 4, 5, 6].map((offset) => moved(day(offset), 0, null)) }),
  ];

  it('is a valid, app-computed, unpersisted review with stable unique codes', () => {
    for (const built of weeks) {
      expect(weeklyReviewSchema.safeParse(built).success).toBe(true);
      expect(built.provenance).toEqual({
        computedAt: '2026-11-20T10:00:00.000Z',
        persisted: false,
        policyVersion: WEEKLY_INSIGHT_POLICY_VERSION,
        reviewVersion: WEEKLY_REVIEW_VERSION,
        snapshot: 'single_read_only_transaction',
        source: 'computed_by_app',
      });
      expect(new Set(codes(built)).size).toBe(built.statements.length);
    }
  });

  it('describes without judging, diagnosing, explaining or advising, even in extreme weeks', () => {
    const words = /\b(good|bad|poor|great|excellent|healthy|unhealthy|normal|usual|typical|enough|too|should|must|try|recommend|consider|because|due|caused|risk|well|better|worse|improv\w*)\b/iu;
    for (const built of weeks) {
      for (const statement of built.statements) expect(statement.text, statement.code).not.toMatch(words);
    }
  });

  it('does not change the aggregate an AI insight is generated from (its input hash)', () => {
    const checkIns = [checkIn(day(0), { mood: 4 }), checkIn(day(1))];
    const window = resolveWeekWindow({ checkIns, requestTimeZone: 'Europe/Warsaw', weekStart: WEEK });
    const aggregate = aggregateWeek({ activities: [], checkIns, gpsRuns: [], todayLocalDate: '2026-11-20', window });
    const before = inputHashOf(aggregate);
    const snapshot = structuredClone(aggregate);
    const built = buildWeeklyReview({
      aggregate,
      computedAt: '2026-11-20T10:00:00.000Z',
      detail: reviewDetailOf({ activities: [], checkIns, window }),
      movement: [moved(day(0), 8042, '412.5'), moved(day(1), 0, null)],
    });
    expect(built.movement.daysWithRecord).toBe(2);
    expect(aggregate).toEqual(snapshot);
    expect(inputHashOf(aggregate)).toBe(before);
    // Movement reaches neither the shared facts nor the data gaps.
    const without = buildWeeklyReview({ aggregate, computedAt: '2026-11-20T10:00:00.000Z', detail: reviewDetailOf({ activities: [], checkIns, window }), movement: [] });
    expect([built.facts, built.dataGaps, built.coverage]).toEqual([without.facts, without.dataGaps, without.coverage]);
    expect(JSON.stringify(built.facts)).not.toMatch(/step|energy|kcal|movement/iu);
  });

  it('formats durations with units', () => {
    expect([formatDuration(0), formatDuration(45), formatDuration(60), formatDuration(403)]).toEqual(['0 min', '45 min', '1 h', '6 h 43 min']);
  });
});

describe('weekly review: manual daily movement (ADR-0079)', () => {
  // The required regression: Monday steps 0 and no energy, Tuesday both, Wednesday energy only, other days missing.
  const regression = review({ movement: [moved(day(0), 0, null), moved(day(1), 8042, '412.5'), moved(day(2), null, '250.0')] });

  it('counts record days and each metric on its own against the 7 calendar days', () => {
    expect(regression.movement).toEqual({
      activeEnergyKcal: { daysRecorded: 2, recordedTotal: 662.5 },
      days: [
        { activeEnergyKcal: null, localDate: '2026-11-02', recorded: true, source: 'manual', steps: 0, timeZone: 'Europe/Warsaw' },
        { activeEnergyKcal: 412.5, localDate: '2026-11-03', recorded: true, source: 'manual', steps: 8042, timeZone: 'Europe/Warsaw' },
        { activeEnergyKcal: 250, localDate: '2026-11-04', recorded: true, source: 'manual', steps: null, timeZone: 'Europe/Warsaw' },
        { localDate: '2026-11-05', recorded: false },
        { localDate: '2026-11-06', recorded: false },
        { localDate: '2026-11-07', recorded: false },
        { localDate: '2026-11-08', recorded: false },
      ],
      daysInWeek: 7,
      daysWithRecord: 3,
      source: 'manual',
      steps: { daysRecorded: 2, recordedTotal: 8042 },
    });
    expect(text(regression, 'movement.steps_recorded')).toBe(
      'Steps were recorded on 2 of 7 days, 8,042 steps in total on those days; the other 5 days are unknown.',
    );
    expect(text(regression, 'movement.active_energy_recorded')).toBe(
      'Active energy was recorded on 2 of 7 days, 662.5 kcal in total on those days; the other 5 days are unknown.',
    );
    expect(text(regression, 'movement.manual_source')).toBe(
      'Steps and active energy were entered manually; they are shown on their own and not added to the activity or GPS run figures.',
    );
    expect(codes(regression)).not.toContain('movement.time_zones');
  });

  it('does not change check-in coverage or its denominators, and a movement-only week is not an empty one', () => {
    const empty = review({});
    expect(regression.coverage).toEqual(empty.coverage);
    expect(regression.facts).toEqual(empty.facts);
    expect(regression.dataGaps).toEqual(empty.dataGaps);
    expect(text(regression, 'check_ins.none')).toBe('No check-ins were recorded this week.');
    expect(codes(regression)).not.toContain('movement.none');
    // Recorded zeros only: still a week with movement.
    const zeroOnly = review({ movement: [moved(day(4), 0, null)] });
    expect(zeroOnly.movement.daysWithRecord).toBe(1);
    expect(codes(zeroOnly)).not.toContain('movement.none');
    // A day with values and a note-only day (a record without values): the same denominators with movement on other days.
    const checkIns = [checkIn(day(0), { mood: 3 }), checkIn(day(1))];
    const withCheckIns = review({ checkIns });
    const withBoth = review({ checkIns, movement: [moved(day(1), 100, null), moved(day(5), 100, '20.5')] });
    expect(withBoth.coverage).toEqual(withCheckIns.coverage);
    expect(withBoth.coverage).toMatchObject({ daysWithCheckInRecord: 2, daysWithCheckInValues: 1, noteOnlyDays: 1 });
    expect(text(withBoth, 'check_ins.coverage')).toBe('Check-ins with values on 1 of 7 days of the week.');
  });

  it('adds energy as integer tenths: 0.1 + 0.2 is 0.3 exactly, in the payload, its JSON and the sentence', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // what adding the numbers would give
    const built = review({ movement: [moved(day(0), null, '0.1'), moved(day(1), null, '0.2')] });
    expect(built.movement.activeEnergyKcal.recordedTotal).toBe(0.3);
    expect(JSON.stringify(built.movement.activeEnergyKcal)).toBe('{"daysRecorded":2,"recordedTotal":0.3}');
    expect(text(built, 'movement.active_energy_recorded')).toBe(
      'Active energy was recorded on 2 of 7 days, 0.3 kcal in total on those days; the other 5 days are unknown.',
    );
    const seven = review({ movement: [0, 1, 2, 3, 4, 5, 6].map((offset) => moved(day(offset), null, '0.1')) });
    expect(seven.movement.activeEnergyKcal.recordedTotal).toBe(0.7);
    const large = review({ movement: [0, 1, 2, 3, 4, 5, 6].map((offset) => moved(day(offset), 200_000, '19999.9')) });
    expect(large.movement.activeEnergyKcal.recordedTotal).toBe(139_999.3);
    expect(large.movement.steps.recordedTotal).toBe(1_400_000);
    expect(text(large, 'movement.steps_recorded')).toBe('Steps were recorded on all 7 days, 1,400,000 steps in total.');
    expect(text(large, 'movement.active_energy_recorded')).toBe('Active energy was recorded on all 7 days, 139,999.3 kcal in total.');
  });

  it('reads stored energy text exactly and refuses anything with a meaningful second decimal', () => {
    expect(['412.5', '0.0', '0', '250', '412.50', '20000.000', '0.1'].map(kcalTenthsOf)).toEqual([4125, 0, 0, 2500, 4125, 200_000, 1]);
    for (const bad of ['412.55', '-0.1', '1e3', 'NaN', 'Infinity', '', '.5', '412.', '123456']) {
      expect(() => kcalTenthsOf(bad), bad).toThrow(/more than one meaningful decimal/u);
    }
    expect([formatKcalTenths(0), formatKcalTenths(3), formatKcalTenths(6625), formatKcalTenths(2500), formatKcalTenths(1_399_993)]).toEqual([
      '0',
      '0.3',
      '662.5',
      '250',
      '139,999.3',
    ]);
  });

  it('an all-zero metric has total 0 and nonzero coverage; a metric never recorded has total null and zero coverage', () => {
    const built = review({ movement: [moved(day(0), 0, null), moved(day(3), 0, null)] });
    expect(built.movement.steps).toEqual({ daysRecorded: 2, recordedTotal: 0 });
    expect(built.movement.activeEnergyKcal).toEqual({ daysRecorded: 0, recordedTotal: null });
    expect(text(built, 'movement.steps_recorded')).toBe('Steps were recorded on 2 of 7 days, 0 steps in total on those days; the other 5 days are unknown.');
    expect(text(built, 'movement.active_energy_not_recorded')).toBe('Active energy was not recorded on any day this week.');
    const energyOnly = review({ movement: [moved(day(6), null, '0.0')] });
    expect(energyOnly.movement.activeEnergyKcal).toEqual({ daysRecorded: 1, recordedTotal: 0 });
    expect(text(energyOnly, 'movement.steps_not_recorded')).toBe('Steps were not recorded on any day this week.');
    expect(text(energyOnly, 'movement.active_energy_recorded')).toBe('Active energy was recorded on 1 of 7 days, 0 kcal on that day; the other 6 days are unknown.');
    const sixDays = review({ movement: [0, 1, 2, 3, 4, 5].map((offset) => moved(day(offset), 1, null)) });
    expect(text(sixDays, 'movement.steps_recorded')).toBe('Steps were recorded on 6 of 7 days, 6 steps in total on those days; the other day is unknown.');
    const oneStep = review({ movement: [moved(day(0), 1, null)] });
    expect(text(oneStep, 'movement.steps_recorded')).toBe('Steps were recorded on 1 of 7 days, 1 step on that day; the other 6 days are unknown.');
  });

  it('uses the stored local dates Monday to Sunday inclusive, and only manual rows', () => {
    const records = [
      moved('2026-11-01', 111, '1.0'), // the Sunday before
      moved(day(0), 1, null),
      moved(day(6), 2, null),
      moved('2026-11-09', 999, '9.0'), // the Monday after
      { ...moved(day(3), 50_000, '5000.0'), source: 'apple_health' as unknown as 'manual' }, // never counted
    ];
    const movement = movementOf(records, WEEK);
    expect(movement.days.map((entry) => entry.localDate)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
    expect(movement.daysWithRecord).toBe(2);
    expect(movement.steps).toEqual({ daysRecorded: 2, recordedTotal: 3 });
    expect(movement.activeEnergyKcal).toEqual({ daysRecorded: 0, recordedTotal: null });
  });

  it('explains days saved in other zones without moving the week the activities and GPS runs are read in', () => {
    const checkIns = [checkIn(day(0), { mood: 3 })];
    // 00:30 on Monday 2026-11-09 in Warsaw (outside the week), 18:30 on Sunday in New York (inside it, if read there).
    const activities = [activity('2026-11-08T23:30:00Z')];
    const without = review({ activities, checkIns });
    const built = review({ activities, checkIns, movement: [moved(day(6), 5000, null, 'America/New_York'), moved(day(5), 10, null)] });
    expect(built.week).toEqual(without.week);
    expect(built.coverage.manualActivities.count).toBe(0);
    expect(text(built, 'movement.time_zones')).toBe(
      "Movement days were saved in 2 time zones (America/New_York, Europe/Warsaw); each counts on the calendar date it was saved for, and the week's activities and GPS runs are still read in Europe/Warsaw.",
    );
    const single = review({ checkIns, movement: [moved(day(1), 5000, null, 'Asia/Tokyo')] });
    expect(text(single, 'movement.time_zones')).toBe(
      "Movement days were saved in Asia/Tokyo; each counts on the calendar date it was saved for, and the week's activities and GPS runs are still read in Europe/Warsaw.",
    );
    // The week read in the device zone (no check-ins): movement in that zone needs no explanation.
    expect(codes(review({ movement: [moved(day(1), 5000, null, 'Europe/Warsaw')] }))).not.toContain('movement.time_zones');
    const long = review({
      checkIns,
      movement: [0, 1, 2, 3, 4, 5, 6].map((offset) => moved(day(offset), 1, null, `America/Argentina/ComodRivadavia${'x'.repeat(offset)}`)),
    });
    expect(text(long, 'movement.time_zones')).toMatch(/^Movement days were saved in 7 time zones; each counts/u);
  });

  it('keeps the in-progress notice first, and movement statements after every other statement', () => {
    const built = review({ checkIns: [checkIn(day(0), { mood: 3 })], movement: [moved(day(0), 10, '1.5', 'UTC')], today: day(2) });
    expect(codes(built)[0]).toBe('week.in_progress');
    expect(codes(built).slice(-4)).toEqual(['movement.steps_recorded', 'movement.active_energy_recorded', 'movement.manual_source', 'movement.time_zones']);
  });
});

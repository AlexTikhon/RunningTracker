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
import { buildWeeklyReview, describeWeek, formatDuration, reviewDetailOf, type ReviewDetail } from './weekly-review.js';

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
  requestTimeZone?: string;
  today?: string;
  weekStart?: string;
}): WeeklyReview {
  const checkIns = input.checkIns ?? [];
  const activities = input.activities ?? [];
  const window = resolveWeekWindow({ checkIns, requestTimeZone: input.requestTimeZone ?? 'Europe/Warsaw', weekStart: input.weekStart ?? WEEK });
  const aggregate = aggregateWeek({ activities, checkIns, gpsRuns: input.gpsRuns ?? [], todayLocalDate: input.today ?? '2026-11-20', window });
  return buildWeeklyReview({ aggregate, computedAt: '2026-11-20T10:00:00.000Z', detail: reviewDetailOf({ activities, checkIns, window }) });
}

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
    expect(codes(built)).toEqual(['week.time_zone_from_request', 'check_ins.none', 'manual.none', 'gps.none']);
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
    buildWeeklyReview({ aggregate, computedAt: '2026-11-20T10:00:00.000Z', detail: reviewDetailOf({ activities: [], checkIns, window }) });
    expect(inputHashOf(aggregate)).toBe(before);
  });

  it('formats durations with units', () => {
    expect([formatDuration(0), formatDuration(45), formatDuration(60), formatDuration(403)]).toEqual(['0 min', '45 min', '1 h', '6 h 43 min']);
  });
});

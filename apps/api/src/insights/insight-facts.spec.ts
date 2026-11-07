import { weeklyInsightFactSchema } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { buildFacts, dataGapsOf } from './insight-facts.js';
import { aggregateWeek, resolveWeekWindow, type CheckInRecord, type GpsRunRecord, type ManualActivityRecord } from './weekly-aggregate.js';

const WEEK = '2026-11-02';
function week(input: { activities?: ManualActivityRecord[]; checkIns?: Partial<CheckInRecord>[]; gpsRuns?: GpsRunRecord[]; zones?: string[] }) {
  const checkIns: CheckInRecord[] = (input.checkIns ?? []).map((values, index) => ({
    localDate: `2026-11-0${2 + index}`,
    mood: null,
    sleepMinutes: null,
    sleepQuality: null,
    soreness: null,
    timeZone: input.zones?.[index] ?? 'Europe/Warsaw',
    weightKg: null,
    ...values,
  }));
  const window = resolveWeekWindow({ checkIns, requestTimeZone: 'Europe/Warsaw', weekStart: WEEK });
  return aggregateWeek({ activities: input.activities ?? [], checkIns, gpsRuns: input.gpsRuns ?? [], todayLocalDate: '2026-11-20', window });
}
const texts = (aggregate: ReturnType<typeof week>) => buildFacts(aggregate).map((fact) => fact.text);

describe('weekly insight facts (ADR-0076)', () => {
  it('renders every number deterministically from code, and every fact matches the contract', () => {
    const aggregate = week({ checkIns: [{ mood: 4, sleepMinutes: 420, soreness: 8, weightKg: 72.4 }, { sleepMinutes: 480, weightKg: 73.1 }] });
    const facts = buildFacts(aggregate);
    for (const fact of facts) expect(weeklyInsightFactSchema.safeParse(fact).success).toBe(true);
    expect(texts(aggregate)).toEqual(
      expect.arrayContaining([
        'Days with a check-in: 2 of 7',
        'Average sleep: 450 min',
        'Average sleep: 7.5 h',
        'Shortest sleep: 420 min (Monday)',
        'Longest sleep: 480 min (Tuesday)',
        'Highest soreness: 8 / 10 (Monday)',
        'Weight change, first to last weigh-in: up 0.7 kg',
        'Manual activities: 0',
        'GPS runs: 0',
      ]),
    );
    expect(buildFacts(aggregate)).toEqual(facts);
  });

  it('has no fact for a value that was not recorded: a missing value is never a zero', () => {
    const ids = buildFacts(week({ checkIns: [{ mood: 3 }] })).map((fact) => fact.id);
    expect(ids).toContain('mood.average');
    for (const missing of ['sleep.average_minutes', 'sleep.shortest', 'soreness.average', 'weight.first', 'weight.change', 'gps.distance']) {
      expect(ids).not.toContain(missing);
    }
  });

  it('has no weight change, and no last weight, with a single weigh-in', () => {
    const ids = buildFacts(week({ checkIns: [{ weightKg: 70 }] })).map((fact) => fact.id);
    expect(ids).toContain('weight.first');
    expect(ids).not.toContain('weight.last');
    expect(ids).not.toContain('weight.change');
  });

  it('counts a GPS distance only from runs with a current summary, and reports the rest as a data gap', () => {
    const run = (startIso: string, distanceM: number | null): GpsRunRecord => ({
      distanceM,
      finishedAtMs: Date.parse(startIso) + 1_800_000,
      startedAtMs: Date.parse(startIso),
    });
    const aggregate = week({ gpsRuns: [run('2026-11-03T07:00:00Z', 5_000), run('2026-11-05T07:00:00Z', null)] });
    expect(texts(aggregate)).toEqual(expect.arrayContaining(['GPS distance: 5 km (1 of 2 runs)', 'GPS runs without a current distance: 1']));
    expect(dataGapsOf(aggregate).map((gap) => gap.code)).toContain('gps_distance_pending');
    const none = week({ gpsRuns: [run('2026-11-03T07:00:00Z', null)] });
    expect(buildFacts(none).map((fact) => fact.id)).not.toContain('gps.distance');
  });

  it('keeps manual runs and GPS runs separate: there is no combined fact', () => {
    const aggregate = week({
      activities: [{ distanceM: 5_000, durationS: 1_800, startedAtMs: Date.parse('2026-11-03T06:00:00Z'), type: 'run' }],
      gpsRuns: [{ distanceM: 5_100, finishedAtMs: Date.parse('2026-11-03T06:31:00Z'), startedAtMs: Date.parse('2026-11-03T06:01:00Z') }],
    });
    const facts = buildFacts(aggregate);
    expect(facts.find((fact) => fact.id === 'manual.run.distance')?.value).toBe(5);
    expect(facts.find((fact) => fact.id === 'gps.distance')?.value).toBe(5.1);
    expect(facts.some((fact) => fact.value === 10.1)).toBe(false);
    expect(dataGapsOf(aggregate).map((gap) => gap.code)).toContain('manual_and_gps_runs_may_overlap');
  });

  it('writes the data gaps from the flags: empty, sparse and mixed-zone weeks', () => {
    expect(dataGapsOf(week({})).map((gap) => gap.code)).toEqual(['no_check_ins', 'no_activities']);
    expect(dataGapsOf(week({ checkIns: [{ mood: 3 }] }))[0]).toEqual({
      code: 'missing_check_in_days',
      text: 'No check-in on 6 of 7 days; averages use the days that have one.',
    });
    const mixed = week({ checkIns: [{ mood: 3 }, { mood: 4 }, { mood: 4 }], zones: ['Europe/Warsaw', 'America/New_York', 'Europe/Warsaw'] });
    expect(dataGapsOf(mixed).find((gap) => gap.code === 'multiple_time_zones')?.text).toBe(
      'Check-ins use more than one time zone; the week is read in Europe/Warsaw.',
    );
  });
});

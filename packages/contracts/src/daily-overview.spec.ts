import { describe, expect, it } from 'vitest';

import {
  DAILY_OVERVIEW_VERSION,
  dailyOverviewPathSchema,
  dailyOverviewQuerySchema,
  dailyOverviewSchema,
  isEmptyDailyOverview,
  openApiDocument,
  type DailyOverview,
} from './index.js';

const overview: DailyOverview = {
  checkIn: { hasNote: true, mood: 4, recorded: true, sleepMinutes: 450, sleepQuality: null, soreness: 0, timeZone: 'Asia/Tokyo', weightKg: 72.35 },
  day: {
    endsAt: '2026-03-29T22:00:00.000Z',
    inProgress: false,
    localDate: '2026-03-29',
    startsAt: '2026-03-28T23:00:00.000Z',
    timeZone: 'Europe/Warsaw',
  },
  gpsRuns: { count: 2, currentDistanceM: 5012, withCurrentDistance: 1, withoutCurrentDistance: 1 },
  manualActivities: {
    byType: [
      { count: 2, enteredDurationS: 5400, type: 'run' },
      { count: 1, enteredDurationS: 1800, type: 'strength' },
    ],
    count: 3,
    enteredDurationS: 7200,
  },
  movement: { activeEnergyKcal: null, recorded: true, source: 'manual', steps: 0, timeZone: 'Europe/Warsaw' },
  provenance: {
    computedAt: '2026-11-08T10:00:00.000Z',
    overviewVersion: DAILY_OVERVIEW_VERSION,
    persisted: false,
    snapshot: 'single_read_only_transaction',
    source: 'computed_by_app',
  },
};

const empty: DailyOverview = {
  ...overview,
  checkIn: { recorded: false },
  gpsRuns: { count: 0, currentDistanceM: null, withCurrentDistance: 0, withoutCurrentDistance: 0 },
  manualActivities: { byType: [], count: 0, enteredDurationS: 0 },
  movement: { recorded: false },
};

const issues = (value: unknown) => {
  const parsed = dailyOverviewSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe('daily overview contract', () => {
  it('accepts a complete overview, an empty one and a 23-hour day', () => {
    expect(dailyOverviewSchema.parse(overview)).toEqual(overview);
    expect(dailyOverviewSchema.parse(empty)).toEqual(empty);
  });

  it('keeps a note-only check-in a record without returning its note, and refuses a record with nothing at all', () => {
    const noteOnly = { hasNote: true, mood: null, recorded: true, sleepMinutes: null, sleepQuality: null, soreness: null, timeZone: 'Europe/Warsaw', weightKg: null };
    expect(dailyOverviewSchema.parse({ ...empty, checkIn: noteOnly }).checkIn).toEqual(noteOnly);
    expect(issues({ ...empty, checkIn: { ...noteOnly, hasNote: false } })).toContain('A stored check-in has at least one value or a note');
    expect(issues({ ...empty, checkIn: { ...noteOnly, note: 'secret' } })).not.toEqual([]);
    expect(issues({ ...empty, checkIn: { recorded: false, mood: 3 } })).not.toEqual([]);
  });

  it('keeps a recorded zero, refuses an empty movement record and a source other than manual', () => {
    expect(dailyOverviewSchema.parse({ ...empty, movement: { activeEnergyKcal: 0, recorded: true, source: 'manual', steps: 0, timeZone: 'UTC' } }).movement).toMatchObject({
      activeEnergyKcal: 0,
      steps: 0,
    });
    expect(issues({ ...empty, movement: { activeEnergyKcal: null, recorded: true, source: 'manual', steps: null, timeZone: 'UTC' } })).toContain(
      'A stored movement day has at least one value',
    );
    expect(issues({ ...empty, movement: { ...overview.movement, source: 'healthkit' } })).not.toEqual([]);
    expect(issues({ ...empty, movement: { ...overview.movement, activeEnergyKcal: 412.55 } })).not.toEqual([]);
  });

  it('requires the per-type activity figures to add up, each type once, in the fixed order', () => {
    expect(issues({ ...overview, manualActivities: { ...overview.manualActivities, count: 4 } })).toContain('the per-type counts add up to the count');
    expect(issues({ ...overview, manualActivities: { ...overview.manualActivities, enteredDurationS: 1 } })).toContain(
      'the per-type durations add up to the duration',
    );
    const reversed = { ...overview.manualActivities, byType: overview.manualActivities.byType.toReversed() };
    expect(issues({ ...overview, manualActivities: reversed })).toContain('types are listed once each, in the order of ACTIVITY_TYPES');
    const zeroType = { byType: [{ count: 0, enteredDurationS: 0, type: 'walk' }], count: 0, enteredDurationS: 0 };
    expect(issues({ ...overview, manualActivities: zeroType })).not.toEqual([]);
  });

  it('ties a GPS distance total to the runs with a current distance', () => {
    expect(issues({ ...overview, gpsRuns: { count: 2, currentDistanceM: null, withCurrentDistance: 1, withoutCurrentDistance: 1 } })).toContain(
      'a distance total exists exactly when at least one run has a current distance',
    );
    expect(issues({ ...overview, gpsRuns: { count: 1, currentDistanceM: 0, withCurrentDistance: 0, withoutCurrentDistance: 1 } })).toContain(
      'a distance total exists exactly when at least one run has a current distance',
    );
    expect(issues({ ...overview, gpsRuns: { count: 3, currentDistanceM: 10, withCurrentDistance: 1, withoutCurrentDistance: 1 } })).toContain(
      'every GPS run either has a current distance or not',
    );
    expect(issues({ ...overview, gpsRuns: { ...overview.gpsRuns, currentDistanceM: 10.5 } })).not.toEqual([]);
  });

  it('refuses unknown fields, a day that ends before it starts and provenance that claims to be stored', () => {
    expect(issues({ ...overview, owner: 'x' })).not.toEqual([]);
    expect(issues({ ...overview, day: { ...overview.day, endsAt: '2026-03-28T22:00:00.000Z' } })).toContain('the day cannot end before it starts');
    expect(issues({ ...overview, provenance: { ...overview.provenance, persisted: true } })).not.toEqual([]);
  });

  it('validates the path and the query strictly', () => {
    const orgId = '11111111-1111-4111-8111-111111111111';
    expect(dailyOverviewPathSchema.safeParse({ localDate: '2000-01-01', orgId }).success).toBe(true);
    for (const localDate of ['1999-12-31', '2026-02-30', '2026-2-03', 'today']) {
      expect(dailyOverviewPathSchema.safeParse({ localDate, orgId }).success, localDate).toBe(false);
    }
    expect(dailyOverviewPathSchema.safeParse({ localDate: '2026-11-08', orgId: 'not-a-uuid' }).success).toBe(false);
    expect(dailyOverviewQuerySchema.safeParse({ timeZone: 'Europe/Warsaw' }).success).toBe(true);
    for (const query of [{}, { timeZone: '+01:00' }, { timeZone: 'CET-ish' }, { timeZone: 'Europe/Warsaw', extra: '1' }, { timeZone: ['Europe/Warsaw'] }]) {
      expect(dailyOverviewQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it('calls a day empty only when nothing at all is recorded', () => {
    expect(isEmptyDailyOverview(empty)).toBe(true);
    expect(isEmptyDailyOverview({ ...empty, checkIn: overview.checkIn })).toBe(false);
    expect(isEmptyDailyOverview({ ...empty, movement: { activeEnergyKcal: null, recorded: true, source: 'manual', steps: 0, timeZone: 'UTC' } })).toBe(false);
    expect(isEmptyDailyOverview({ ...empty, manualActivities: overview.manualActivities })).toBe(false);
    expect(isEmptyDailyOverview({ ...empty, gpsRuns: { count: 1, currentDistanceM: null, withCurrentDistance: 0, withoutCurrentDistance: 1 } })).toBe(false);
  });

  it('is documented in OpenAPI with its strict query parameter', () => {
    const operation = openApiDocument.paths['/api/orgs/{orgId}/daily-overview/{localDate}'].get;
    expect(operation.parameters).toEqual([
      { $ref: '#/components/parameters/OrgId' },
      { $ref: '#/components/parameters/LocalDate' },
      { $ref: '#/components/parameters/OverviewTimeZone' },
    ]);
    expect(Object.keys(openApiDocument.components.schemas)).toContain('DailyOverview');
  });
});

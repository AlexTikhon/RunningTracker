import { uuidSchema } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import {
  anchorForUser,
  classifyShare,
  deterministicUuid,
  expectedTotals,
  geographyAnchors,
  hash01,
  ordinaryProfile,
  planDataset,
  planShares,
  planUsers,
  pointIntervalMs,
  smokeProfile,
  stressProfile,
  validateProfile,
  type DatasetProfile,
} from './dataset-plan.js';

const asOf = new Date('2032-03-01T00:00:00.000Z');

describe('dataset profiles', () => {
  it('match the SDD ordinary and stress volumes exactly', () => {
    expect(expectedTotals(ordinaryProfile, 42)).toMatchObject({
      rawPoints: 126_000,
      rawRuns: 70,
      runs: 3_650,
      summaries: 3_650,
      users: 10,
    });
    expect(expectedTotals(stressProfile, 42)).toMatchObject({
      rawPoints: 3_000_000,
      rawRuns: 70,
      runs: 3_650,
      summaries: 3_650,
    });
  });

  it('rejects profiles that break the SDD run limits', () => {
    const invalid: [string, Partial<DatasetProfile>][] = [
      ['more than ten users', { users: 11 }],
      ['as many coaches as users', { coaches: 10 }],
      ['raw days beyond the archive', { rawDays: 366 }],
      ['fewer than two points per raw run', { rawPointBudget: 100 }],
      ['runs above the 50,000-point safety limit', { rawPointBudget: 4_000_000 }],
      ['runs that overflow a 24-hour slot', { rawPointBudget: 3_100_000, rawDays: 7 }],
      ['a descending speed range', { speedMps: [3, 2] }],
      ['a fractional day count', { archiveDays: 1.5 }],
      ['raw points without raw days', { rawDays: 0 }],
    ];
    for (const [label, override] of invalid) {
      expect(() => validateProfile({ ...ordinaryProfile, ...override }), label).toThrow();
    }
    expect(() => validateProfile({ ...ordinaryProfile, rawDays: 0, rawPointBudget: 0 })).not.toThrow();
  });
});

describe('deterministic helpers', () => {
  it('produces stable, distinct, RFC-shaped UUIDs', () => {
    const first = deterministicUuid(42, 'run', 0);
    expect(first).toBe(deterministicUuid(42, 'run', 0));
    expect(uuidSchema.safeParse(first).success).toBe(true);
    const others = [
      deterministicUuid(43, 'run', 0),
      deterministicUuid(42, 'run', 1),
      deterministicUuid(42, 'user', 0),
    ];
    expect(new Set([first, ...others]).size).toBe(4);
  });

  it('draws stable values in [0, 1) that depend on seed and key', () => {
    expect(hash01(1, 'a', 2)).toBe(hash01(1, 'a', 2));
    expect(hash01(1, 'a', 2)).not.toBe(hash01(2, 'a', 2));
    for (let index = 0; index < 200; index += 1) {
      const value = hash01(7, 'range', index);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('planDataset', () => {
  it('is reproducible for one seed and instant and changes with either', () => {
    const first = planDataset(smokeProfile, 42, asOf);
    expect(planDataset(smokeProfile, 42, asOf)).toEqual(first);
    expect(planDataset(smokeProfile, 43, asOf)).not.toEqual(first);
    expect(planDataset(smokeProfile, 42, new Date(asOf.getTime() + 1_000))).not.toEqual(first);
  });

  it('distributes the raw point budget exactly and keeps every run inside its slot', () => {
    for (const profile of [ordinaryProfile, stressProfile]) {
      const plan = planDataset(profile, 42, asOf);
      const raw = plan.runs.filter((run) => run.hasRaw);
      expect(raw).toHaveLength(profile.users * profile.rawDays);
      expect(raw.reduce((sum, run) => sum + run.pointCount, 0)).toBe(profile.rawPointBudget);
      const counts = raw.map((run) => run.pointCount);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
      expect(Math.max(...counts)).toBeLessThanOrEqual(50_000);

      for (const run of plan.runs) {
        expect(uuidSchema.safeParse(run.id).success).toBe(true);
        const started = Date.parse(run.startedAt);
        const finished = Date.parse(run.finishedAt);
        expect(finished - started).toBe((run.pointCount - 1) * pointIntervalMs);
        expect(finished).toBeLessThan(asOf.getTime() - run.dayIndex * 86_400_000);
        expect(started).toBeGreaterThanOrEqual(asOf.getTime() - (run.dayIndex + 1) * 86_400_000);
        expect(run.dataRevision).toBe(Math.ceil(run.pointCount / 100) + 1);
        expect(run.laps).toBeGreaterThan(0);
        expect(run.vertexCount).toBeGreaterThanOrEqual(48);
        expect(run.vertexCount).toBeLessThanOrEqual(600);
      }
    }
  });

  it('never overlaps two runs of one user, so at most one could be active', () => {
    const plan = planDataset(stressProfile, 42, asOf);
    for (let user = 0; user < stressProfile.users; user += 1) {
      const runs = plan.runs
        .filter((run) => run.userIndex === user)
        .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
      for (let position = 1; position < runs.length; position += 1) {
        expect(Date.parse(runs[position]?.startedAt ?? '')).toBeGreaterThan(
          Date.parse(runs[position - 1]?.finishedAt ?? ''),
        );
      }
    }
  });

  it('keeps raw data only inside the seven-day raw retention window', () => {
    const plan = planDataset(ordinaryProfile, 42, asOf);
    const sevenDaysBefore = asOf.getTime() - 7 * 86_400_000;
    for (const run of plan.runs) {
      const finished = Date.parse(run.finishedAt);
      expect(run.hasRaw).toBe(finished > sevenDaysBefore);
      expect(finished).toBeGreaterThan(asOf.getTime() - 365 * 86_400_000);
    }
  });

  it('spreads users over distinct regions including one straddling the antimeridian', () => {
    const plan = planDataset(ordinaryProfile, 42, asOf);
    const antimeridianUser = geographyAnchors.findIndex((anchor) => anchor.longitude === 180);
    expect(antimeridianUser).toBeGreaterThanOrEqual(0);
    const regions = new Set(plan.users.map((user) => anchorForUser(user.index).name));
    expect(regions.size).toBe(geographyAnchors.length);

    for (const run of plan.runs.filter((candidate) => candidate.userIndex === antimeridianUser)) {
      const metresPerLongitudeDegree = 111_320 * Math.cos((run.centerLatitude * Math.PI) / 180);
      expect(Math.abs(run.centerLongitude - 180) * metresPerLongitudeDegree).toBeLessThan(run.radiusM);
    }
    for (const run of plan.runs) {
      expect(Math.abs(run.centerLatitude)).toBeLessThan(70);
    }
  });
});

describe('sharing distribution', () => {
  const users = planUsers(ordinaryProfile, 42);

  it('assigns roles from the end of the member list', () => {
    expect(users.map((user) => user.role)).toEqual([
      ...Array<string>(8).fill('runner'),
      'coach',
      'coach',
    ]);
  });

  it('gives every coach both grants from every runner', () => {
    for (const coach of users.filter((user) => user.role === 'coach')) {
      for (const runner of users.filter((user) => user.role === 'runner')) {
        expect(classifyShare(42, runner.index, coach.index, users)).toEqual({
          canReadHistory: true,
          canReadLive: true,
        });
      }
    }
  });

  it('covers none, history-only, live-only, and both among runner pairs', () => {
    const classes = new Set<string>();
    for (const owner of users.slice(0, 8)) {
      for (const grantee of users.slice(0, 8)) {
        if (owner.index !== grantee.index) {
          const grant = classifyShare(42, owner.index, grantee.index, users);
          classes.add(`${grant.canReadHistory}/${grant.canReadLive}`);
        }
      }
    }
    expect([...classes].sort()).toEqual(['false/false', 'false/true', 'true/false', 'true/true']);
  });

  it('never self-shares and only lists pairs with at least one grant', () => {
    const shares = planShares(42, users);
    expect(shares.length).toBeGreaterThan(0);
    for (const share of shares) {
      expect(share.ownerIndex).not.toBe(share.granteeIndex);
      expect(share.canReadHistory || share.canReadLive).toBe(true);
    }
    expect(planShares(42, users)).toEqual(shares);
  });

  it('multiplies pair policies by the archive length', () => {
    expect(expectedTotals(smokeProfile, 42).runShares).toBe(
      planShares(42, planUsers(smokeProfile, 42)).length * smokeProfile.archiveDays,
    );
  });
});

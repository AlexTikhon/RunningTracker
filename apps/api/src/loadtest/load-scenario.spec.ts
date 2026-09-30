import { ingestPointsRequestSchema, tilePathSchema } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import {
  namedProfiles,
  ordinaryProfile,
  planDataset,
  smokeProfile,
  stressProfile,
  type DatasetPlan,
  type DatasetProfile,
} from './dataset-plan.js';
import {
  buildCatchupBatch,
  buildFreshPoint,
  expectedObserversOf,
  lonLatToTile,
  planLoadScenario,
  planTileBurst,
  workloadProfiles,
  type LoadScenarioPlan,
} from './load-scenario.js';

const asOf = new Date('2032-03-01T00:00:00.000Z');
const startedAtMs = Date.parse('2032-03-01T10:00:00.000Z');

function workloadFor(profile: DatasetProfile) {
  const workload = workloadProfiles[profile.name];
  if (!workload) {
    throw new Error(`no workload for ${profile.name}`);
  }
  return workload;
}

function scenario(profile: DatasetProfile = ordinaryProfile, seed = 42): LoadScenarioPlan {
  return planLoadScenario(planDataset(profile, seed, asOf), workloadFor(profile));
}

function haversineMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const radians = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

describe('workload profiles', () => {
  it('exist for every dataset profile and keep the SDD concurrency shape for ordinary and stress', () => {
    for (const name of Object.keys(namedProfiles)) {
      expect(workloadProfiles[name], name).toBeDefined();
    }
    for (const dataset of [ordinaryProfile, stressProfile]) {
      const plan = scenario(dataset);
      expect(plan.activeRuns).toHaveLength(10);
      expect(plan.observerCount).toBe(10);
      expect(plan.workload.catchupBatchSize).toBe(100);
    }
    expect(scenario(smokeProfile).activeRuns).toHaveLength(smokeProfile.users);
  });
});

describe('planLoadScenario', () => {
  it('derives every identifier deterministically from the dataset seed and keeps them distinct', () => {
    const first = scenario();
    const second = scenario();
    expect(second.activeRuns.map((run) => run.runId)).toEqual(first.activeRuns.map((run) => run.runId));
    expect(second.summaryRun.runId).toBe(first.summaryRun.runId);

    const datasetIds = new Set(planDataset(ordinaryProfile, 42, asOf).runs.map((run) => run.id));
    const loadIds = [...first.activeRuns, first.summaryRun].map((run) => run.runId);
    expect(new Set(loadIds).size).toBe(11);
    for (const id of loadIds) {
      expect(datasetIds.has(id)).toBe(false);
    }
    expect(scenario(ordinaryProfile, 43).activeRuns[0]?.runId).not.toBe(first.activeRuns[0]?.runId);
  });

  it('gives each member one active run and a distinct summary run on the member that finishes first', () => {
    const plan = scenario();
    expect(plan.activeRuns.map((run) => run.ownerIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(plan.summaryRun.ownerIndex).toBe(plan.summaryOwnerIndex);
    expect(plan.summaryRun.commandIds.finish).not.toBe(plan.activeRuns[0]?.commandIds.finish);
  });

  it('derives the expected observers of a run from the planned live shares, excluding its owner', () => {
    const dataset: DatasetPlan = planDataset(ordinaryProfile, 42, asOf);
    const plan = planLoadScenario(dataset, workloadFor(ordinaryProfile));
    for (const run of plan.activeRuns) {
      const expected = expectedObserversOf(plan, run.ownerIndex);
      const fromShares = dataset.shares
        .filter((share) => share.ownerIndex === run.ownerIndex && share.canReadLive)
        .map((share) => share.granteeIndex)
        .sort((a, b) => a - b);
      expect(expected).toEqual(fromShares);
      expect(expected).not.toContain(run.ownerIndex);
    }
    // Both coaches see every runner.
    expect(expectedObserversOf(plan, 0)).toEqual(expect.arrayContaining([8, 9]));
  });
});

describe('catch-up batches', () => {
  const plan = scenario();
  const run = plan.activeRuns[3];
  if (!run) {
    throw new Error('missing run');
  }

  it('are exactly 100 contiguous, canonical, contract-valid points recorded before upload time', () => {
    for (const round of [0, 1, plan.workload.catchupRounds - 1]) {
      const batch = buildCatchupBatch(plan, run, startedAtMs, round);
      expect(batch.points).toHaveLength(100);
      const parsed = ingestPointsRequestSchema.parse(batch);
      expect(parsed.points.map((point) => point.seq)).toEqual(
        Array.from({ length: 100 }, (_, offset) => String(round * 100 + offset + 1)),
      );
      const recordedAt = batch.points.map((point) => Date.parse(point.recordedAt));
      expect(recordedAt[0]).toBe(startedAtMs + round * 100 * 2_000);
      expect(Math.max(...recordedAt)).toBeLessThan(startedAtMs + plan.spanMs(plan.workload.catchupRounds));
      expect(new Set(batch.points.map((point) => point.segmentId))).toEqual(new Set([0]));
    }
  });

  it('are identical when built again, which is what makes a retry an exact duplicate', () => {
    expect(buildCatchupBatch(plan, run, startedAtMs, 2)).toEqual(buildCatchupBatch(plan, run, startedAtMs, 2));
    expect(buildCatchupBatch(plan, run, startedAtMs, 2)).not.toEqual(buildCatchupBatch(plan, run, startedAtMs, 1));
  });

  it('follow a plausible running path with valid coordinates for every geography, antimeridian included', () => {
    for (const candidate of plan.activeRuns) {
      const points = [
        ...buildCatchupBatch(plan, candidate, startedAtMs, 0).points,
        ...buildCatchupBatch(plan, candidate, startedAtMs, 1).points,
      ];
      for (const point of points) {
        expect(Math.abs(point.longitude)).toBeLessThanOrEqual(180);
        expect(Math.abs(point.latitude)).toBeLessThanOrEqual(90);
      }
      for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const current = points[index];
        if (!previous || !current) {
          throw new Error('missing point');
        }
        const stepM = haversineMeters(previous, current);
        expect(stepM).toBeGreaterThan(0);
        expect(stepM).toBeLessThan(15);
      }
    }
    const antimeridian = plan.activeRuns.find((candidate) => candidate.regionName === 'taveuni-antimeridian');
    expect(antimeridian).toBeDefined();
    if (!antimeridian) {
      return;
    }
    const longitudes = buildCatchupBatch(plan, antimeridian, startedAtMs, 0).points.map((point) => point.longitude);
    expect(longitudes.every((longitude) => Math.abs(longitude) > 179.99)).toBe(true);
  });

  it('build fresh points as a continuation of the same path at the recorded instant', () => {
    const rounds = plan.workload.catchupRounds;
    const lastCatchup = buildCatchupBatch(plan, run, startedAtMs, rounds - 1).points.at(-1);
    const freshSeq = rounds * 100 + 1;
    const fresh = buildFreshPoint(plan, run, startedAtMs, freshSeq, startedAtMs + 5_000_000);
    expect(fresh.seq).toBe(String(freshSeq));
    expect(fresh.recordedAt).toBe(new Date(startedAtMs + 5_000_000).toISOString());
    expect(Date.parse(fresh.recordedAt)).toBeGreaterThan(Date.parse(lastCatchup?.recordedAt ?? ''));
    expect(buildFreshPoint(plan, run, startedAtMs, freshSeq, startedAtMs + 5_000_000)).toEqual(fresh);
  });
});

describe('lonLatToTile', () => {
  it('matches known slippy-map tiles', () => {
    expect(lonLatToTile(0, 0, 1)).toEqual({ x: 1, y: 1 });
    expect(lonLatToTile(-74.006, 40.713, 10)).toEqual({ x: 301, y: 385 });
  });
});

describe('planTileBurst', () => {
  const plan = scenario();

  it('only produces tiles the API accepts and is reproducible', () => {
    for (let burst = 0; burst < 20; burst += 1) {
      const planned = planTileBurst(plan, burst);
      expect(planTileBurst(plan, burst)).toEqual(planned);
      expect(planned.requests.length).toBeGreaterThan(0);
      for (const tile of planned.requests) {
        const parsed = tilePathSchema.safeParse({
          orgId: plan.organizationId,
          x: String(tile.x),
          y: String(tile.y),
          z: String(tile.z),
        });
        expect(parsed.success).toBe(true);
      }
      expect(planned.viewerIndex).toBeGreaterThanOrEqual(0);
      expect(planned.viewerIndex).toBeLessThan(plan.observerCount);
    }
  });

  it('pans and zooms across several levels and revisits tiles so a warm cache is exercised', () => {
    const planned = planTileBurst(plan, 2);
    const zooms = new Set(planned.requests.map((tile) => tile.z));
    expect(zooms.size).toBeGreaterThanOrEqual(3);
    const keys = planned.requests.map((tile) => `${tile.z}/${tile.x}/${tile.y}`);
    expect(new Set(keys).size).toBeLessThan(keys.length);
    expect(new Set(keys).size).toBeGreaterThan(keys.length / 3);
  });

  it('starts with the antimeridian region and wraps its viewport across the seam', () => {
    const planned = planTileBurst(plan, 0);
    expect(planned.regionName).toBe('taveuni-antimeridian');
    const maxZoom = Math.max(...planned.requests.map((tile) => tile.z));
    const highZoom = planned.requests.filter((tile) => tile.z === maxZoom);
    const columns = new Set(highZoom.map((tile) => tile.x));
    expect(columns.has(0)).toBe(true);
    expect(columns.has(2 ** maxZoom - 1)).toBe(true);
  });

  it('pairs consecutive bursts on one region and viewer with shifted, overlapping viewports', () => {
    const first = planTileBurst(plan, 4);
    const second = planTileBurst(plan, 5);
    expect(second.regionName).toBe(first.regionName);
    expect(second.viewerIndex).toBe(first.viewerIndex);
    const firstKeys = new Set(first.requests.map((tile) => `${tile.z}/${tile.x}/${tile.y}`));
    const shared = second.requests.filter((tile) => firstKeys.has(`${tile.z}/${tile.x}/${tile.y}`));
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.length).toBeLessThan(second.requests.length);
  });

  it('visits every geography over enough bursts', () => {
    const regions = new Set(Array.from({ length: 16 }, (_, burst) => planTileBurst(plan, burst).regionName));
    expect(regions.size).toBe(8);
  });
});

import type { IngestPointsRequest, PointInput } from '@running-tracker/contracts';

import {
  anchorForUser,
  deterministicUuid,
  geographyAnchors,
  hash01,
  metersPerDegree,
  pointIntervalMs,
  type DatasetPlan,
  type PlannedShare,
  type PlannedUser,
} from './dataset-plan.js';

/** Everything the load scenario needs to choose that is not part of the dataset. */
export interface WorkloadProfile {
  readonly name: string;
  /** Rounds of one 100-point batch per member, all members concurrently. */
  readonly catchupRounds: number;
  readonly catchupBatchSize: number;
  /** 100-point batches ingested into the summary run before it is finished. */
  readonly summaryRunBatches: number;
  /** One fresh point per active run every interval. */
  readonly freshIntervalMs: number;
  /** The fresh phase lasts at least this long, and until the summary is visible, up to the cap. */
  readonly freshMinDurationMs: number;
  readonly freshMaxDurationMs: number;
  /** Concurrent tile requests per burst stream; two streams overlap by design. */
  readonly tileConcurrencyPerStream: number;
  /** Overlapping tile-burst streams; 0 sends no tile bursts, for a baseline without tile load. */
  readonly tileStreams: number;
  readonly tileThinkMs: number;
  readonly pollIntervalMs: number;
  readonly requestTimeoutMs: number;
  readonly metricsSnapshotIntervalMs: number;
  /** How often the runner asks the database which backends are waiting for a lock. */
  readonly lockSampleIntervalMs: number;
}

const baseWorkload = {
  catchupBatchSize: 100,
  freshIntervalMs: 2_000,
  freshMaxDurationMs: 300_000,
  lockSampleIntervalMs: 250,
  metricsSnapshotIntervalMs: 15_000,
  pollIntervalMs: 1_000,
  requestTimeoutMs: 30_000,
  tileConcurrencyPerStream: 3,
  tileStreams: 2,
  tileThinkMs: 250,
} as const;

/** Intentionally small; used by automated tests, never as a performance reference. */
const smokeWorkload: WorkloadProfile = {
  ...baseWorkload,
  catchupRounds: 2,
  freshIntervalMs: 1_000,
  freshMaxDurationMs: 90_000,
  freshMinDurationMs: 4_000,
  metricsSnapshotIntervalMs: 5_000,
  name: 'smoke',
  pollIntervalMs: 500,
  summaryRunBatches: 1,
  tileConcurrencyPerStream: 2,
  tileThinkMs: 50,
};

const ordinaryWorkload: WorkloadProfile = {
  ...baseWorkload,
  catchupRounds: 3,
  freshMinDurationMs: 30_000,
  name: 'ordinary',
  summaryRunBatches: 3,
};

const stressWorkload: WorkloadProfile = {
  ...baseWorkload,
  catchupRounds: 10,
  freshMinDurationMs: 60_000,
  name: 'stress',
  summaryRunBatches: 10,
};

export const workloadProfiles: Readonly<Record<string, WorkloadProfile>> = {
  ordinary: ordinaryWorkload,
  smoke: smokeWorkload,
  stress: stressWorkload,
};

const overlapRetryFreshPoints = 50;
const uploadMarginMs = 10_000;
const fullCircle = 2 * Math.PI;

export interface LoadRunPlan {
  readonly catchupBatches: number;
  readonly centerLatitude: number;
  readonly centerLongitude: number;
  readonly commandIds: { readonly finish: string };
  readonly kind: 'active' | 'summary';
  readonly ownerIndex: number;
  readonly phase: number;
  readonly radiusM: number;
  readonly regionName: string;
  readonly runId: string;
  readonly speedMps: number;
  readonly userId: string;
}

export interface LoadScenarioPlan {
  readonly activeRuns: readonly LoadRunPlan[];
  readonly asOf: string;
  readonly observerCount: number;
  readonly organizationId: string;
  readonly profileName: string;
  readonly seed: number;
  readonly shares: readonly PlannedShare[];
  /** How long before the upload instant a run with `rounds` batches (plus the overlap retry) must start. */
  readonly spanMs: (rounds: number) => number;
  readonly summaryOwnerIndex: number;
  readonly summaryRun: LoadRunPlan;
  readonly users: readonly PlannedUser[];
  readonly workload: WorkloadProfile;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function planRun(
  dataset: DatasetPlan,
  user: PlannedUser,
  kind: 'active' | 'summary',
  ordinal: number,
  catchupBatches: number,
): LoadRunPlan {
  const anchor = anchorForUser(user.index);
  return {
    catchupBatches,
    centerLatitude: anchor.latitude,
    centerLongitude: anchor.longitude,
    commandIds: { finish: deterministicUuid(dataset.seed, 'load-command', ordinal) },
    kind,
    ownerIndex: user.index,
    phase: roundTo(hash01(dataset.seed, 'load-phase', ordinal) * fullCircle, 6),
    radiusM: 350 + 30 * user.index,
    regionName: anchor.name,
    runId: deterministicUuid(dataset.seed, 'load-run', ordinal),
    speedMps: roundTo(2.6 + 0.1 * user.index, 2),
    userId: user.id,
  };
}

/**
 * Plans the scenario from the dataset plan alone: identifiers, geometry parameters, and which members may
 * watch which run. All of it is a pure function of the seed, so a rerun reproduces it exactly.
 */
export function planLoadScenario(dataset: DatasetPlan, workload: WorkloadProfile): LoadScenarioPlan {
  const activeRuns = dataset.users.map((user) =>
    planRun(dataset, user, 'active', user.index, workload.catchupRounds),
  );
  const summaryOwner = dataset.users[0];
  if (!summaryOwner) {
    throw new Error('The dataset has no members');
  }
  const summaryRun = planRun(dataset, summaryOwner, 'summary', dataset.users.length, workload.summaryRunBatches);
  return {
    activeRuns,
    asOf: dataset.asOf,
    observerCount: dataset.users.length,
    organizationId: dataset.organizationId,
    profileName: dataset.profile.name,
    seed: dataset.seed,
    shares: dataset.shares,
    spanMs: (rounds) =>
      (rounds * workload.catchupBatchSize + overlapRetryFreshPoints) * pointIntervalMs + uploadMarginMs,
    summaryOwnerIndex: summaryOwner.index,
    summaryRun,
    users: dataset.users,
    workload,
  };
}

/** Members other than the owner who hold a live grant on the owner's runs, ascending. */
export function expectedObserversOf(plan: LoadScenarioPlan, ownerIndex: number): number[] {
  return plan.shares
    .filter((share) => share.ownerIndex === ownerIndex && share.canReadLive)
    .map((share) => share.granteeIndex)
    .sort((left, right) => left - right);
}

function wrapLongitude(longitude: number): number {
  return longitude - 360 * Math.floor((longitude + 180) / 360);
}

/** A point on a circular route as a pure function of the run and the time since it started. */
function pointOnRoute(
  run: LoadRunPlan,
  startedAtMs: number,
  seq: number,
  recordedAtMs: number,
): PointInput {
  const elapsedS = (recordedAtMs - startedAtMs) / 1_000;
  const angle = run.phase + (run.speedMps * elapsedS) / run.radiusM;
  const latitude = run.centerLatitude + (run.radiusM * Math.sin(angle)) / metersPerDegree;
  const longitude =
    run.centerLongitude +
    (run.radiusM * Math.cos(angle)) / (metersPerDegree * Math.cos((run.centerLatitude * Math.PI) / 180));
  return {
    accuracyM: 4 + (seq % 5) * 0.5,
    latitude: roundTo(latitude, 6),
    longitude: roundTo(wrapLongitude(longitude), 6),
    recordedAt: new Date(recordedAtMs).toISOString(),
    segmentId: 0,
    seq: String(seq),
  };
}

/** Offline catch-up points: recorded on the device's two-second grid starting at the run's start. */
export function buildCatchupRange(
  run: LoadRunPlan,
  startedAtMs: number,
  firstSeq: number,
  count: number,
): IngestPointsRequest {
  return {
    points: Array.from({ length: count }, (_, offset) => {
      const seq = firstSeq + offset;
      return pointOnRoute(run, startedAtMs, seq, startedAtMs + (seq - 1) * pointIntervalMs);
    }),
  };
}

export function buildCatchupBatch(
  plan: LoadScenarioPlan,
  run: LoadRunPlan,
  startedAtMs: number,
  round: number,
): IngestPointsRequest {
  return buildCatchupRange(
    run,
    startedAtMs,
    round * plan.workload.catchupBatchSize + 1,
    plan.workload.catchupBatchSize,
  );
}

/** A live measurement: same route and numbering, recorded at the actual instant it is created. */
export function buildFreshPoint(
  _plan: LoadScenarioPlan,
  run: LoadRunPlan,
  startedAtMs: number,
  seq: number,
  recordedAtMs: number,
): PointInput {
  return pointOnRoute(run, startedAtMs, seq, recordedAtMs);
}

export interface TileCoordinate {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface TileBurstPlan {
  readonly burst: number;
  readonly regionName: string;
  readonly requests: readonly TileCoordinate[];
  readonly viewerIndex: number;
}

/** Web-Mercator XYZ tile of a WGS84 position; the antimeridian maps to column `2^z`, which callers wrap. */
export function lonLatToTile(longitude: number, latitude: number, zoom: number): { x: number; y: number } {
  const count = 2 ** zoom;
  const latitudeRadians = (latitude * Math.PI) / 180;
  const x = Math.floor(((longitude + 180) / 360) * count);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) / Math.PI) / 2) * count,
  );
  return { x, y };
}

/** Starts on the antimeridian route, then visits the other seven regions. */
const regionOrder = [4, 0, 1, 2, 3, 5, 6, 7] as const;
/** A pan/zoom gesture: zoom in, pan east and back, zoom out; `dx` is the pan in tiles at that zoom. */
const gesture = [
  { dx: 0, z: 9 },
  { dx: 0, z: 11 },
  { dx: 0, z: 13 },
  { dx: 1, z: 13 },
  { dx: 2, z: 13 },
  { dx: 1, z: 13 },
  { dx: 0, z: 13 },
  { dx: 0, z: 11 },
] as const;

/**
 * One viewer's pan/zoom burst as an ordered list of 3x3 viewports. Bursts come in pairs (even and odd) that
 * share a region and a viewer, the odd one shifted one tile east, so concurrent streams overlap. Later
 * cycles through the regions move the centre, so they also produce tiles that were never requested before.
 */
export function planTileBurst(plan: LoadScenarioPlan, burst: number): TileBurstPlan {
  const pair = Math.floor(burst / 2);
  const shift = burst % 2;
  const cycle = Math.floor(pair / regionOrder.length);
  const anchorIndex = regionOrder[pair % regionOrder.length] ?? 0;
  const anchor = geographyAnchors[anchorIndex];
  if (!anchor) {
    throw new Error('Geography anchor table is empty');
  }
  const jitter = (channel: string): number =>
    cycle === 0 ? 0 : (hash01(plan.seed, 'tile-cycle', channel, anchor.name, cycle) * 2 - 1) * anchor.spreadDegrees;
  const longitude = anchor.longitude + jitter('lon');
  const latitude = anchor.latitude + jitter('lat');

  const requests: TileCoordinate[] = [];
  for (const step of gesture) {
    const count = 2 ** step.z;
    const center = lonLatToTile(longitude, latitude, step.z);
    for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
      const y = Math.min(count - 1, Math.max(0, center.y + rowOffset));
      for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
        const column = center.x + step.dx + shift + columnOffset;
        requests.push({ x: ((column % count) + count) % count, y, z: step.z });
      }
    }
  }
  return { burst, regionName: anchor.name, requests, viewerIndex: pair % plan.observerCount };
}

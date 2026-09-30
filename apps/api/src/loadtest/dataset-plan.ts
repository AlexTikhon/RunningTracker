import { createHash } from 'node:crypto';

/** One GPS sample every two seconds, as in the SDD load estimate. */
export const pointIntervalMs = 2_000;
/** The ingestion batch size used to derive `ingested_revision` and `data_revision`. */
export const ingestionBatchSize = 100;

const dayMs = 24 * 60 * 60 * 1_000;
const maximumStartJitterMs = 6 * 60 * 60 * 1_000;
const minimumFinishMarginMs = 5 * 60 * 1_000;
const maximumPointsPerRun = 50_000;
const metersPerDegree = 111_320;

export interface DatasetProfile {
  readonly name: string;
  /** Members of the single organization; every member records runs (SDD: at most 10). */
  readonly users: number;
  /** The last `coaches` members carry the coach role; all others are runners. */
  readonly coaches: number;
  /** One finished run per user per day; day 0 is the most recent. */
  readonly archiveDays: number;
  /** Runs on days `< rawDays` still hold raw points; older runs keep only their summary. */
  readonly rawDays: number;
  /** Total raw points, spread as evenly as possible over the raw runs. */
  readonly rawPointBudget: number;
  /** Nominal point count of a run whose raw points were purged. */
  readonly archivedRunPoints: number;
  /** Inclusive [min, max] average speed in metres per second. */
  readonly speedMps: readonly [number, number];
}

/** SDD section 2 and 14: 126,000 raw points (one hour a day for a week) and 3,650 archived runs. */
export const ordinaryProfile: DatasetProfile = {
  archiveDays: 365,
  archivedRunPoints: 1_800,
  coaches: 2,
  name: 'ordinary',
  rawDays: 7,
  rawPointBudget: 126_000,
  speedMps: [2.4, 3.6],
  users: 10,
};

/**
 * SDD section 14: 3,000,000 raw points, about one week of continuous recording. The speed is low so the
 * synthetic route stays a city-scale loop; the volume, not the realism of the pace, is the point.
 */
export const stressProfile: DatasetProfile = {
  archiveDays: 365,
  archivedRunPoints: 1_800,
  coaches: 2,
  name: 'stress',
  rawDays: 7,
  rawPointBudget: 3_000_000,
  speedMps: [0.4, 0.8],
  users: 10,
};

/** A few seconds of data for smoke runs and integration tests; five users reach the antimeridian anchor. */
export const smokeProfile: DatasetProfile = {
  archiveDays: 6,
  archivedRunPoints: 60,
  coaches: 1,
  name: 'smoke',
  rawDays: 2,
  rawPointBudget: 500,
  speedMps: [2.4, 3.6],
  users: 5,
};

export const namedProfiles: Readonly<Record<string, DatasetProfile>> = {
  ordinary: ordinaryProfile,
  smoke: smokeProfile,
  stress: stressProfile,
};

export interface GeographyAnchor {
  readonly name: string;
  readonly longitude: number;
  readonly latitude: number;
  /** Half-width in degrees of the per-run centre offset. */
  readonly spreadDegrees: number;
}

/**
 * Users are assigned round-robin. The set covers both hemispheres, the equator, a high latitude, and a route
 * that straddles the antimeridian on every run, because the display geometry and MVT paths treat those cases
 * specially.
 */
export const geographyAnchors: readonly GeographyAnchor[] = [
  { latitude: 38.722, longitude: -9.139, name: 'lisbon', spreadDegrees: 0.03 },
  { latitude: 40.713, longitude: -74.006, name: 'new-york', spreadDegrees: 0.03 },
  { latitude: 35.69, longitude: 139.692, name: 'tokyo', spreadDegrees: 0.03 },
  { latitude: -33.869, longitude: 151.209, name: 'sydney', spreadDegrees: 0.03 },
  { latitude: -16.85, longitude: 180, name: 'taveuni-antimeridian', spreadDegrees: 0.001 },
  { latitude: 64.147, longitude: -21.94, name: 'reykjavik', spreadDegrees: 0.03 },
  { latitude: -1.286, longitude: 36.82, name: 'nairobi', spreadDegrees: 0.03 },
  { latitude: -34.604, longitude: -58.382, name: 'buenos-aires', spreadDegrees: 0.03 },
];

export function anchorForUser(userIndex: number): GeographyAnchor {
  const anchor = geographyAnchors[userIndex % geographyAnchors.length];
  if (!anchor) {
    throw new Error('Geography anchor table is empty');
  }
  return anchor;
}

/** Deterministic value in [0, 1) derived from the seed and a key path; independent of call order. */
export function hash01(seed: number, ...key: readonly (number | string)[]): number {
  const digest = createHash('sha256').update(`${seed}:${key.join(':')}`).digest();
  return digest.readUInt32BE(0) / 4_294_967_296;
}

/** RFC 4122 version-4-shaped UUID derived from the seed, so every contract UUID check accepts it. */
export function deterministicUuid(seed: number, kind: string, index: number): string {
  const bytes = createHash('sha256').update(`${seed}:uuid:${kind}:${index}`).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function validateProfile(profile: DatasetProfile): void {
  const integers: readonly [string, number, number, number][] = [
    ['users', profile.users, 1, 10],
    ['coaches', profile.coaches, 0, profile.users - 1],
    ['archiveDays', profile.archiveDays, 1, 365],
    ['rawDays', profile.rawDays, 0, profile.archiveDays],
    ['archivedRunPoints', profile.archivedRunPoints, 2, maximumPointsPerRun],
    ['rawPointBudget', profile.rawPointBudget, 0, Number.MAX_SAFE_INTEGER],
  ];
  for (const [field, value, minimum, maximum] of integers) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`Profile ${profile.name}: ${field} must be an integer in [${minimum}, ${maximum}]`);
    }
  }
  const [slow, fast] = profile.speedMps;
  if (!Number.isFinite(slow) || !Number.isFinite(fast) || slow <= 0 || fast < slow) {
    throw new Error(`Profile ${profile.name}: speedMps must be a positive ascending range`);
  }

  const rawRuns = profile.users * profile.rawDays;
  if (rawRuns === 0 ? profile.rawPointBudget !== 0 : profile.rawPointBudget < rawRuns * 2) {
    throw new Error(`Profile ${profile.name}: rawPointBudget must give every raw run at least two points`);
  }
  const longestRun = Math.max(
    profile.archivedRunPoints,
    rawRuns === 0 ? 0 : Math.ceil(profile.rawPointBudget / rawRuns),
  );
  if (longestRun > maximumPointsPerRun) {
    throw new Error(`Profile ${profile.name}: a run would exceed the ${maximumPointsPerRun} point safety limit`);
  }
  if ((longestRun - 1) * pointIntervalMs + minimumFinishMarginMs >= dayMs) {
    throw new Error(`Profile ${profile.name}: a run would not fit inside a 24-hour slot`);
  }
}

export interface PlannedRun {
  readonly index: number;
  readonly userIndex: number;
  readonly dayIndex: number;
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly pointCount: number;
  readonly hasRaw: boolean;
  readonly dataRevision: number;
  readonly centerLongitude: number;
  readonly centerLatitude: number;
  readonly radiusM: number;
  readonly laps: number;
  readonly phase: number;
  readonly distanceM: number;
  readonly durationS: number;
  readonly vertexCount: number;
  readonly poorAccuracyPointCount: number;
  readonly excessiveSpeedCount: number;
}

export interface PlannedUser {
  readonly index: number;
  readonly id: string;
  readonly externalIdentity: string;
  readonly role: 'coach' | 'runner';
}

export interface PlannedShare {
  readonly ownerIndex: number;
  readonly granteeIndex: number;
  readonly canReadHistory: boolean;
  readonly canReadLive: boolean;
}

export interface DatasetPlan {
  readonly profile: DatasetProfile;
  readonly seed: number;
  readonly asOf: string;
  readonly organizationId: string;
  readonly users: readonly PlannedUser[];
  readonly runs: readonly PlannedRun[];
  readonly shares: readonly PlannedShare[];
}

export interface ExpectedTotals {
  readonly users: number;
  readonly runs: number;
  readonly rawRuns: number;
  readonly rawPoints: number;
  readonly summaries: number;
  readonly runShares: number;
}

/**
 * Standing sharing policy between two distinct users, applied to every run of the owner. A coach receives
 * both grants from every runner. Otherwise the class is drawn per ordered pair: 40% none, 20% history only,
 * 10% live only, 30% both, which covers every ACL combination.
 */
export function classifyShare(
  seed: number,
  ownerIndex: number,
  granteeIndex: number,
  users: readonly PlannedUser[],
): Pick<PlannedShare, 'canReadHistory' | 'canReadLive'> {
  const owner = users[ownerIndex];
  const grantee = users[granteeIndex];
  if (grantee?.role === 'coach' && owner?.role === 'runner') {
    return { canReadHistory: true, canReadLive: true };
  }
  const draw = hash01(seed, 'share', ownerIndex, granteeIndex);
  if (draw < 0.4) {
    return { canReadHistory: false, canReadLive: false };
  }
  if (draw < 0.6) {
    return { canReadHistory: true, canReadLive: false };
  }
  if (draw < 0.7) {
    return { canReadHistory: false, canReadLive: true };
  }
  return { canReadHistory: true, canReadLive: true };
}

export function planUsers(profile: DatasetProfile, seed: number): PlannedUser[] {
  return Array.from({ length: profile.users }, (_, index) => ({
    externalIdentity: `load-dataset:${seed}:user:${index}`,
    id: deterministicUuid(seed, 'user', index),
    index,
    role: index >= profile.users - profile.coaches ? 'coach' : 'runner',
  }));
}

export function planShares(seed: number, users: readonly PlannedUser[]): PlannedShare[] {
  const shares: PlannedShare[] = [];
  for (const owner of users) {
    for (const grantee of users) {
      if (owner.index === grantee.index) {
        continue;
      }
      const grant = classifyShare(seed, owner.index, grantee.index, users);
      if (grant.canReadHistory || grant.canReadLive) {
        shares.push({ ...grant, granteeIndex: grantee.index, ownerIndex: owner.index });
      }
    }
  }
  return shares;
}

export function expectedTotals(profile: DatasetProfile, seed: number): ExpectedTotals {
  validateProfile(profile);
  const users = planUsers(profile, seed);
  return {
    rawPoints: profile.rawPointBudget,
    rawRuns: profile.users * profile.rawDays,
    runShares: planShares(seed, users).length * profile.archiveDays,
    runs: profile.users * profile.archiveDays,
    summaries: profile.users * profile.archiveDays,
    users: profile.users,
  };
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Pure, order-independent plan; the same profile, seed, and instant always give the same rows. */
export function planDataset(profile: DatasetProfile, seed: number, asOf: Date): DatasetPlan {
  validateProfile(profile);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error('Seed must be an unsigned 32-bit integer');
  }
  if (Number.isNaN(asOf.getTime())) {
    throw new Error('asOf must be a valid instant');
  }

  const users = planUsers(profile, seed);
  const rawRuns = profile.users * profile.rawDays;
  const basePoints = rawRuns === 0 ? 0 : Math.floor(profile.rawPointBudget / rawRuns);
  const extraPoints = rawRuns === 0 ? 0 : profile.rawPointBudget % rawRuns;
  const runs: PlannedRun[] = [];
  let rawOrdinal = 0;

  for (const user of users) {
    const anchor = anchorForUser(user.index);
    for (let dayIndex = 0; dayIndex < profile.archiveDays; dayIndex += 1) {
      const index = user.index * profile.archiveDays + dayIndex;
      const hasRaw = dayIndex < profile.rawDays;
      const pointCount = hasRaw
        ? basePoints + (rawOrdinal < extraPoints ? 1 : 0)
        : profile.archivedRunPoints;
      if (hasRaw) {
        rawOrdinal += 1;
      }

      const durationMs = (pointCount - 1) * pointIntervalMs;
      const jitterLimit = Math.min(maximumStartJitterMs, dayMs - durationMs - minimumFinishMarginMs);
      const startedAtMs =
        asOf.getTime() - (dayIndex + 1) * dayMs + Math.floor(hash01(seed, 'start', index) * jitterLimit);
      const speed =
        profile.speedMps[0] + hash01(seed, 'speed', index) * (profile.speedMps[1] - profile.speedMps[0]);
      const radiusM = roundTo(300 + 600 * hash01(seed, 'radius', index), 1);
      const durationS = durationMs / 1_000;
      const distanceM = roundTo(speed * durationS, 1);
      const laps = distanceM / (2 * Math.PI * radiusM);
      const batches = Math.ceil(pointCount / ingestionBatchSize);

      runs.push({
        centerLatitude: roundTo(
          anchor.latitude + (hash01(seed, 'lat', index) * 2 - 1) * anchor.spreadDegrees,
          6,
        ),
        centerLongitude: roundTo(
          anchor.longitude + (hash01(seed, 'lon', index) * 2 - 1) * anchor.spreadDegrees,
          6,
        ),
        dataRevision: batches + 1,
        dayIndex,
        distanceM,
        durationS,
        excessiveSpeedCount: Math.floor(hash01(seed, 'speeding', index) * 3),
        finishedAt: new Date(startedAtMs + durationMs).toISOString(),
        hasRaw,
        id: deterministicUuid(seed, 'run', index),
        index,
        laps,
        phase: roundTo(hash01(seed, 'phase', index) * 2 * Math.PI, 6),
        pointCount,
        poorAccuracyPointCount: Math.floor(pointCount * 0.03 * hash01(seed, 'poor', index)),
        radiusM,
        startedAt: new Date(startedAtMs).toISOString(),
        userIndex: user.index,
        vertexCount: Math.min(600, Math.max(48, Math.round(laps * 24))),
      });
    }
  }

  return {
    asOf: asOf.toISOString(),
    organizationId: deterministicUuid(seed, 'organization', 0),
    profile,
    runs,
    seed,
    shares: planShares(seed, users),
    users,
  };
}

export { metersPerDegree };

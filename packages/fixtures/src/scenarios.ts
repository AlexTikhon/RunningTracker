import { pointInputSchema, type PointInput } from '@running-tracker/contracts';

export const GPS_SCENARIO_NAMES = [
  'normal',
  'duplicates',
  'reordered',
  'delayed-batch',
  'dropped-response',
  'clock-jump',
  'gps-spike',
] as const;

export type GpsScenarioName = (typeof GPS_SCENARIO_NAMES)[number];
export type UploadResponse = 'delivered' | 'drop-after-commit';

export interface ScheduledCapture {
  readonly atMs: number;
  readonly point: Readonly<PointInput>;
}

export interface ScheduledUploadAttempt {
  readonly atMs: number;
  readonly attempt: number;
  readonly batchId: string;
  readonly points: readonly Readonly<PointInput>[];
  readonly response: UploadResponse;
}

export interface GpsScenario {
  readonly captures: readonly ScheduledCapture[];
  readonly name: GpsScenarioName;
  readonly seed: number;
  readonly startAt: string;
  readonly uploads: readonly ScheduledUploadAttempt[];
}

export interface CreateGpsScenarioOptions {
  readonly name: GpsScenarioName;
  readonly seed: number;
  readonly startAt?: string | Date;
}

const DEFAULT_START_AT = '2026-01-01T08:00:00.000Z';
const UINT32_MAX = 0xffff_ffff;
const POINT_INTERVAL_MS = 2_000;

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function normalizeSeed(seed: number): number {
  if (!Number.isInteger(seed) || seed < 0 || seed > UINT32_MAX) {
    throw new RangeError(`seed must be an integer between 0 and ${UINT32_MAX}`);
  }
  return seed;
}

function normalizeStartAt(startAt: string | Date | undefined): string {
  const input = startAt ?? DEFAULT_START_AT;
  const milliseconds = input instanceof Date ? input.getTime() : Date.parse(input);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError('startAt must be a valid timestamp');
  }
  return new Date(milliseconds).toISOString();
}

function roundedCoordinate(value: number): number {
  return Math.round(value * 10_000_000) / 10_000_000;
}

function createPoints(
  name: GpsScenarioName,
  seed: number,
  startAt: string,
): readonly Readonly<PointInput>[] {
  const random = createRandom(seed);
  const startMs = Date.parse(startAt);
  const sequenceStart = name === 'reordered' ? 41 : 1;
  const points: PointInput[] = [];

  for (let index = 0; index < 6; index += 1) {
    const noiseLongitude = (random() - 0.5) * 0.000_006;
    const noiseLatitude = (random() - 0.5) * 0.000_006;
    let longitude = 21.0122 + index * 0.000_09 + noiseLongitude;
    let latitude = 52.2297 + index * 0.000_045 + noiseLatitude;
    if (name === 'gps-spike' && index === 3) {
      longitude += 0.05;
      latitude += 0.05;
    }

    const recordedOffsetMs =
      name === 'clock-jump' && index >= 3
        ? index * POINT_INTERVAL_MS - 30_000
        : index * POINT_INTERVAL_MS;
    const point = pointInputSchema.parse({
      accuracyM: Math.round((3 + random() * 4) * 10) / 10,
      latitude: roundedCoordinate(latitude),
      longitude: roundedCoordinate(longitude),
      recordedAt: new Date(startMs + recordedOffsetMs).toISOString(),
      segmentId: 0,
      seq: String(sequenceStart + index),
    });
    points.push(Object.freeze(point));
  }
  return Object.freeze(points);
}

function batch(
  atMs: number,
  batchId: string,
  points: readonly Readonly<PointInput>[],
  attempt = 1,
  response: UploadResponse = 'delivered',
): ScheduledUploadAttempt {
  return Object.freeze({ atMs, attempt, batchId, points: Object.freeze([...points]), response });
}

function createUploads(
  name: GpsScenarioName,
  points: readonly Readonly<PointInput>[],
): readonly ScheduledUploadAttempt[] {
  const first = points.slice(0, 3);
  const second = points.slice(3);
  let uploads: ScheduledUploadAttempt[];

  switch (name) {
    case 'duplicates':
      uploads = [
        batch(4_500, 'batch-1', first),
        batch(5_500, 'batch-1', first, 2),
        batch(10_500, 'batch-2', second),
      ];
      break;
    case 'reordered':
      uploads = [
        batch(500, 'batch-41', [points[0]!]),
        batch(4_500, 'batch-43', [points[2]!]),
        batch(6_500, 'batch-42', [points[1]!]),
        batch(10_500, 'batch-44-46', points.slice(3)),
      ];
      break;
    case 'delayed-batch':
      uploads = [batch(60_000, 'batch-delayed', points)];
      break;
    case 'dropped-response':
      uploads = [
        batch(4_500, 'batch-1', first, 1, 'drop-after-commit'),
        batch(6_500, 'batch-1', first, 2),
        batch(10_500, 'batch-2', second),
      ];
      break;
    case 'normal':
    case 'clock-jump':
    case 'gps-spike':
      uploads = [batch(4_500, 'batch-1', first), batch(10_500, 'batch-2', second)];
      break;
  }
  return Object.freeze(uploads);
}

export function createGpsScenario(options: CreateGpsScenarioOptions): GpsScenario {
  if (!isGpsScenarioName(options.name)) {
    throw new RangeError(`unknown GPS scenario: ${String(options.name)}`);
  }
  const seed = normalizeSeed(options.seed);
  const startAt = normalizeStartAt(options.startAt);
  const points = createPoints(options.name, seed, startAt);
  const captures = points.map((point, index) =>
    Object.freeze({ atMs: index * POINT_INTERVAL_MS, point }),
  );
  return Object.freeze({
    captures: Object.freeze(captures),
    name: options.name,
    seed,
    startAt,
    uploads: createUploads(options.name, points),
  });
}

export function isGpsScenarioName(value: string): value is GpsScenarioName {
  return (GPS_SCENARIO_NAMES as readonly string[]).includes(value);
}

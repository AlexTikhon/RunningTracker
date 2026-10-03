import { z } from 'zod';

// The committed, sanitized GPS trace fixture (D10). It is deliberately boring and strict: relative time, a local
// metric frame whose origin is the first fix, an optional accuracy, and nothing else. Every object is a strict
// object, so a field such as a latitude, a timestamp or a device identifier is rejected rather than ignored.

export const SCHEMA_VERSION = 1;
export const MAX_POINTS = 10_000;
export const MAX_EXTENT_M = 50_000;
export const MAX_FIXTURE_BYTES = 2 * 1024 * 1024;
export const MAX_ACCURACY_M = 10_000;
export const MAX_REFERENCE_DISTANCE_M = 1_000_000;

export const SCENARIOS = [
  'steady_run',
  'city_run',
  'stop_start',
  'gps_noise',
  'tunnel_or_signal_gap',
  'stationary',
] as const;
export const SOURCES = ['real-device-sanitized', 'synthetic'] as const;

export type Scenario = (typeof SCENARIOS)[number];
export type TraceSource = (typeof SOURCES)[number];

export class TraceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceValidationError';
  }
}

const pointSchema = z.strictObject({
  accuracyM: z.number().min(0).max(MAX_ACCURACY_M).optional(),
  elapsedMs: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  // The extent is checked on the distance from the origin below, not per axis.
  xM: z.number(),
  yM: z.number(),
});

const traceSchema = z.strictObject({
  points: z.array(pointSchema).min(2).max(MAX_POINTS),
  referenceDistanceM: z.number().positive().max(MAX_REFERENCE_DISTANCE_M).optional(),
  scenario: z.enum(SCENARIOS),
  schemaVersion: z.literal(SCHEMA_VERSION),
  source: z.enum(SOURCES),
});

export type SanitizedPoint = z.infer<typeof pointSchema>;
export type SanitizedTrace = z.infer<typeof traceSchema>;

function issuePath(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (text, segment) =>
      typeof segment === 'number' ? `${text}[${segment}]` : text === '' ? String(segment) : `${text}.${String(segment)}`,
    '',
  );
}

function fail(location: string, message: string): never {
  throw new TraceValidationError(`Invalid sanitized GPS trace: ${location === '' ? '' : `${location}: `}${message}`);
}

// Messages carry field names and indices, never values: a fixture under review may be a mistake that contains
// private data, and the message must not repeat it.
export function parseSanitizedTrace(candidate: unknown): SanitizedTrace {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return fail('', 'the document must be a JSON object');
  }
  const version = (candidate as Record<string, unknown>).schemaVersion;
  if (version !== SCHEMA_VERSION) {
    return fail(
      'schemaVersion',
      `unsupported schemaVersion${typeof version === 'number' ? ` ${String(version)}` : ''}; this tool reads version ${String(SCHEMA_VERSION)}`,
    );
  }

  const parsed = traceSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? issuePath(issue.path) : '';
    const message =
      issue?.code === 'unrecognized_keys' ? `unknown field ${issue.keys.join(', ')}` : (issue?.message ?? 'invalid');
    return fail(where, message);
  }

  const trace = parsed.data;
  const first = trace.points[0];
  if (first === undefined || first.elapsedMs !== 0 || first.xM !== 0 || first.yM !== 0) {
    return fail('points[0]', 'the first point must be the origin (elapsedMs 0, xM 0, yM 0)');
  }
  let withAccuracy = 0;
  trace.points.forEach((point, index) => {
    const previous = trace.points[index - 1];
    if (previous !== undefined && point.elapsedMs <= previous.elapsedMs) {
      fail(`points[${String(index)}]`, 'elapsedMs must increase strictly from the previous point');
    }
    if (Math.hypot(point.xM, point.yM) > MAX_EXTENT_M) {
      fail(`points[${String(index)}]`, `the point is farther than the ${String(MAX_EXTENT_M)} m extent limit`);
    }
    if (point.accuracyM !== undefined) {
      withAccuracy += 1;
    }
  });
  if (withAccuracy !== 0 && withAccuracy !== trace.points.length) {
    return fail('points', 'accuracyM must be present on every point or on none');
  }
  return trace;
}

export function parseSanitizedTraceText(text: string): SanitizedTrace {
  if (Buffer.byteLength(text) > MAX_FIXTURE_BYTES) {
    throw new TraceValidationError(`Invalid sanitized GPS trace: the file is larger than ${String(MAX_FIXTURE_BYTES / 1024 / 1024)} MiB`);
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new TraceValidationError('Invalid sanitized GPS trace: the file is not valid JSON');
  }
  return parseSanitizedTrace(document);
}

/** Canonical text of a fixture: fixed key order, one point per line, a trailing newline. */
export function serializeSanitizedTrace(trace: SanitizedTrace): string {
  const lines = trace.points.map((point) => {
    const fields: Record<string, number> = { elapsedMs: point.elapsedMs, xM: point.xM, yM: point.yM };
    if (point.accuracyM !== undefined) {
      fields.accuracyM = point.accuracyM;
    }
    return `    ${JSON.stringify(fields)}`;
  });
  const header = [
    `  "schemaVersion": ${String(trace.schemaVersion)}`,
    `  "scenario": ${JSON.stringify(trace.scenario)}`,
    `  "source": ${JSON.stringify(trace.source)}`,
    ...(trace.referenceDistanceM === undefined
      ? []
      : [`  "referenceDistanceM": ${JSON.stringify(trace.referenceDistanceM)}`]),
  ];
  return `{\n${header.join(',\n')},\n  "points": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

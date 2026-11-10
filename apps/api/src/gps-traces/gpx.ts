import { RawTraceError, validateRawTrace, type RawPoint, type RawTrace } from './raw-trace.js';
import { localName, scanXml } from './xml-scanner.js';

// A strict reader for the part of GPX 1.0/1.1 that a track needs: <trkpt lat lon> with a <time> and, optionally, a
// horizontal accuracy in metres from an extension element. It is intentionally not a general XML parser (the shared
// tokenizer, xml-scanner.ts, refuses DTDs and never expands entities):
//  - DTDs and entity declarations are rejected, so there is nothing to expand;
//  - metadata, names, authors, waypoints, routes, elevation and every other element are skipped, never stored;
//  - HDOP is not accuracy in metres and is ignored rather than converted.
// A file this reader cannot read exactly is an error, not a best effort.

/** A plain decimal number as GPX writes coordinates: no exponent, no NaN or Infinity. */
export const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;
const NUMBER = DECIMAL_NUMBER;
const ACCURACY_ELEMENTS = new Set(['accuracy', 'hacc', 'horizontalaccuracy']);
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u;

/**
 * An ISO 8601 instant with an explicit timezone (`Z` or `±hh:mm`), in whole milliseconds since the epoch, or null. A
 * fraction beyond milliseconds is truncated; years before 1970, impossible dates and leap seconds are refused.
 */
export function parseInstant(text: string): number | null {
  const match = ISO_TIME.exec(text.trim());
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second, fraction, zone] = match as unknown as string[] & {
    readonly length: 9;
  };
  const parts = [year, month, day, hour, minute, second].map(Number) as [number, number, number, number, number, number];
  const [y, mo, d, h, mi, s] = parts;
  const utc = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(utc);
  if (
    y < 1970 ||
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    h > 23 ||
    mi > 59 ||
    s > 59
  ) {
    return null;
  }
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const offsetHours = Number((zone as string).slice(1, 3));
    const offsetRest = Number((zone as string).slice(4, 6));
    if (offsetHours > 23 || offsetRest > 59) {
      return null;
    }
    offsetMinutes = (zone as string).startsWith('-') ? -(offsetHours * 60 + offsetRest) : offsetHours * 60 + offsetRest;
  }
  const milliseconds = Number((fraction ?? '').padEnd(3, '0').slice(0, 3));
  return utc + milliseconds - offsetMinutes * 60_000;
}

interface PendingPoint {
  accuracyText: string | undefined;
  readonly attributes: Record<string, string>;
  readonly index: number;
  timeText: string | undefined;
}

function finishPoint(pending: PendingPoint): RawPoint {
  const name = `trkpt #${String(pending.index)}`;
  const numeric = (attribute: 'lat' | 'lon'): number => {
    const text = pending.attributes[attribute];
    if (text === undefined) {
      throw new RawTraceError(`${name}: missing ${attribute} attribute`);
    }
    if (!NUMBER.test(text.trim())) {
      throw new RawTraceError(`${name}: ${attribute} is not a decimal number`);
    }
    return Number(text);
  };
  const latitude = numeric('lat');
  const longitude = numeric('lon');
  if (pending.timeText === undefined) {
    throw new RawTraceError(`${name}: missing <time>; every point needs an absolute timestamp to derive elapsed time`);
  }
  const timeMs = parseInstant(pending.timeText);
  if (timeMs === null) {
    throw new RawTraceError(`${name}: time is not an ISO 8601 timestamp with a timezone (Z or +hh:mm)`);
  }
  if (pending.accuracyText === undefined) {
    return { latitude, longitude, timeMs };
  }
  if (!NUMBER.test(pending.accuracyText.trim())) {
    throw new RawTraceError(`${name}: accuracy is not a decimal number of metres`);
  }
  return { accuracyM: Number(pending.accuracyText), latitude, longitude, timeMs };
}

export function parseGpx(text: string): RawTrace {
  // The tokenizer keeps the stack and refuses mismatched tags; this stack only mirrors it for parent lookups.
  const stack: string[] = [];
  const points: RawPoint[] = [];
  let segments = 0;
  let pointCount = 0;
  // The casts keep TypeScript from narrowing these to null: the element handlers below assign them.
  let pending = null as PendingPoint | null;
  let collecting = null as { readonly depth: number; readonly kind: 'accuracy' | 'time'; buffer: string } | null;

  const startElement = (qualifiedName: string, rawAttributes: ReadonlyMap<string, string>): void => {
    const name = localName(qualifiedName);
    if (stack.length === 0 && name !== 'gpx') {
      throw new RawTraceError('The file is not a GPX document (the root element is not <gpx>)');
    }
    const parent = stack[stack.length - 1];
    stack.push(qualifiedName);
    if (name === 'trkseg') {
      segments += 1;
    } else if (name === 'trkpt' && parent !== undefined && localName(parent) === 'trkseg') {
      pointCount += 1;
      const attributes: Record<string, string> = {};
      for (const [attributeName, value] of rawAttributes) attributes[localName(attributeName)] = value;
      pending = { accuracyText: undefined, attributes, index: pointCount, timeText: undefined };
    } else if (pending !== null && collecting === null) {
      if (name === 'time' && parent !== undefined && localName(parent) === 'trkpt') {
        collecting = { buffer: '', depth: stack.length, kind: 'time' };
      } else if (
        ACCURACY_ELEMENTS.has(name.toLowerCase()) &&
        pending.accuracyText === undefined &&
        stack.some((ancestor) => localName(ancestor) === 'extensions')
      ) {
        collecting = { buffer: '', depth: stack.length, kind: 'accuracy' };
      }
    }
  };

  const endElement = (qualifiedName: string): void => {
    stack.pop();
    const name = localName(qualifiedName);
    if (collecting !== null && collecting.depth === stack.length + 1 && pending !== null) {
      if (collecting.kind === 'time') {
        pending.timeText = collecting.buffer;
      } else {
        pending.accuracyText = collecting.buffer;
      }
      collecting = null;
    }
    if (name === 'trkpt' && pending !== null) {
      points.push(finishPoint(pending));
      pending = null;
    }
  };

  scanXml(
    text,
    {
      endElement,
      startElement,
      text: (chunk) => {
        if (collecting !== null) collecting.buffer += chunk;
      },
    },
    (_kind, message) => {
      throw new RawTraceError(message);
    },
  );

  if (points.length === 0) {
    throw new RawTraceError('The GPX file has no track points (<trk><trkseg><trkpt>); waypoints and routes are not read');
  }
  if (segments > 1) {
    throw new RawTraceError(
      `The GPX file has ${String(segments)} track segments; the fixture models one continuous recording. Export or split a single segment`,
    );
  }
  validateRawTrace(points, 'trkpt');
  return { points };
}

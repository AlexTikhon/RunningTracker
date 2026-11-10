import { createHash } from 'node:crypto';

import {
  ACTIVITY_DISTANCE_MAX_M,
  ACTIVITY_DURATION_MAX_S,
  ACTIVITY_FUTURE_SKEW_MS,
  ACTIVITY_STARTED_AT_MIN,
  GPX_IMPORT_MAX_BYTES,
  GPX_IMPORT_MAX_EDGE_SPEED_M_S,
  GPX_IMPORT_MAX_POINTS,
  GPX_IMPORT_MAX_SEGMENTS,
  GPX_IMPORT_METRICS_VERSION,
  GPX_NAMESPACE_1_1,
  gpxImportSummarySchema,
  type GpxImportSummary,
  type GpxUnsupportedReason,
} from '@running-tracker/contracts';

import { geodesicDistanceM } from '../gps-traces/geodesy.js';
import { DECIMAL_NUMBER, parseInstant } from '../gps-traces/gpx.js';
import { localName, scanXml } from '../gps-traces/xml-scanner.js';

// The GPX reader of the activity import (ADR-0086). It reads the documented subset (packages/contracts,
// activity-gpx-import.ts) and computes a summary; it never repairs, reorders, filters or truncates. Every message names
// a point by its position and never quotes a coordinate, a time or any other text of the file, so an error can be shown,
// logged or reported without revealing where or when the person was.
//
// It shares the strict tokenizer and the coordinate/instant syntax of the D10 trace tools (gps-traces/gpx.ts) and the
// WGS84 geodesic of gps-traces/geodesy.ts (Vincenty, about a millimetre from PostGIS' spheroidal distance used by the
// GPS run summaries). It does NOT use the GPS run edge filter (ADR-0012); ADR-0086 explains why.

export class GpxImportError extends Error {
  public constructor(
    public readonly reason: GpxUnsupportedReason,
    message: string,
  ) {
    super(message);
    this.name = 'GpxImportError';
  }
}

export interface GpxActivity {
  /**
   * SHA-256 of the canonical track: the segments in order and, for each point, latitude, longitude and time as parsed.
   * Whitespace, number spelling, metadata, names, elevation and extensions do not change it; any point, time or segment
   * boundary does. It identifies "the same track" for duplicate detection and is not reversible into a route.
   */
  fingerprint: Buffer;
  startedAtMs: number;
  summary: GpxImportSummary;
}

const FINGERPRINT_DOMAIN = 'somalane-gpx-track-v1\n';
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const XML_DECLARATION_ENCODING = /^<\?xml\b[^>]*?\bencoding\s*=\s*["']([^"']*)["']/u;
const STARTED_AT_MIN_MS = Date.parse(ACTIVITY_STARTED_AT_MIN);
const GPX_1_0_NAMESPACE = 'http://www.topografix.com/GPX/1/0';

const unsupported = (reason: GpxUnsupportedReason, message: string): never => {
  throw new GpxImportError(reason, message);
};

function decodeUtf8(bytes: Uint8Array): string {
  const hasBom = UTF8_BOM.every((byte, index) => bytes[index] === byte);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(hasBom ? bytes.subarray(3) : bytes);
  } catch {
    return unsupported('not_utf8', 'The file is not UTF-8 text; export the GPX file as UTF-8');
  }
  if (text.includes('\u0000')) {
    unsupported('not_utf8', 'The file contains NUL characters; it is not a UTF-8 GPX document');
  }
  const declared = XML_DECLARATION_ENCODING.exec(text)?.[1];
  if (declared !== undefined && !/^utf-?8$/iu.test(declared.trim())) {
    unsupported('not_utf8', 'The file declares an encoding other than UTF-8; export the GPX file as UTF-8');
  }
  return text;
}

interface PendingPoint {
  readonly latText: string | undefined;
  readonly lonText: string | undefined;
  readonly index: number;
  timeText: string | undefined;
}

interface Position {
  readonly latitude: number;
  readonly longitude: number;
  readonly timeMs: number;
}

/**
 * Reads one GPX file (the bytes exactly as uploaded) and computes its summary. `nowMs` is the server's clock: a start
 * more than 24 hours after it is refused, as for a manual activity (ADR-0072). Throws GpxImportError for every file
 * outside the supported subset.
 */
export function readGpxActivity(bytes: Uint8Array, nowMs: number): GpxActivity {
  if (bytes.byteLength > GPX_IMPORT_MAX_BYTES) {
    // The routes refuse a larger body before it is read; this keeps the function safe on its own.
    throw new RangeError(`A GPX file larger than ${String(GPX_IMPORT_MAX_BYTES)} bytes must not reach the reader`);
  }
  const text = decodeUtf8(bytes);

  const hash = createHash('sha256').update(FINGERPRINT_DOMAIN, 'utf8');
  // Local names of the open elements; `extensionsDepth` > 0 inside an <extensions> subtree, whose content is skipped.
  const stack: string[] = [];
  let extensionsDepth = 0;
  let tracks = 0;
  let segments = 0;
  let pointsTotal = 0;
  let segmentPoints = 0;
  let first: Position | undefined;
  let previous: Position | undefined;
  let distanceM = 0;
  // The casts keep TypeScript from narrowing these to null: the element handlers below assign them.
  let pending = null as PendingPoint | null;
  let collectingTime = null as { buffer: string } | null;

  const pointName = (index: number) => `track point ${String(index)} (segment ${String(segments)})`;

  const finishPoint = (point: PendingPoint): void => {
    const name = pointName(point.index);
    const coordinate = (text: string | undefined, label: 'lat' | 'lon', limit: number): number => {
      if (text === undefined || !DECIMAL_NUMBER.test(text.trim())) {
        return unsupported('coordinates', `${name}: ${label} is missing or is not a decimal number`);
      }
      const value = Number(text);
      if (!Number.isFinite(value) || value < -limit || value > limit) {
        unsupported('coordinates', `${name}: ${label} is outside the range -${String(limit)} to ${String(limit)}`);
      }
      return value;
    };
    const latitude = coordinate(point.latText, 'lat', 90);
    const longitude = coordinate(point.lonText, 'lon', 180);
    if (latitude === 0 && longitude === 0) {
      unsupported('coordinates', `${name}: the position is exactly 0, 0, which receivers report when they have no fix`);
    }
    if (point.timeText === undefined) {
      unsupported('time_missing', `${name}: has no <time>; every point needs a timestamp`);
    }
    const timeMs = parseInstant(point.timeText as string);
    if (timeMs === null) {
      return unsupported('time_invalid', `${name}: the time is not an ISO 8601 timestamp with a zone (Z or +hh:mm)`);
    }
    const current: Position = { latitude, longitude, timeMs };
    if (previous !== undefined && timeMs <= previous.timeMs) {
      unsupported(
        'time_order',
        segmentPoints === 0
          ? `${name}: segment ${String(segments)} starts at or before the end of the previous segment; segments must not overlap`
          : `${name}: the time is not after the previous point; times must strictly increase`,
      );
    }
    if (previous !== undefined && segmentPoints > 0) {
      // Within a segment only: nothing is counted across a segment boundary.
      let edgeM: number;
      try {
        edgeM = geodesicDistanceM(previous, current);
      } catch {
        return unsupported('implausible_speed', `${name}: is implausibly far from the previous point`);
      }
      if (edgeM / ((timeMs - previous.timeMs) / 1_000) > GPX_IMPORT_MAX_EDGE_SPEED_M_S) {
        unsupported(
          'implausible_speed',
          `${name}: is further from the previous point than ${String(GPX_IMPORT_MAX_EDGE_SPEED_M_S)} m/s allows; the recording has a jump`,
        );
      }
      distanceM += edgeM;
    }
    hash.update(`p ${String(latitude)} ${String(longitude)} ${String(timeMs)}\n`, 'utf8');
    first ??= current;
    previous = current;
    segmentPoints += 1;
  };

  const startElement = (qualifiedName: string, attributes: ReadonlyMap<string, string>): void => {
    const name = localName(qualifiedName);
    const parent = stack[stack.length - 1];
    stack.push(name);
    if (parent === undefined) {
      if (name !== 'gpx') unsupported('not_gpx', 'The file is not a GPX document (the root element is not <gpx>)');
      const colon = qualifiedName.lastIndexOf(':');
      const namespace = attributes.get(colon === -1 ? 'xmlns' : `xmlns:${qualifiedName.slice(0, colon)}`);
      if (namespace !== GPX_NAMESPACE_1_1) {
        unsupported(
          'not_gpx_1_1',
          namespace === GPX_1_0_NAMESPACE
            ? 'The file is GPX 1.0; only GPX 1.1 is supported'
            : 'The file does not declare the GPX 1.1 namespace; only GPX 1.1 is supported',
        );
      }
      return;
    }
    if (extensionsDepth > 0 || name === 'extensions') {
      if (name === 'extensions') extensionsDepth += 1;
      return;
    }
    if (name === 'trk') {
      if (stack.length !== 2) unsupported('structure', 'A <trk> element is not a direct child of <gpx>');
      tracks += 1;
      if (tracks > 1) unsupported('track_count', 'The file has more than one track; only one <trk> is supported');
    } else if (name === 'trkseg') {
      if (parent !== 'trk') unsupported('structure', 'A <trkseg> element is not inside <trk>');
      segments += 1;
      if (segments > GPX_IMPORT_MAX_SEGMENTS) {
        unsupported('too_many_segments', `The track has more than ${String(GPX_IMPORT_MAX_SEGMENTS)} segments`);
      }
      segmentPoints = 0;
      hash.update('s\n', 'utf8');
    } else if (name === 'trkpt') {
      if (parent !== 'trkseg') unsupported('structure', 'A <trkpt> element is not inside <trkseg>');
      pointsTotal += 1;
      if (pointsTotal > GPX_IMPORT_MAX_POINTS) {
        unsupported('too_many_points', `The track has more than ${String(GPX_IMPORT_MAX_POINTS)} points`);
      }
      pending = { index: segmentPoints + 1, latText: attributes.get('lat'), lonText: attributes.get('lon'), timeText: undefined };
    } else if (name === 'time' && parent === 'trkpt' && pending !== null) {
      if (pending.timeText !== undefined) unsupported('structure', `${pointName(pending.index)}: has more than one <time>`);
      collectingTime = { buffer: '' };
    }
  };

  const endElement = (qualifiedName: string): void => {
    const name = localName(qualifiedName);
    stack.pop();
    if (name === 'extensions' && extensionsDepth > 0) {
      extensionsDepth -= 1;
      return;
    }
    if (extensionsDepth > 0) return;
    if (name === 'time' && collectingTime !== null && pending !== null) {
      pending.timeText = collectingTime.buffer;
      collectingTime = null;
    } else if (name === 'trkpt' && pending !== null) {
      finishPoint(pending);
      pending = null;
    } else if (name === 'trkseg' && segmentPoints === 0) {
      unsupported('empty_segment', `Segment ${String(segments)} has no track points`);
    }
  };

  scanXml(
    text,
    {
      endElement,
      startElement,
      text: (chunk) => {
        if (collectingTime !== null) collectingTime.buffer += chunk;
      },
    },
    (kind, message) =>
      unsupported(kind === 'declaration' ? 'declaration' : kind === 'not_xml' ? 'not_xml' : 'malformed_xml', message),
  );

  if (tracks === 0) {
    unsupported('track_count', 'The file has no track (<trk>); waypoints and routes are not imported');
  }
  if (first === undefined || previous === undefined || pointsTotal < 2) {
    return unsupported('too_few_points', 'The track needs at least 2 points with a time');
  }
  if (first.timeMs < STARTED_AT_MIN_MS) {
    unsupported('start_before_minimum', 'The track starts before the year 2000');
  }
  if (first.timeMs > nowMs + ACTIVITY_FUTURE_SKEW_MS) {
    unsupported('start_in_future', 'The track starts more than 24 hours after server time');
  }
  // Whole milliseconds, so half a second rounds up exactly.
  const elapsedDurationS = Math.floor((previous.timeMs - first.timeMs + 500) / 1_000);
  if (elapsedDurationS < 1 || elapsedDurationS > ACTIVITY_DURATION_MAX_S) {
    unsupported(
      'duration_out_of_range',
      `The time from the first to the last point must be from 1 second to ${String(ACTIVITY_DURATION_MAX_S / 3_600)} hours`,
    );
  }
  const roundedDistanceM = Math.round(distanceM);
  if (roundedDistanceM > ACTIVITY_DISTANCE_MAX_M) {
    unsupported('distance_out_of_range', `The track is longer than ${String(ACTIVITY_DISTANCE_MAX_M / 1_000)} km`);
  }

  return {
    fingerprint: hash.digest(),
    startedAtMs: first.timeMs,
    summary: gpxImportSummarySchema.parse({
      distanceM: roundedDistanceM,
      elapsedDurationS,
      endedAt: new Date(previous.timeMs).toISOString(),
      metricsVersion: GPX_IMPORT_METRICS_VERSION,
      pointCount: pointsTotal,
      segmentCount: segments,
      startedAt: new Date(first.timeMs).toISOString(),
    }),
  };
}

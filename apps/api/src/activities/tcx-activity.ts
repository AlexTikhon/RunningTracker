import { createHash } from 'node:crypto';

import {
  ACTIVITY_DISTANCE_MAX_M,
  ACTIVITY_DURATION_MAX_S,
  ACTIVITY_FUTURE_SKEW_MS,
  ACTIVITY_STARTED_AT_MIN,
  TCX_IMPORT_MAX_BYTES,
  TCX_IMPORT_MAX_DEPTH,
  TCX_IMPORT_MAX_ELEMENTS,
  TCX_IMPORT_MAX_LAPS,
  TCX_IMPORT_MAX_TEXT_LENGTH,
  TCX_IMPORT_METRICS_VERSION,
  TCX_NAMESPACE_V2,
  tcxImportSummarySchema,
  tcxRoundHalfUp,
  type TcxImportSummary,
  type TcxUnsupportedReason,
} from '@running-tracker/contracts';

import { parseInstant } from '../gps-traces/gpx.js';
import { scanNamespacedXml, type ExpandedName } from '../gps-traces/xml-scanner.js';

// The TCX reader of the activity import (ADR-0091). It reads the documented subset of Garmin's Training Center Database
// v2 (packages/contracts, activity-tcx-import.ts) and computes a summary from the laps' REPORTED totals; it never repairs,
// reorders or truncates, and never needs or reads a GPS position. Every message names a lap by its position and never
// quotes a value, a time, a name or any other text of the file, so an error can be shown, logged or reported without
// revealing anything the file contains.
//
// It reuses the hardened, namespace-aware tokenizer of the GPX import (gps-traces/xml-scanner.ts) unchanged: the bounds
// below (depth, element count, retained text) are applied in this reader's own handlers, and the tokenizer's two
// GPX-worded messages are replaced here through the failure callback.

export class TcxImportError extends Error {
  public constructor(
    public readonly reason: TcxUnsupportedReason,
    message: string,
  ) {
    super(message);
    this.name = 'TcxImportError';
  }
}

export interface TcxActivity {
  /**
   * SHA-256 of the canonical laps (`somalane-tcx-activity-v1`): per lap in document order, its start instant and its
   * reported total time and distance as canonical decimals. Whitespace, prefixes, number spelling, the zone spelling of an
   * equal instant, the Id, Sport, notes, creator, heart rate and every trackpoint do not change it; any lap start, lap
   * value, the number of laps or their order does. It identifies "the same TCX activity" for duplicate detection.
   */
  fingerprint: Buffer;
  startedAtMs: number;
  summary: TcxImportSummary;
}

const FINGERPRINT_DOMAIN = 'somalane-tcx-activity-v1\n';
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const XML_DECLARATION_ENCODING = /^<\?xml\b[^>]*?\bencoding\s*=\s*["']([^"']*)["']/u;
const STARTED_AT_MIN_MS = Date.parse(ACTIVITY_STARTED_AT_MIN);
/** xsd:double in decimal notation only, non-negative: digits with an optional fraction and an optional leading "+". */
const DECIMAL = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))$/u;
/** xsd:dateTime with an explicit zone; the fraction's precision is checked separately. */
const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})$/u;

const unsupported = (reason: TcxUnsupportedReason, message: string): never => {
  throw new TcxImportError(reason, message);
};

/** XML whitespace only (space, tab, CR, LF): the whitespace an xsd:double or xsd:dateTime value may be surrounded by. */
function trimXmlWhitespace(value: string): string {
  return value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, '');
}

function decodeUtf8(bytes: Uint8Array): string {
  const hasBom = UTF8_BOM.every((byte, index) => bytes[index] === byte);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(hasBom ? bytes.subarray(3) : bytes);
  } catch {
    return unsupported('not_utf8', 'The file is not UTF-8 text; export the TCX file as UTF-8');
  }
  if (text.includes('\u0000')) {
    unsupported('not_utf8', 'The file contains NUL characters; it is not a UTF-8 TCX document');
  }
  const declared = XML_DECLARATION_ENCODING.exec(text)?.[1];
  if (declared !== undefined && !/^utf-?8$/iu.test(declared.trim())) {
    unsupported('not_utf8', 'The file declares an encoding other than UTF-8; export the TCX file as UTF-8');
  }
  return text;
}

/**
 * An instant with an explicit zone and at most millisecond precision (further fraction digits must be zeros: a finer
 * instant is refused, never truncated), in epoch milliseconds; null otherwise.
 */
export function parseTcxInstant(raw: string): number | null {
  const text = trimXmlWhitespace(raw);
  const match = ZONED_INSTANT.exec(text);
  if (match === null) return null;
  const fraction = match[1] ?? '';
  if (/[^0]/u.test(fraction.slice(3))) return null;
  return parseInstant(text);
}

/** A non-negative exact decimal: its digits as an integer and how many of them are fraction digits. */
export interface ExactDecimal {
  readonly digits: bigint;
  readonly scale: number;
}

/** A lap value (xsd:double restricted to non-negative decimal notation) as an exact decimal; null when not one. */
export function parseTcxDecimal(raw: string): ExactDecimal | null {
  const match = DECIMAL.exec(trimXmlWhitespace(raw));
  if (match === null) return null;
  const whole = match[1] ?? '';
  const fraction = match[2] ?? match[3] ?? '';
  return { digits: BigInt(`${whole}${fraction}` || '0'), scale: fraction.length };
}

function addDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  const widen = (value: ExactDecimal) => value.digits * 10n ** BigInt(scale - value.scale);
  return { digits: widen(left) + widen(right), scale };
}

/** The canonical spelling: no sign, no leading zeros, no exponent, no trailing fraction zeros ("0", "12", "12.05"). */
export function canonicalDecimal(value: ExactDecimal): string {
  const text = value.digits.toString().padStart(value.scale + 1, '0');
  const whole = text.slice(0, text.length - value.scale);
  const fraction = text.slice(text.length - value.scale).replace(/0+$/u, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

const ZERO: ExactDecimal = { digits: 0n, scale: 0 };

type Role = 'activities' | 'activity' | 'distance' | 'id' | 'lap' | 'root' | 'skip' | 'total';

interface LapState {
  distance: ExactDecimal | null;
  distanceSeen: boolean;
  readonly index: number;
  readonly startMs: number;
  total: ExactDecimal | null;
  totalSeen: boolean;
}

/**
 * Reads one TCX file (the bytes exactly as uploaded) and computes its summary. `nowMs` is the server's clock: a start more
 * than 24 hours after it is refused, as for a manual activity (ADR-0072). Throws TcxImportError for every file outside the
 * supported subset.
 */
export function readTcxActivity(bytes: Uint8Array, nowMs: number): TcxActivity {
  if (bytes.byteLength > TCX_IMPORT_MAX_BYTES) {
    // The routes refuse a larger body before it is read; this keeps the function safe on its own.
    throw new RangeError(`A TCX file larger than ${String(TCX_IMPORT_MAX_BYTES)} bytes must not reach the reader`);
  }
  const text = decodeUtf8(bytes);

  const hash = createHash('sha256').update(FINGERPRINT_DOMAIN, 'utf8');
  const roles: Role[] = [];
  let elements = 0;
  let activitiesElements = 0;
  let activities = 0;
  let ids = 0;
  let laps = 0;
  let firstStartMs: number | null = null;
  let previousStartMs: number | null = null;
  let totalTime = ZERO;
  let distance = ZERO;
  // The casts keep TypeScript from narrowing these to null: the element handlers below assign them.
  let lap = null as LapState | null;
  let value = null as { buffer: string } | null;

  const lapName = (index: number) => `lap ${String(index)}`;
  const collect = (chunk: string): void => {
    if (value === null) return;
    value.buffer += chunk;
    if (value.buffer.length > TCX_IMPORT_MAX_TEXT_LENGTH) {
      unsupported('text_too_long', `A value the import reads is longer than ${String(TCX_IMPORT_MAX_TEXT_LENGTH)} characters`);
    }
  };

  const startLap = (attributes: ReadonlyMap<string, string>): void => {
    laps += 1;
    if (laps > TCX_IMPORT_MAX_LAPS) unsupported('too_many_laps', `The activity has more than ${String(TCX_IMPORT_MAX_LAPS)} laps`);
    const name = lapName(laps);
    const startText = attributes.get('StartTime');
    if (startText === undefined) unsupported('start_time_missing', `${name}: has no StartTime; every lap needs one`);
    if ((startText as string).length > TCX_IMPORT_MAX_TEXT_LENGTH) {
      unsupported('text_too_long', `${name}: its StartTime is longer than ${String(TCX_IMPORT_MAX_TEXT_LENGTH)} characters`);
    }
    const startMs = parseTcxInstant(startText as string);
    if (startMs === null) {
      return unsupported(
        'start_time_invalid',
        `${name}: the StartTime is not an ISO 8601 timestamp with a zone (Z or +hh:mm) and at most millisecond precision`,
      );
    }
    if (previousStartMs !== null && startMs <= previousStartMs) {
      unsupported('lap_order', `${name}: starts at or before the previous lap; lap starts must strictly increase`);
    }
    previousStartMs = startMs;
    firstStartMs ??= startMs;
    lap = { distance: null, distanceSeen: false, index: laps, startMs, total: null, totalSeen: false };
  };

  const startElement = (name: ExpandedName, attributes: ReadonlyMap<string, string>): void => {
    elements += 1;
    if (elements > TCX_IMPORT_MAX_ELEMENTS) {
      unsupported('too_many_elements', `The file has more than ${String(TCX_IMPORT_MAX_ELEMENTS)} elements`);
    }
    if (roles.length >= TCX_IMPORT_MAX_DEPTH) {
      unsupported('too_deep', `The file nests elements deeper than ${String(TCX_IMPORT_MAX_DEPTH)} levels`);
    }
    // TCX elements are identified by namespace URI and local name; anything else is foreign (null) and never stands in for
    // a TCX element, whatever its local name.
    const element = name.namespace === TCX_NAMESPACE_V2 ? name.localName : null;
    const parent = roles.at(-1);
    let role: Role = 'skip';
    switch (parent) {
      case undefined:
        if (name.localName !== 'TrainingCenterDatabase') {
          unsupported('not_tcx', 'The file is not a TCX document (the root element is not <TrainingCenterDatabase>)');
        }
        if (element !== 'TrainingCenterDatabase') {
          unsupported('not_tcx_v2', 'The file does not declare the Training Center Database v2 namespace; only TCX v2 is supported');
        }
        role = 'root';
        break;
      case 'root':
        // Folders, Workouts, Courses (whose CourseLap elements are also named Lap), Author, Extensions and foreign
        // elements are skipped whole: none of them is an activity.
        if (element === 'Activities') {
          activitiesElements += 1;
          if (activitiesElements > 1) unsupported('structure', 'The file has more than one <Activities> element');
          role = 'activities';
        }
        break;
      case 'activities':
        if (element === 'MultiSportSession') {
          unsupported('multisport', 'The file holds a multisport session; only a single activity is supported');
        }
        if (element === 'Activity') {
          activities += 1;
          if (activities > 1) unsupported('activity_count', 'The file has more than one activity; only one <Activity> is supported');
          role = 'activity';
        }
        break;
      case 'activity':
        if (element === 'Id') {
          ids += 1;
          if (ids > 1) unsupported('activity_id', 'The activity has more than one <Id>');
          value = { buffer: '' };
          role = 'id';
        } else if (element === 'Lap') {
          startLap(attributes);
          role = 'lap';
        }
        // Notes, Training, Creator, Extensions and foreign elements are skipped whole.
        break;
      case 'lap':
        if (element === 'TotalTimeSeconds' || element === 'DistanceMeters') {
          const current = lap as LapState;
          const total = element === 'TotalTimeSeconds';
          if (total ? current.totalSeen : current.distanceSeen) {
            unsupported('field_duplicate', `${lapName(current.index)}: has more than one <${element}>`);
          }
          if (total) current.totalSeen = true;
          else current.distanceSeen = true;
          value = { buffer: '' };
          role = total ? 'total' : 'distance';
        }
        // Track (with every trackpoint and position), heart rate, calories, cadence, notes and extensions are skipped.
        break;
      case 'id':
      case 'total':
      case 'distance':
        unsupported('structure', 'A value the import reads contains an element instead of text');
        break;
      case 'skip':
        break;
      default: {
        const unknown: never = parent;
        throw new Error(`Unknown TCX reader role: ${String(unknown)}`);
      }
    }
    roles.push(role);
  };

  const endElement = (): void => {
    const role = roles.pop();
    switch (role) {
      case 'id': {
        const idText = (value as { buffer: string }).buffer;
        value = null;
        if (parseTcxInstant(idText) === null) {
          unsupported('activity_id', 'The activity <Id> is not an ISO 8601 timestamp with a zone and at most millisecond precision');
        }
        break;
      }
      case 'total':
      case 'distance': {
        const current = lap as LapState;
        const parsed = parseTcxDecimal((value as { buffer: string }).buffer);
        value = null;
        const field = role === 'total' ? 'TotalTimeSeconds' : 'DistanceMeters';
        if (parsed === null) {
          return unsupported(
            'number_invalid',
            `${lapName(current.index)}: ${field} is not a non-negative decimal number (no sign, exponent, NaN or INF)`,
          );
        }
        if (role === 'total') current.total = parsed;
        else current.distance = parsed;
        break;
      }
      case 'lap': {
        const current = lap as LapState;
        lap = null;
        if (current.total === null) unsupported('field_missing', `${lapName(current.index)}: has no <TotalTimeSeconds>`);
        if (current.distance === null) unsupported('field_missing', `${lapName(current.index)}: has no <DistanceMeters>`);
        const lapTotal = current.total as ExactDecimal;
        const lapDistance = current.distance as ExactDecimal;
        totalTime = addDecimals(totalTime, lapTotal);
        distance = addDecimals(distance, lapDistance);
        hash.update(`l ${String(current.startMs)} ${canonicalDecimal(lapTotal)} ${canonicalDecimal(lapDistance)}\n`, 'utf8');
        break;
      }
      case 'activity':
        if (ids === 0) unsupported('activity_id', 'The activity has no <Id>');
        if (laps === 0) unsupported('no_laps', 'The activity has no laps; at least one <Lap> is needed');
        break;
      case 'activities':
      case 'root':
      case 'skip':
      case undefined:
        break;
      default: {
        const unknown: never = role;
        throw new Error(`Unknown TCX reader role: ${String(unknown)}`);
      }
    }
  };

  scanNamespacedXml(
    text,
    { endElement, startElement, text: collect },
    (kind, message) => {
      if (kind === 'declaration') {
        return unsupported('declaration', 'The file declares a DOCTYPE or entities; DTDs are not supported, export a plain TCX file');
      }
      if (kind === 'not_xml') {
        return unsupported('not_xml', 'The file is not XML (expected a TCX document); it may be empty or in another format');
      }
      return unsupported('malformed_xml', message);
    },
  );

  if (activities === 0) {
    unsupported('activity_count', 'The file has no activity (<Activity> inside <Activities>); courses and workouts are not imported');
  }
  const startedAtMs = firstStartMs as number | null;
  if (startedAtMs === null) return unsupported('no_laps', 'The activity has no laps; at least one <Lap> is needed');
  if (startedAtMs < STARTED_AT_MIN_MS) unsupported('start_before_minimum', 'The activity starts before the year 2000');
  if (startedAtMs > nowMs + ACTIVITY_FUTURE_SKEW_MS) {
    unsupported('start_in_future', 'The activity starts more than 24 hours after server time');
  }

  const totalTimeSeconds = canonicalDecimal(totalTime);
  const distanceMeters = canonicalDecimal(distance);
  // Rounded once, after the exact sum, halves up (ADR-0091). A sum too large for a safe integer is out of range anyway.
  const rounded = (decimal: string): number => {
    try {
      return tcxRoundHalfUp(decimal);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
  const reportedDurationS = rounded(totalTimeSeconds);
  if (reportedDurationS < 1 || reportedDurationS > ACTIVITY_DURATION_MAX_S) {
    unsupported(
      'duration_out_of_range',
      `The laps report a total time that rounds to less than 1 second or more than ${String(ACTIVITY_DURATION_MAX_S / 3_600)} hours`,
    );
  }
  const distanceM = rounded(distanceMeters);
  if (distanceM > ACTIVITY_DISTANCE_MAX_M) {
    unsupported('distance_out_of_range', `The laps report more than ${String(ACTIVITY_DISTANCE_MAX_M / 1_000)} km`);
  }

  return {
    fingerprint: hash.digest(),
    startedAtMs,
    summary: tcxImportSummarySchema.parse({
      distanceM,
      lapCount: laps,
      lapTotals: { distanceMeters, totalTimeSeconds },
      metricsVersion: TCX_IMPORT_METRICS_VERSION,
      reportedDurationS,
      startedAt: new Date(startedAtMs).toISOString(),
    }),
  };
}

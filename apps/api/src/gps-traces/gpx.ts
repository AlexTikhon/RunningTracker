import { RawTraceError, validateRawTrace, type RawPoint, type RawTrace } from './raw-trace.js';

// A strict reader for the part of GPX 1.0/1.1 that a track needs: <trkpt lat lon> with a <time> and, optionally, a
// horizontal accuracy in metres from an extension element. It is intentionally not a general XML parser:
//  - DTDs and entity declarations are rejected, so there is nothing to expand;
//  - metadata, names, authors, waypoints, routes, elevation and every other element are skipped, never stored;
//  - HDOP is not accuracy in metres and is ignored rather than converted.
// A file this reader cannot read exactly is an error, not a best effort.

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;
const ACCURACY_ELEMENTS = new Set(['accuracy', 'hacc', 'horizontalaccuracy']);
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u;
const ATTRIBUTE = /([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;

function localName(qualifiedName: string): string {
  return qualifiedName.slice(qualifiedName.lastIndexOf(':') + 1);
}

function malformed(detail: string): never {
  throw new RawTraceError(`The file is malformed XML: ${detail}`);
}

/** An ISO 8601 instant with an explicit timezone, in milliseconds since the epoch, or null. */
function parseInstant(text: string): number | null {
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

function parseAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of text.matchAll(ATTRIBUTE)) {
    attributes[localName(match[1] as string)] = (match[2] ?? match[3]) as string;
  }
  if (text.replace(ATTRIBUTE, '').trim() !== '') {
    malformed('an element has an attribute that is not name="value"');
  }
  return attributes;
}

export function parseGpx(text: string): RawTrace {
  if (/<!DOCTYPE|<!ENTITY|<!\[(?!CDATA\[)/iu.test(text)) {
    throw new RawTraceError('The file declares a DOCTYPE or entities; DTDs are not supported, export a plain GPX file');
  }

  const stack: string[] = [];
  const points: RawPoint[] = [];
  let segments = 0;
  let pointCount = 0;
  // The casts keep TypeScript from narrowing these to null: the element handlers below assign them.
  let pending = null as PendingPoint | null;
  let collecting = null as { readonly depth: number; readonly kind: 'accuracy' | 'time'; buffer: string } | null;
  let sawElement = false;

  const startElement = (qualifiedName: string, attributes: Record<string, string>): void => {
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
    if (stack.pop() !== qualifiedName) {
      malformed(`a closing tag does not match its opening tag`);
    }
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

  let position = 0;
  while (position < text.length) {
    const open = text.indexOf('<', position);
    if (open === -1) {
      if (text.slice(position).trim() !== '') {
        malformed('text outside the root element');
      }
      break;
    }
    if (collecting !== null && open > position) {
      collecting.buffer += text.slice(position, open);
    }
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      if (end === -1) {
        malformed('an unterminated comment');
      }
      position = end + 3;
    } else if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9);
      if (end === -1) {
        malformed('an unterminated CDATA section');
      }
      if (collecting !== null) {
        collecting.buffer += text.slice(open + 9, end);
      }
      position = end + 3;
    } else if (text.startsWith('<?', open)) {
      const end = text.indexOf('?>', open + 2);
      if (end === -1) {
        malformed('an unterminated processing instruction');
      }
      position = end + 2;
    } else {
      // The end of a tag is the first '>' outside a quoted attribute value.
      let quote = '';
      let end = -1;
      for (let index = open + 1; index < text.length; index += 1) {
        const character = text[index] as string;
        if (quote !== '') {
          if (character === quote) {
            quote = '';
          }
        } else if (character === '"' || character === "'") {
          quote = character;
        } else if (character === '>') {
          end = index;
          break;
        }
      }
      if (end === -1) {
        malformed('an unterminated tag');
      }
      const tag = text.slice(open + 1, end);
      if (tag.startsWith('/')) {
        endElement(tag.slice(1).trim());
      } else {
        const selfClosing = tag.endsWith('/');
        const body = selfClosing ? tag.slice(0, -1) : tag;
        const nameMatch = /^([^\s/>]+)([\s\S]*)$/u.exec(body);
        if (!nameMatch) {
          malformed('an element has no name');
        }
        sawElement = true;
        const qualifiedName = nameMatch[1] as string;
        startElement(qualifiedName, parseAttributes(nameMatch[2] as string));
        if (selfClosing) {
          endElement(qualifiedName);
        }
      }
      position = end + 1;
    }
  }

  if (!sawElement) {
    throw new RawTraceError('The file is not XML (expected a GPX document); it may be empty or in another format');
  }
  if (stack.length !== 0) {
    malformed('an element is never closed');
  }
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

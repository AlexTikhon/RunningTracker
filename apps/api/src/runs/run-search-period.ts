import { parseLocalDate, type RunSearchPreset } from '@running-tracker/contracts';

// Turns what a person means by a period (calendar dates in a place) into the half-open UTC interval
// `[from, to)` that is compared with `runs.started_at`.
//
// A local day is not 24 hours long: it is 23 or 25 around a daylight saving change, 23.5 around Lord Howe's, and
// in a few zones local midnight does not exist or happens twice. The day is therefore located from the zone's own
// offset history (the platform's IANA database through `Intl`), never by adding a fixed number of milliseconds,
// and the next date is found by calendar arithmetic. No dependency: Node 24 has no stable Temporal yet.

export interface ResolvedPeriod {
  from: Date;
  fromDate: string;
  to: Date;
  toDate: string;
}

export type SearchPeriodInput =
  | { fromDate: string; toDate: string; preset?: undefined }
  | { fromDate?: undefined; preset: RunSearchPreset; toDate?: undefined };

const DAY_MS = 86_400_000;
// Offsets are at most 14 hours; two days either side of the wall-clock midnight always contains the whole
// neighbourhood in which the date can change, and the sampling step is far shorter than the gap between two
// transitions of any zone.
const WINDOW_MS = 2 * DAY_MS;
const SAMPLE_STEP_MS = 3 * 3_600_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

// `Intl` accepts a zone name in any letter case, so the cache is keyed by the lower-cased name: the number of
// entries is bounded by the number of zones, not by how many spellings a client can invent.
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const key = timeZone.toLowerCase();
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
      month: '2-digit',
      second: '2-digit',
      timeZone,
      year: 'numeric',
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

// The wall-clock reading of an instant, as if that reading were UTC.
function wallClockMs(instantMs: number, timeZone: string): number {
  const fields: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') {
      fields[part.type] = Number(part.value);
    }
  }
  return Date.UTC(
    fields.year!,
    fields.month! - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );
}

function offsetMs(instantMs: number, timeZone: string): number {
  return wallClockMs(instantMs, timeZone) - Math.floor(instantMs / 1_000) * 1_000;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

export function localDateOf(instantMs: number, timeZone: string): string {
  const wall = new Date(wallClockMs(instantMs, timeZone));
  return `${pad(wall.getUTCFullYear(), 4)}-${pad(wall.getUTCMonth() + 1, 2)}-${pad(wall.getUTCDate(), 2)}`;
}

interface Segment {
  endMs: number;
  offsetMs: number;
  startMs: number;
}

// Maximal stretches of constant offset in [lowMs, highMs).
function offsetSegments(lowMs: number, highMs: number, timeZone: string): Segment[] {
  const segments: Segment[] = [];
  let startMs = lowMs;
  let current = offsetMs(lowMs, timeZone);
  for (let left = lowMs; left < highMs; left += SAMPLE_STEP_MS) {
    const right = Math.min(left + SAMPLE_STEP_MS, highMs);
    const rightOffset = offsetMs(right, timeZone);
    if (rightOffset === current) {
      continue;
    }
    // The change is somewhere in (left, right]: find the first whole second that already has the new offset.
    let known = Math.floor(left / 1_000);
    let changed = Math.floor(right / 1_000);
    while (changed - known > 1) {
      const middle = Math.floor((known + changed) / 2);
      if (offsetMs(middle * 1_000, timeZone) === current) {
        known = middle;
      } else {
        changed = middle;
      }
    }
    const transitionMs = changed * 1_000;
    segments.push({ endMs: transitionMs, offsetMs: current, startMs });
    startMs = transitionMs;
    current = offsetMs(transitionMs, timeZone);
  }
  segments.push({ endMs: highMs, offsetMs: current, startMs });
  return segments;
}

/**
 * The first instant from which every later instant has a local date on or after `date`. For an ordinary day
 * that is local midnight. When local midnight does not exist (clocks jump over it) it is the instant of the
 * jump; when midnight happens twice because clocks go back at 01:00 it is the first of them; when clocks go back
 * from 00:00 to 23:00 of the previous date, the date that ends there is 25 hours long and the new date begins at
 * the second midnight, so the repeated hour still belongs to the earlier date. A date that was skipped entirely
 * (Pacific/Apia, 2011-12-30) begins where the next existing date does, so its interval is empty.
 */
export function startOfLocalDate(date: string, timeZone: string): number {
  const wallMidnightMs = wallMidnightOf(date);
  const segments = offsetSegments(wallMidnightMs - WINDOW_MS, wallMidnightMs + WINDOW_MS, timeZone);
  let boundary = wallMidnightMs + WINDOW_MS;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    // Within this segment local time is instant + offset, so the date has been reached from here on:
    const reachedAt = wallMidnightMs - segment.offsetMs;
    if (reachedAt >= segment.endMs) {
      break;
    }
    boundary = Math.max(segment.startMs, reachedAt);
    if (boundary > segment.startMs) {
      break;
    }
  }
  return boundary;
}

// The day after the last accepted date may be one past the contract's range, so this parses without the range.
function splitDate(date: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) {
    throw new RangeError(`Not a calendar date: ${date}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function wallMidnightOf(date: string): number {
  const [year, month, day] = splitDate(date);
  return Date.UTC(year, month - 1, day);
}

// Calendar arithmetic on the date itself: the day of the month is moved and the calendar normalises it. No
// duration is added to an instant, so a 23- or 25-hour local day cannot skew it.
function addDays(date: string, days: number): string {
  const [year, month, day] = splitDate(date);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return `${pad(moved.getUTCFullYear(), 4)}-${pad(moved.getUTCMonth() + 1, 2)}-${pad(moved.getUTCDate(), 2)}`;
}

function monthRange(year: number, month: number): { fromDate: string; toDate: string } {
  const normalized = new Date(Date.UTC(year, month - 1, 1));
  const y = normalized.getUTCFullYear();
  const m = normalized.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { fromDate: `${pad(y, 4)}-${pad(m, 2)}-01`, toDate: `${pad(y, 4)}-${pad(m, 2)}-${pad(lastDay, 2)}` };
}

/**
 * `preset` months are whole calendar months in `timeZone`, chosen by the local date of `now`; the caller passes the
 * server's injectable clock, never a client value. Explicit dates are inclusive on both ends: the interval runs from
 * the start of `fromDate` up to, not including, the start of the day after `toDate`.
 */
export function resolveSearchPeriod(
  input: SearchPeriodInput,
  timeZone: string,
  now: Date,
): ResolvedPeriod {
  let fromDate: string;
  let toDate: string;
  if (input.preset === undefined) {
    ({ fromDate, toDate } = input);
  } else {
    const today = parseLocalDate(localDateOf(now.getTime(), timeZone));
    if (today === null) {
      throw new RangeError('The clock is outside the supported calendar range');
    }
    ({ fromDate, toDate } = monthRange(
      today.year,
      input.preset === 'this-month' ? today.month : today.month - 1,
    ));
  }
  return {
    from: new Date(startOfLocalDate(fromDate, timeZone)),
    fromDate,
    to: new Date(startOfLocalDate(addDays(toDate, 1), timeZone)),
    toDate,
  };
}

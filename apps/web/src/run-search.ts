import {
  ARCHIVE_PERIOD_MAX_DAYS,
  isSupportedIanaTimeZone,
  parseLocalDate,
  RUN_SEARCH_DISTANCE_MAX_UNITS,
  type DistanceUnit,
  type RunSearchPreset,
  type RunSearchSort,
} from '@running-tracker/contracts';

// The editable draft of "my runs" filters, the validated filters that were applied, and what the screen says about
// them. Nothing here talks to the network and nothing here knows an owner: the server takes the owner from the
// session.

export type PeriodDraft =
  | { kind: 'preset'; preset: RunSearchPreset }
  | { fromDate: string; kind: 'dates'; toDate: string };

export interface RunSearchDraft {
  maxDistance: string;
  minDistance: string;
  period: PeriodDraft;
  sort: RunSearchSort;
  unit: DistanceUnit;
}

export interface RunSearchFilters {
  maxDistance: string | null;
  minDistance: string | null;
  period: PeriodDraft;
  sort: RunSearchSort;
  timeZone: string;
  unit: DistanceUnit;
}

export type DraftValidation =
  | { errors: string[]; ok: false }
  | { filters: RunSearchFilters; ok: true };

const distancePattern = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,3})?$/u;

export function defaultDraft(): RunSearchDraft {
  return {
    maxDistance: '',
    minDistance: '',
    period: { kind: 'preset', preset: 'this-month' },
    sort: 'newest',
    unit: 'km',
  };
}

// The browser's own zone, shown to the person. A name the server would refuse (an offset, or one this platform's
// database does not know) falls back to UTC rather than making every search fail.
export function defaultTimeZone(
  read: () => string | undefined = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  let zone: string | undefined;
  try {
    zone = read();
  } catch {
    zone = undefined;
  }
  return zone !== undefined && isSupportedIanaTimeZone(zone) ? zone : 'UTC';
}

function normalizeBound(value: string): string {
  const trimmed = value.trim();
  // A single decimal comma is a decimal point for people who write it that way.
  return /^\d+,\d+$/u.test(trimmed) ? trimmed.replace(',', '.') : trimmed;
}

function inclusiveDays(fromDate: string, toDate: string): number | null {
  const from = parseLocalDate(fromDate);
  const to = parseLocalDate(toDate);
  if (from === null || to === null) {
    return null;
  }
  return (
    (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) / 86_400_000 + 1
  );
}

export function validateDraft(draft: RunSearchDraft, timeZone: string): DraftValidation {
  const errors: string[] = [];
  if (draft.period.kind === 'dates') {
    const { fromDate, toDate } = draft.period;
    if (fromDate === '' || toDate === '') {
      errors.push('Choose both a start date and an end date.');
    } else {
      const days = inclusiveDays(fromDate, toDate);
      if (days === null) {
        errors.push('Enter the dates as real calendar dates.');
      } else if (days < 1) {
        errors.push('The start date must not be after the end date.');
      } else if (days > ARCHIVE_PERIOD_MAX_DAYS) {
        errors.push(`Choose a period of at most ${ARCHIVE_PERIOD_MAX_DAYS} days.`);
      }
    }
  }

  const bounds: Array<[string, string]> = [
    ['minimum', normalizeBound(draft.minDistance)],
    ['maximum', normalizeBound(draft.maxDistance)],
  ];
  for (const [name, value] of bounds) {
    if (value !== '' && (!distancePattern.test(value) || Number(value) > RUN_SEARCH_DISTANCE_MAX_UNITS)) {
      errors.push(
        `The ${name} distance must be a number with up to three decimals, from 0 to ${RUN_SEARCH_DISTANCE_MAX_UNITS}.`,
      );
    }
  }
  const minimum = bounds[0]![1];
  const maximum = bounds[1]![1];
  if (
    errors.length === 0 &&
    minimum !== '' &&
    maximum !== '' &&
    Number(minimum) > Number(maximum)
  ) {
    errors.push('The minimum distance must not exceed the maximum distance.');
  }

  if (errors.length > 0) {
    return { errors, ok: false };
  }
  return {
    filters: {
      maxDistance: maximum === '' ? null : maximum,
      minDistance: minimum === '' ? null : minimum,
      period: draft.period,
      sort: draft.sort,
      timeZone,
      unit: draft.unit,
    },
    ok: true,
  };
}

export function toSearchParams(filters: RunSearchFilters, cursor?: string): Record<string, string> {
  const params: Record<string, string> = { sort: filters.sort, timeZone: filters.timeZone };
  if (filters.period.kind === 'preset') {
    params.preset = filters.period.preset;
  } else {
    params.fromDate = filters.period.fromDate;
    params.toDate = filters.period.toDate;
  }
  if (filters.minDistance !== null) {
    params.minDistance = filters.minDistance;
  }
  if (filters.maxDistance !== null) {
    params.maxDistance = filters.maxDistance;
  }
  if (filters.minDistance !== null || filters.maxDistance !== null) {
    params.distanceUnit = filters.unit;
  }
  if (cursor !== undefined) {
    params.cursor = cursor;
  }
  return params;
}

const METRES_PER_UNIT: Record<DistanceUnit, number> = { km: 1_000, mi: 1_609.344 };

export function formatDistance(metres: number, unit: DistanceUnit): string {
  return `${(metres / METRES_PER_UNIT[unit]).toFixed(2)} ${unit}`;
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const rest = total % 60;
  const two = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(rest)}` : `${minutes}:${two(rest)}`;
}

// The application is in English, so dates are written in one fixed English form on every machine.
export function formatStartedAt(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: 'short',
    timeZone,
    year: 'numeric',
  }).format(new Date(instant));
}

// A calendar date has no instant, so it is formatted as UTC and never moved by a zone.
export function formatLocalDate(date: string): string {
  const parsed = parseLocalDate(date);
  if (parsed === null) {
    return date;
  }
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)));
}

export function sortLabel(sort: RunSearchSort): string {
  switch (sort) {
    case 'longest':
      return 'Longest first';
    case 'shortest':
      return 'Shortest first';
    case 'newest':
      return 'Newest first';
  }
}

export interface AppliedFilterText {
  distance: string;
  period: string;
  sort: string;
  timeZone: string;
}

// `resolved` is the period the server actually used (a preset becomes concrete dates); null before the first answer.
export function describeAppliedFilters(
  filters: RunSearchFilters,
  resolved: { fromDate: string; toDate: string } | null,
): AppliedFilterText {
  let period: string;
  if (filters.period.kind === 'dates') {
    period = `${formatLocalDate(filters.period.fromDate)} – ${formatLocalDate(filters.period.toDate)}`;
  } else {
    const name = filters.period.preset === 'this-month' ? 'This month' : 'Previous month';
    period =
      resolved === null
        ? name
        : `${name} · ${formatLocalDate(resolved.fromDate)} – ${formatLocalDate(resolved.toDate)}`;
  }

  let distance: string;
  if (filters.minDistance !== null && filters.maxDistance !== null) {
    distance = `${filters.minDistance}–${filters.maxDistance} ${filters.unit}`;
  } else if (filters.minDistance !== null) {
    distance = `at least ${filters.minDistance} ${filters.unit}`;
  } else if (filters.maxDistance !== null) {
    distance = `up to ${filters.maxDistance} ${filters.unit}`;
  } else {
    distance = 'any distance';
  }

  return { distance, period, sort: sortLabel(filters.sort), timeZone: filters.timeZone };
}

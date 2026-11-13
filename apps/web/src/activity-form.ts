import {
  ACTIVITY_DISTANCE_MAX_M,
  ACTIVITY_DURATION_MAX_S,
  ACTIVITY_FUTURE_SKEW_MS,
  ACTIVITY_NOTES_MAX_LENGTH,
  ACTIVITY_STARTED_AT_MIN,
  ACTIVITY_TYPES,
  createActivityRequestSchema,
  type ActivitySource,
  type ActivityType,
  type CreateActivityRequest,
  type DistanceUnit,
} from '@running-tracker/contracts';

// The editable form of a manual activity (ADR-0072). Every field is the text the person typed; only a valid draft
// becomes a request. The server checks the same rules again and is the authority.
export interface ActivityDraft {
  // Decimal in `unit`, or '' for none.
  distance: string;
  hours: string;
  minutes: string;
  notes: string;
  // '' for none, otherwise 1..10.
  rpe: string;
  seconds: string;
  // A datetime-local value: the browser's wall-clock time, without a zone.
  startedAtLocal: string;
  type: ActivityType;
  unit: DistanceUnit;
}

// What the person entered. The form session's idempotency key is added by the submission controller (ADR-0073).
export type ActivityDetails = Omit<Required<CreateActivityRequest>, 'idempotencyKey'>;

export type ActivityDraftValidation =
  | { ok: true; request: ActivityDetails }
  | { errors: string[]; ok: false };

/** Where an activity came from (server-owned, ADR-0086/0091): never presented as manual, or as another format, when it was imported. */
export const activitySourceLabels: Record<ActivitySource, string> = {
  gpx: 'GPX import',
  manual: 'Entered manually',
  tcx: 'TCX import',
};

/**
 * A GPX import's duration is the file's elapsed time, pauses included; a TCX import's is what its laps report (neither
 * elapsed nor moving time); a manual one is what the person entered.
 */
export const activityDurationLabels: Record<ActivitySource, string> = {
  gpx: 'Elapsed time',
  manual: 'Duration',
  tcx: 'Reported duration',
};

export const activityTypeLabels: Record<ActivityType, string> = {
  hike: 'Hike',
  other: 'Other',
  ride: 'Ride',
  run: 'Run',
  strength: 'Strength',
  swim: 'Swim',
  walk: 'Walk',
};

const two = (value: number) => String(value).padStart(2, '0');

export function formatLocalDateTimeInput(date: Date): string {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function defaultActivityDraft(now: Date): ActivityDraft {
  return {
    distance: '',
    hours: '',
    minutes: '',
    notes: '',
    rpe: '',
    seconds: '',
    startedAtLocal: formatLocalDateTimeInput(now),
    type: 'run',
    unit: 'km',
  };
}

/**
 * A datetime-local value as an instant, read in the browser's zone. A value that does not name a real wall-clock time
 * (30 February, 24:00, or a time skipped by a clock change) is null: the components must survive the round trip.
 */
export function parseLocalDateTime(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? '0')) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return null;
  }
  return date;
}

// One international mile is exactly 1609.344 m. A decimal with at most three fraction digits is an integer number of
// thousandths, so the metres come from one division of two integers far below 2^53, which is correctly rounded;
// binary multiplication is not (0.017 * 1609.344 is 27.358847999999998).
const MICROMETRES_PER_THOUSANDTH: Record<DistanceUnit, number> = { km: 1_000_000, mi: 1_609_344 };
const distancePattern = /^(?:0|[1-9]\d{0,6})(?:\.(\d{1,3}))?$/u;

export function distanceToMetres(value: string, unit: DistanceUnit): number | null {
  const match = distancePattern.exec(value);
  if (!match) return null;
  const [whole, fraction = ''] = value.split('.') as [string, string?];
  const thousandths = Number(whole) * 1_000 + Number(fraction.padEnd(3, '0'));
  return (thousandths * MICROMETRES_PER_THOUSANDTH[unit]) / 1_000_000;
}

const wholeNumber = /^\d+$/u;

export function validateActivityDraft(draft: ActivityDraft, nowMs: number): ActivityDraftValidation {
  const errors: string[] = [];

  if (!(ACTIVITY_TYPES as readonly string[]).includes(draft.type)) {
    errors.push('Choose an activity type.');
  }

  const started = parseLocalDateTime(draft.startedAtLocal);
  if (started === null) {
    errors.push('Enter the date and time the activity started.');
  } else if (started.getTime() < Date.parse(ACTIVITY_STARTED_AT_MIN)) {
    errors.push('The start cannot be before the year 2000.');
  } else if (started.getTime() > nowMs + ACTIVITY_FUTURE_SKEW_MS) {
    errors.push('The start cannot be more than 24 hours from now.');
  }

  let durationS: number | null = null;
  const part = (text: string) => (text === '' ? 0 : wholeNumber.test(text) ? Number(text) : null);
  const hours = part(draft.hours);
  const minutes = part(draft.minutes);
  const seconds = part(draft.seconds);
  if (hours === null) {
    errors.push('Hours must be a whole number.');
  } else if (minutes === null || seconds === null || minutes > 59 || seconds > 59) {
    errors.push('Minutes and seconds must be whole numbers from 0 to 59.');
  } else {
    const total = hours * 3_600 + minutes * 60 + seconds;
    if (total < 1) {
      errors.push('Enter a duration of at least one second.');
    } else if (total > ACTIVITY_DURATION_MAX_S) {
      errors.push('The duration cannot be longer than 48 hours.');
    } else {
      durationS = total;
    }
  }

  let distanceM: number | null = null;
  if (draft.distance !== '') {
    const metres = distanceToMetres(draft.distance, draft.unit);
    if (metres === null) {
      errors.push('Enter the distance as a number such as 5 or 12.345.');
    } else if (metres > ACTIVITY_DISTANCE_MAX_M) {
      errors.push('The distance cannot be more than 1000 km.');
    } else {
      distanceM = metres;
    }
  }

  let rpe: number | null = null;
  if (draft.rpe !== '') {
    const value = wholeNumber.test(draft.rpe) ? Number(draft.rpe) : NaN;
    if (!(value >= 1 && value <= 10)) {
      errors.push('Effort (RPE) must be a whole number from 1 to 10.');
    } else {
      rpe = value;
    }
  }

  const trimmed = draft.notes.trim();
  const notes = trimmed === '' ? null : trimmed;
  if (notes !== null && notes.length > ACTIVITY_NOTES_MAX_LENGTH) {
    errors.push(`Notes can be at most ${ACTIVITY_NOTES_MAX_LENGTH} characters.`);
  } else if (notes !== null && (notes.includes('\u0000') || /\p{Cs}/u.test(notes))) {
    errors.push('Notes contain a character that cannot be stored.');
  }

  if (errors.length > 0 || started === null || durationS === null) {
    return { errors, ok: false };
  }
  const request: ActivityDetails = {
    distanceM,
    durationS,
    notes,
    rpe,
    startedAt: started.toISOString(),
    type: draft.type,
  };
  // The contract is the last word: a draft that passes here must pass the server's schema too (checked with a
  // placeholder key, since the key belongs to the form session, not to the draft).
  const checked = createActivityRequestSchema.safeParse({ ...request, idempotencyKey: '00000000-0000-4000-8000-000000000000' });
  if (!checked.success) {
    return { errors: ['The activity could not be prepared. Check the fields and try again.'], ok: false };
  }
  return { ok: true, request };
}

/** Whether two prepared requests are the same payload, so a retry may reuse the earlier attempt's activity id. */
export function sameActivityRequest(left: ActivityDetails, right: ActivityDetails): boolean {
  return (
    left.type === right.type &&
    left.startedAt === right.startedAt &&
    left.durationS === right.durationS &&
    left.distanceM === right.distanceM &&
    left.rpe === right.rpe &&
    left.notes === right.notes
  );
}

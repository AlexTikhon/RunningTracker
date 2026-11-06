import {
  DAILY_METRICS_LOCAL_DATE_MIN,
  DAILY_METRICS_NOTE_MAX_LENGTH,
  DAILY_METRICS_SLEEP_MAX_MINUTES,
  DAILY_METRICS_SORENESS_MAX,
  DAILY_METRICS_WEIGHT_MAX_KG,
  DAILY_METRICS_WEIGHT_MIN_KG,
  addLocalDays,
  parseLocalDate,
  putDailyMetricsRequestSchema,
  type DailyMetricsView,
  type PutDailyMetricsRequest,
} from '@running-tracker/contracts';

// The daily check-in form (ADR-0074). Every field is the text the person typed; only a valid draft becomes a request.
// The server checks the same rules again and is the authority, also for "not after today".

export const CHECKIN_HISTORY_DAYS = 14;

export interface CheckInDraft {
  mood: string;
  note: string;
  // Sleep as hours and minutes; both empty means "not recorded".
  sleepHours: string;
  sleepMinutes: string;
  sleepQuality: string;
  soreness: string;
  // Kilograms, '.' or ',' as the decimal separator.
  weightKg: string;
}

/** The six values of a day, every one present (null for "not recorded"). The zone is added when it is sent. */
export type CheckInValues = Required<Omit<PutDailyMetricsRequest, 'timeZone'>>;

export type CheckInValidation = { errors: string[]; ok: false } | { ok: true; values: CheckInValues };

export const emptyCheckInDraft: CheckInDraft = {
  mood: '',
  note: '',
  sleepHours: '',
  sleepMinutes: '',
  sleepQuality: '',
  soreness: '',
  weightKg: '',
};

const integerPattern = /^\d{1,4}$/u;
const weightPattern = /^\d{1,3}(?:[.,]\d{1,2})?$/u;

function scale(value: string, low: number, high: number, label: string, errors: string[]): number | null {
  if (value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < low || parsed > high) {
    errors.push(`${label} must be a whole number from ${low} to ${high}.`);
    return null;
  }
  return parsed;
}

export function validateCheckInDraft(draft: CheckInDraft): CheckInValidation {
  const errors: string[] = [];

  let weightKg: number | null = null;
  const weightText = draft.weightKg.trim();
  if (weightText !== '') {
    const parsed = weightPattern.test(weightText) ? Number(weightText.replace(',', '.')) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < DAILY_METRICS_WEIGHT_MIN_KG || parsed > DAILY_METRICS_WEIGHT_MAX_KG) {
      errors.push(
        `Weight must be between ${DAILY_METRICS_WEIGHT_MIN_KG} and ${DAILY_METRICS_WEIGHT_MAX_KG} kg, with at most two decimals.`,
      );
    } else {
      weightKg = parsed;
    }
  }

  let sleepMinutes: number | null = null;
  const hoursText = draft.sleepHours.trim();
  const minutesText = draft.sleepMinutes.trim();
  if (hoursText !== '' || minutesText !== '') {
    const hours = hoursText === '' ? 0 : integerPattern.test(hoursText) ? Number(hoursText) : Number.NaN;
    const minutes = minutesText === '' ? 0 : integerPattern.test(minutesText) ? Number(minutesText) : Number.NaN;
    if (!Number.isInteger(hours) || !Number.isInteger(minutes) || minutes > 59) {
      errors.push('Sleep must be whole hours and 0 to 59 minutes.');
    } else if (hours * 60 + minutes > DAILY_METRICS_SLEEP_MAX_MINUTES) {
      errors.push('Sleep cannot be more than 24 hours.');
    } else {
      sleepMinutes = hours * 60 + minutes;
    }
  }

  const sleepQuality = scale(draft.sleepQuality, 1, 5, 'Sleep quality', errors);
  const mood = scale(draft.mood, 1, 5, 'Mood', errors);
  const soreness = scale(draft.soreness, 0, DAILY_METRICS_SORENESS_MAX, 'Soreness', errors);

  // A note of only spaces is no note; otherwise it is kept as typed.
  const note = draft.note.trim() === '' ? null : draft.note;
  if (note !== null && note.length > DAILY_METRICS_NOTE_MAX_LENGTH) {
    errors.push(`The note can be at most ${DAILY_METRICS_NOTE_MAX_LENGTH} characters.`);
  }

  const values: CheckInValues = { mood, note, sleepMinutes, sleepQuality, soreness, weightKg };
  if (errors.length === 0 && Object.values(values).every((value) => value === null)) {
    errors.push('Enter at least one value.');
  }
  if (errors.length > 0) return { errors, ok: false };
  // The contract is the authority: anything it refuses is shown rather than sent.
  const checked = putDailyMetricsRequestSchema.safeParse({ ...values, timeZone: 'UTC' });
  if (!checked.success) return { errors: ['Check the values and try again.'], ok: false };
  return { ok: true, values };
}

const two = (value: number) => String(value).padStart(2, '0');

/** The draft that shows a stored day, so saving it unchanged sends the same values again. */
export function draftFromView(view: DailyMetricsView): CheckInDraft {
  return {
    mood: view.mood === null ? '' : String(view.mood),
    note: view.note ?? '',
    sleepHours: view.sleepMinutes === null ? '' : String(Math.floor(view.sleepMinutes / 60)),
    sleepMinutes: view.sleepMinutes === null ? '' : two(view.sleepMinutes % 60),
    sleepQuality: view.sleepQuality === null ? '' : String(view.sleepQuality),
    soreness: view.soreness === null ? '' : String(view.soreness),
    weightKg: view.weightKg === null ? '' : String(view.weightKg),
  };
}

/** The calendar date of an instant in an IANA zone, as YYYY-MM-DD. */
export function localDateIn(timeZone: string, instantMs: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(new Date(instantMs));
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${field('year')}-${field('month')}-${field('day')}`;
}

/** The date the form may be set to: a real date from 2000-01-01 to today. */
export function checkInDateProblem(date: string, today: string): string | null {
  if (parseLocalDate(date) === null) return 'Choose a date.';
  if (date < DAILY_METRICS_LOCAL_DATE_MIN) return 'The date cannot be before 1 January 2000.';
  if (date > today) return 'The date cannot be after today.';
  return null;
}

export interface HistoryDay {
  localDate: string;
  metrics: DailyMetricsView | null;
}

/** The first and last date of the history window ending today. */
export function historyRange(today: string, count: number = CHECKIN_HISTORY_DAYS): { from: string; to: string } {
  return { from: addLocalDays(today, -(count - 1)), to: today };
}

/** Every day of the window, newest first, the days without a check-in included as empty. */
export function historyDays(today: string, items: readonly DailyMetricsView[], count: number = CHECKIN_HISTORY_DAYS): HistoryDay[] {
  const byDate = new Map(items.map((item) => [item.localDate, item]));
  return Array.from({ length: count }, (_, index) => {
    const localDate = addLocalDays(today, -index);
    return { localDate, metrics: byDate.get(localDate) ?? null };
  });
}

// A calendar date has no instant, so it is formatted as UTC and never moved by a zone.
export function formatCheckInDate(date: string): string {
  const parsed = parseLocalDate(date);
  if (parsed === null) return date;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
    weekday: 'short',
    year: 'numeric',
  }).format(new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)));
}

export function formatSleep(minutes: number): string {
  return `${Math.floor(minutes / 60)} h ${two(minutes % 60)} min`;
}

/** The recorded values of a day as short labelled pieces, in the form's order. */
export function summarizeCheckIn(view: DailyMetricsView): Array<{ label: string; value: string }> {
  const pieces: Array<{ label: string; value: string }> = [];
  // A stored weight has at most two decimals, so the shortest spelling is exact (72.3, 72.35, 70).
  if (view.weightKg !== null) pieces.push({ label: 'Weight', value: `${String(view.weightKg)} kg` });
  if (view.sleepMinutes !== null) pieces.push({ label: 'Sleep', value: formatSleep(view.sleepMinutes) });
  if (view.sleepQuality !== null) pieces.push({ label: 'Sleep quality', value: `${view.sleepQuality}/5` });
  if (view.mood !== null) pieces.push({ label: 'Mood', value: `${view.mood}/5` });
  if (view.soreness !== null) pieces.push({ label: 'Soreness', value: `${view.soreness}/10` });
  return pieces;
}

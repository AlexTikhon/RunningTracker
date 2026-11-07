import { addLocalDays, parseLocalDate, type WeeklyInsightView } from '@running-tracker/contracts';

// Pure helpers of the weekly Insights panel (ADR-0076): the weeks it offers and the words it uses for a state.

/** How many weeks the picker offers, the current one included. */
export const INSIGHT_WEEKS_OFFERED = 8;

/** The Monday of the week (Monday to Sunday) that contains `localDate`. */
export function mondayOf(localDate: string): string {
  const parsed = parseLocalDate(localDate);
  if (parsed === null) throw new RangeError(`Not a calendar date: ${localDate}`);
  const weekday = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay(); // 0 = Sunday
  return addLocalDays(localDate, -((weekday + 6) % 7));
}

/** "2 Nov – 8 Nov 2026": the week's days in words, independent of the viewer's zone. */
export function formatWeek(weekStart: string): string {
  const format = (date: string, withYear: boolean) => {
    const parsed = parseLocalDate(date);
    if (parsed === null) return date;
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
      ...(withYear ? { year: 'numeric' } : {}),
    }).format(new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)));
  };
  return `${format(weekStart, false)} – ${format(addLocalDays(weekStart, 6), true)}`;
}

/** The weeks the picker offers, the current one first. */
export function recentWeeks(today: string, count = INSIGHT_WEEKS_OFFERED): { label: string; weekStart: string }[] {
  const current = mondayOf(today);
  return Array.from({ length: count }, (_, index) => {
    const weekStart = addLocalDays(current, -7 * index);
    return { label: `${index === 0 ? 'This week' : index === 1 ? 'Last week' : 'Week'}: ${formatWeek(weekStart)}`, weekStart };
  });
}

/** One sentence for a status that has no output, never model text. */
export function statusSentence(view: WeeklyInsightView): string {
  switch (view.status) {
    case 'queued':
      return 'Queued: generation starts as soon as the local model is free.';
    case 'running':
      return 'Generating: the local model is writing the text.';
    case 'generation_failed':
      return view.failureReason === 'schema_invalid'
        ? 'The model did not return a valid answer, so nothing was kept.'
        : 'The model did not answer in time or could not be reached, so nothing was kept.';
    case 'failed_grounding':
      return "The model's answer did not match your numbers exactly, so it was discarded.";
    case 'failed_safety':
      return "The model's answer was discarded by the safety checks.";
    case 'interrupted':
      return view.failureReason === 'persistence_failed'
        ? 'Generation finished but the result could not be saved.'
        : 'Generation was interrupted (the server stopped or restarted) before it finished.';
    case 'ready':
      return 'Ready.';
    default:
      return 'Unknown state.';
  }
}

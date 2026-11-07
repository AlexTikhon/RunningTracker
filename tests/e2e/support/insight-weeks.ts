// Weeks of the weekly-insight end-to-end tests (ADR-0076). The API runs on the real clock, so the weeks are computed
// from "now" in the browser zone the tests use, by the same rule as the panel's week picker (Monday to Sunday).

export const INSIGHT_ZONE = 'Europe/Warsaw';

export function dateIn(zone: string, instantMs: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { day: '2-digit', month: '2-digit', timeZone: zone, year: 'numeric' }).formatToParts(
    new Date(instantMs),
  );
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${field('year')}-${field('month')}-${field('day')}`;
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The Monday `weeksAgo` weeks before the current week, in INSIGHT_ZONE. */
export function mondayWeeksAgo(weeksAgo: number, nowMs = Date.now()): string {
  const today = dateIn(INSIGHT_ZONE, nowMs);
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addDays(today, -((weekday + 6) % 7) - 7 * weeksAgo);
}

/** The week for which the suite's FakeProvider fails every attempt (WEEKLY_INSIGHTS_FAKE_FAILING_WEEKS). */
export const failingInsightWeek = (nowMs = Date.now()) => mondayWeeksAgo(3, nowMs);

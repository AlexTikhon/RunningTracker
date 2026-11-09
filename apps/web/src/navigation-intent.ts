import type { DailyTrendsMetric } from '@running-tracker/contracts';

import type { TodayAction } from './daily-overview.js';

// Which view the application shows, and the two small pieces of navigation state Today needs (ADR-0082). No routing
// library: the view is component state, as before. Both pieces carry the scope (session generation, person and
// organization) they were made in and are ignored under any other scope, so a date chosen or an editor intent made by
// one person or organization never opens for another, and nothing survives a sign-out.

export type AppView = 'activity' | 'archive' | 'checkin' | 'coach' | 'meals' | 'runner' | 'today' | 'trends';

/** Opens an existing editor on one date: one of the Check-in tab's two editors, or the Meal log (ADR-0083). */
export interface EditorIntent {
  localDate: string;
  scope: string;
  section: 'check-in' | 'meals' | 'movement';
}

/** The date Today shows, or the end date of the Trends range (ADR-0084), kept while the person navigates elsewhere and back. */
export interface KeptDate {
  localDate: string;
  scope: string;
}

/** The series Trends shows, kept like its range. */
export interface KeptMetric {
  metric: DailyTrendsMetric;
  scope: string;
}

/**
 * The view a Today action opens and, for the editors, the intent that carries the selected date. The Trends action
 * carries the selected date as the end of its range instead (`trendsEnd`); it opens no editor.
 */
export function navigationFor(action: TodayAction, scope: string): { editor: EditorIntent | null; trendsEnd?: KeptDate; view: AppView } {
  switch (action.kind) {
    case 'check-in':
      return { editor: { localDate: action.localDate, scope, section: 'check-in' }, view: 'checkin' };
    case 'movement':
      return { editor: { localDate: action.localDate, scope, section: 'movement' }, view: 'checkin' };
    case 'meals':
      return { editor: { localDate: action.localDate, scope, section: 'meals' }, view: 'meals' };
    case 'activities':
      return { editor: null, view: 'activity' };
    case 'runner':
      return { editor: null, view: 'runner' };
    case 'trends':
      return { editor: null, trendsEnd: { localDate: action.localDate, scope }, view: 'trends' };
  }
}

/** The intent for the Check-in tab only (its two editors); a Meal log intent is not one. */
export function checkInIntentOf(intent: EditorIntent | null): { localDate: string; section: 'check-in' | 'movement' } | undefined {
  if (intent === null || intent.section === 'meals') return undefined;
  return { localDate: intent.localDate, section: intent.section };
}

/** The date a Meal log intent opens, or null. */
export function mealIntentDateOf(intent: EditorIntent | null): string | null {
  return intent !== null && intent.section === 'meals' ? intent.localDate : null;
}

/** The intent or kept date, only under the scope it was made in. */
export function inScope<Value extends { scope: string }>(value: Value | null, scope: string | null): Value | null {
  return value !== null && scope !== null && value.scope === scope ? value : null;
}

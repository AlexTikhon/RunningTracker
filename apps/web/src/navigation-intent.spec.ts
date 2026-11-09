import { describe, expect, it } from 'vitest';

import { checkInIntentOf, inScope, mealIntentDateOf, navigationFor } from './navigation-intent.js';

const SCOPE = '0|user-a|org-a';

describe('Today navigation', () => {
  it('opens the check-in and movement editors of the Check-in tab with the selected date', () => {
    expect(navigationFor({ kind: 'check-in', localDate: '2026-11-05' }, SCOPE)).toEqual({
      editor: { localDate: '2026-11-05', scope: SCOPE, section: 'check-in' },
      view: 'checkin',
    });
    expect(navigationFor({ kind: 'movement', localDate: '2026-11-04' }, SCOPE)).toEqual({
      editor: { localDate: '2026-11-04', scope: SCOPE, section: 'movement' },
      view: 'checkin',
    });
  });

  it('opens the Meal log on the selected date, and keeps its intent away from the Check-in tab (ADR-0083)', () => {
    const next = navigationFor({ kind: 'meals', localDate: '2026-11-03' }, SCOPE);
    expect(next).toEqual({ editor: { localDate: '2026-11-03', scope: SCOPE, section: 'meals' }, view: 'meals' });
    expect(checkInIntentOf(next.editor)).toBeUndefined();
    expect(mealIntentDateOf(next.editor)).toBe('2026-11-03');
    const checkIn = navigationFor({ kind: 'movement', localDate: '2026-11-04' }, SCOPE).editor;
    expect(checkInIntentOf(checkIn)).toEqual({ localDate: '2026-11-04', section: 'movement' });
    expect(mealIntentDateOf(checkIn)).toBeNull();
    expect(checkInIntentOf(null)).toBeUndefined();
    expect(mealIntentDateOf(null)).toBeNull();
  });

  it('opens Trends with the selected date as the end of its range, scoped, and without an editor intent (ADR-0084)', () => {
    const next = navigationFor({ kind: 'trends', localDate: '2026-11-02' }, SCOPE);
    expect(next).toEqual({ editor: null, trendsEnd: { localDate: '2026-11-02', scope: SCOPE }, view: 'trends' });
    expect(inScope(next.trendsEnd ?? null, SCOPE)).toEqual({ localDate: '2026-11-02', scope: SCOPE });
    expect(inScope(next.trendsEnd ?? null, '0|user-b|org-a')).toBeNull();
    expect(inScope({ metric: 'steps' as const, scope: SCOPE }, '0|user-a|org-b')).toBeNull();
  });

  it('opens Activities and Runner without any intent', () => {
    expect(navigationFor({ kind: 'activities' }, SCOPE)).toEqual({ editor: null, view: 'activity' });
    expect(navigationFor({ kind: 'runner' }, SCOPE)).toEqual({ editor: null, view: 'runner' });
  });

  it('applies an intent or a kept date only under the scope it was made in', () => {
    const kept = { localDate: '2026-11-05', scope: SCOPE };
    expect(inScope(kept, SCOPE)).toBe(kept);
    for (const other of ['1|user-a|org-a', '0|user-b|org-a', '0|user-a|org-b', null]) {
      expect(inScope(kept, other), String(other)).toBeNull();
    }
    expect(inScope(null, SCOPE)).toBeNull();
  });
});

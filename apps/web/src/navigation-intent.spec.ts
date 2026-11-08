import { describe, expect, it } from 'vitest';

import { inScope, navigationFor } from './navigation-intent.js';

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

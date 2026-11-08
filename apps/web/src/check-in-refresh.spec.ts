import { describe, expect, it } from 'vitest';

import { afterConfirmedChange, initialRefreshKeys } from './check-in-refresh.js';

describe('check-in tab refresh keys', () => {
  it('a check-in change refreshes the review and the AI insight', () => {
    expect(afterConfirmedChange(initialRefreshKeys, 'check-in')).toEqual({ insight: 1, review: 1 });
  });

  it('a movement change refreshes the review only, never the AI insight', () => {
    let keys = initialRefreshKeys;
    for (let index = 0; index < 3; index += 1) keys = afterConfirmedChange(keys, 'movement');
    expect(keys).toEqual({ insight: 0, review: 3 });
    expect(afterConfirmedChange(keys, 'check-in')).toEqual({ insight: 1, review: 4 });
  });

  it('never mutates the previous keys', () => {
    const before = { insight: 2, review: 5 };
    afterConfirmedChange(before, 'movement');
    afterConfirmedChange(before, 'check-in');
    expect(before).toEqual({ insight: 2, review: 5 });
  });
});

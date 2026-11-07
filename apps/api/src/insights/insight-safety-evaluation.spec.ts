import { describe, expect, it } from 'vitest';

import { safetyFixtures, safetyProbes, type SafetyFixture } from './safety-fixtures.js';
import { screenText } from './safety.js';

// Measures the heuristic prose screen on the labelled set (ADR-0076). The expected numbers are what the screen scored
// when it was written; a change of rules that moves them must update them here, visibly. A false positive is a safe
// sentence refused (the answer is discarded and the person sees a failed insight); a miss is an unsafe sentence
// accepted (it would be shown). The held-out half was not used to tune the rules.

interface Score {
  falsePositives: string[];
  misses: string[];
  total: number;
}

function score(split: SafetyFixture['split']): Score {
  const selected = safetyFixtures.filter((fixture) => fixture.split === split);
  const flagged = (fixture: SafetyFixture) => screenText(fixture.text, fixture.extreme).length > 0;
  return {
    falsePositives: selected.filter((fixture) => fixture.label === 'safe' && flagged(fixture)).map((fixture) => fixture.id),
    misses: selected.filter((fixture) => fixture.label === 'unsafe' && !flagged(fixture)).map((fixture) => fixture.id),
    total: selected.length,
  };
}

describe('weekly insight safety screen, labelled evaluation set', () => {
  it('has 20 safe and 20 unsafe sentences, half of each held out', () => {
    const count = (label: string, split: string) =>
      safetyFixtures.filter((fixture) => fixture.label === label && fixture.split === split).length;
    expect([count('safe', 'tune'), count('safe', 'heldout'), count('unsafe', 'tune'), count('unsafe', 'heldout')]).toEqual([
      10, 10, 10, 10,
    ]);
    expect(new Set(safetyFixtures.map((fixture) => fixture.id)).size).toBe(safetyFixtures.length);
  });

  it('tuning half: the recorded false positives and misses', () => {
    expect(score('tune')).toEqual({ falsePositives: [], misses: [], total: 20 });
  });

  it('held-out half: the recorded false positives and misses', () => {
    expect(score('heldout')).toEqual({ falsePositives: [], misses: [], total: 20 });
  });

  it('adversarial probes written after the rules: the recorded failures (known limitations, not tuned away)', () => {
    const flagged = (fixture: SafetyFixture) => screenText(fixture.text, fixture.extreme).length > 0;
    expect({
      falsePositives: safetyProbes.filter((fixture) => fixture.label === 'safe' && flagged(fixture)).map((fixture) => fixture.id),
      misses: safetyProbes.filter((fixture) => fixture.label === 'unsafe' && !flagged(fixture)).map((fixture) => fixture.id),
    }).toEqual({
      // Refused although safe: a negation scoped over a help verb in an encouraging sense ("don't wait to talk to a
      // doctor"), a negated dismissal ("never ignore pain"), and "did not see" next to a symptom word.
      falsePositives: ['probe-safe-1', 'probe-safe-2', 'probe-safe-3'],
      // Accepted although unsafe: every probe. Help avoidance without a listed negation ("leave the doctor out of it",
      // "isn't a reason to call anyone"), dismissal without a listed verb ("pretend the pain isn't there"), and
      // topics outside the lexicon (alcohol, skipping meals). This is why extreme weeks do not rely on this screen.
      misses: ['probe-unsafe-1', 'probe-unsafe-2', 'probe-unsafe-3', 'probe-unsafe-4', 'probe-unsafe-5'],
    });
  });
});

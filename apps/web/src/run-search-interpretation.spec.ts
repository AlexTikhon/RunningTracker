import {
  runSearchClarificationReasonSchema,
  runSearchUnsupportedReasonSchema,
  type RunSearchProposedFilters,
} from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import {
  describeClarification,
  describeInterpretationError,
  describeUnsupported,
  INTERPRETATION_DISCLOSURE,
  INTERPRETATION_TEXT_MAX,
  interpretationTextProblem,
  proposalToDraft,
} from './run-search-interpretation.js';
import { validateDraft } from './run-search.js';

const filters = (overrides: Partial<RunSearchProposedFilters> = {}): RunSearchProposedFilters => ({
  distanceUnit: 'km',
  maxDistance: null,
  minDistance: '5',
  period: { kind: 'preset', preset: 'previous-month' },
  sort: 'longest',
  timeZone: 'Europe/Warsaw',
  ...overrides,
});

describe('proposalToDraft', () => {
  it('replaces the whole draft, preset period included', () => {
    expect(proposalToDraft(filters())).toEqual({
      maxDistance: '',
      minDistance: '5',
      period: { kind: 'preset', preset: 'previous-month' },
      sort: 'longest',
      unit: 'km',
    });
  });

  it('carries explicit dates and a unit of miles', () => {
    expect(
      proposalToDraft(
        filters({
          distanceUnit: 'mi',
          maxDistance: '13.1',
          minDistance: '3',
          period: { fromDate: '2026-03-01', kind: 'dates', toDate: '2026-03-31' },
          sort: 'shortest',
        }),
      ),
    ).toEqual({
      maxDistance: '13.1',
      minDistance: '3',
      period: { fromDate: '2026-03-01', kind: 'dates', toDate: '2026-03-31' },
      sort: 'shortest',
      unit: 'mi',
    });
  });

  it('uses kilometres, the form default, when there is no bound', () => {
    const draft = proposalToDraft(filters({ distanceUnit: null, minDistance: null }));
    expect(draft).toMatchObject({ maxDistance: '', minDistance: '', unit: 'km' });
  });

  it('always yields a draft the form itself accepts', () => {
    for (const proposal of [
      filters(),
      filters({ distanceUnit: null, minDistance: null }),
      filters({ distanceUnit: 'mi', maxDistance: '10', minDistance: '0.5' }),
      filters({ period: { fromDate: '2026-03-01', kind: 'dates', toDate: '2026-03-31' } }),
    ]) {
      expect(validateDraft(proposalToDraft(proposal), 'Europe/Warsaw').ok).toBe(true);
    }
  });
});

describe('deterministic wording', () => {
  it('has a sentence for every clarification reason and none is empty or shared', () => {
    const sentences = runSearchClarificationReasonSchema.options.map(describeClarification);
    for (const sentence of sentences) {
      expect(sentence.length).toBeGreaterThan(20);
    }
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('has a sentence for every unsupported reason and none is empty or shared', () => {
    const sentences = runSearchUnsupportedReasonSchema.options.map(describeUnsupported);
    for (const sentence of sentences) {
      expect(sentence.length).toBeGreaterThan(20);
    }
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('explains the strict boundary and offers an inclusive wording without applying it', () => {
    const text = describeClarification('distance_boundary_strict');
    expect(text).toMatch(/include/iu);
    expect(text).toMatch(/at least/iu);
    expect(text).toMatch(/at most/iu);
  });

  it('tells the person that the text goes to OpenAI and what else does not', () => {
    expect(INTERPRETATION_DISCLOSURE).toMatch(/OpenAI/u);
    expect(INTERPRETATION_DISCLOSURE).toMatch(/text you enter/iu);
    expect(INTERPRETATION_DISCLOSURE).toMatch(/address|private/iu);
  });

  it.each([
    ['disabled', 'The filters below still work'],
    ['rate_limited', 'try again'],
    ['in_progress', 'still'],
    ['busy', 'busy'],
    ['timeout', 'too long'],
    ['failed', 'could not'],
    ['access', 'access'],
    ['network', 'connection'],
  ] as const)('words the %s failure and keeps manual search in view', (kind, fragment) => {
    const text = describeInterpretationError(kind, null);
    expect(text.toLowerCase()).toContain(fragment.toLowerCase());
  });

  it('puts the waiting time in a rate limit message', () => {
    expect(describeInterpretationError('rate_limited', 42_000)).toContain('42 seconds');
    expect(describeInterpretationError('rate_limited', 1_000)).toContain('1 second');
  });
});

describe('interpretationTextProblem', () => {
  it('accepts a sentence in either language', () => {
    expect(interpretationTextProblem('Runs of at least 5 km last month')).toBeNull();
    expect(interpretationTextProblem('Пробежки не менее 5 км за прошлый месяц')).toBeNull();
  });

  it('refuses empty text and text over the limit rather than cutting it', () => {
    expect(interpretationTextProblem('   ')).toMatch(/describe/iu);
    expect(interpretationTextProblem('x'.repeat(INTERPRETATION_TEXT_MAX + 1))).toMatch(
      new RegExp(String(INTERPRETATION_TEXT_MAX), 'u'),
    );
    expect(interpretationTextProblem('x'.repeat(INTERPRETATION_TEXT_MAX))).toBeNull();
  });
});

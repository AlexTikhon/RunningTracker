import { describe, expect, it } from 'vitest';

import {
  emptyMealDraft,
  formatNutritionNumber,
  mealDraftFromView,
  mealsSummary,
  mealTotalRows,
  nutritionInputLabel,
  sameMealDetails,
  summarizeMeal,
  validateMealDraft,
  type MealDraft,
} from './meal-log.js';

const draft = (patch: Partial<MealDraft>): MealDraft => ({ ...emptyMealDraft, title: 'Soup', ...patch });
const view = {
  carbohydrateG: null,
  createdAt: '2026-11-06T08:00:00.000Z',
  energyKcal: 0,
  fatG: 12.5,
  localDate: '2026-11-06',
  mealId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  mealType: 'snack' as const,
  proteinG: 1061.1,
  source: 'manual' as const,
  timeZone: 'Europe/Warsaw',
  title: 'Yoghurt',
  updatedAt: '2026-11-06T08:00:00.000Z',
};

describe('meal draft validation', () => {
  it('accepts a title-only entry: every value empty is not recorded (null), never zero', () => {
    expect(validateMealDraft(draft({}))).toEqual({
      details: { carbohydrateG: null, energyKcal: null, fatG: null, mealType: 'lunch', proteinG: null, title: 'Soup' },
      ok: true,
    });
  });

  it('keeps a typed 0 as a recorded zero, accepts a comma as the decimal separator and trims the title', () => {
    expect(validateMealDraft(draft({ energyKcal: '0', fatG: '12,5', proteinG: ' 30.2 ', title: '  Soup  ' }))).toMatchObject({
      details: { energyKcal: 0, fatG: 12.5, proteinG: 30.2, title: 'Soup' },
      ok: true,
    });
  });

  it('refuses a blank or too long title, two decimals, negative, non-numeric and out-of-range values, naming each problem', () => {
    expect(validateMealDraft(draft({ title: '   ' }))).toEqual({ errors: ['Enter a short title, for example "Porridge with berries".'], ok: false });
    expect(validateMealDraft(draft({ title: 'x'.repeat(121) }))).toEqual({ errors: ['The title can be at most 120 characters.'], ok: false });
    // 120 emoji are 120 characters, as the server counts them.
    expect(validateMealDraft(draft({ title: '🍓'.repeat(120) })).ok).toBe(true);
    const result = validateMealDraft(draft({ carbohydrateG: '2000.1', energyKcal: '12.55', fatG: 'abc', proteinG: '-1' }));
    expect(result).toEqual({
      errors: [
        'Food energy must be from 0 to 20,000 kcal, with at most one decimal.',
        'Protein must be from 0 to 2,000 g, with at most one decimal.',
        'Carbohydrate must be from 0 to 2,000 g, with at most one decimal.',
        'Fat must be from 0 to 2,000 g, with at most one decimal.',
      ],
      ok: false,
    });
    expect(validateMealDraft(draft({ energyKcal: '20000', proteinG: '2000' })).ok).toBe(true);
    expect(validateMealDraft(draft({ energyKcal: '1e3' })).ok).toBe(false);
  });

  it('round-trips a stored entry through the draft, so saving it unchanged sends the same details', () => {
    const roundTrip = validateMealDraft(mealDraftFromView(view));
    expect(roundTrip).toEqual({
      details: { carbohydrateG: null, energyKcal: 0, fatG: 12.5, mealType: 'snack', proteinG: 1061.1, title: 'Yoghurt' },
      ok: true,
    });
    if (!roundTrip.ok) throw new Error('unreachable');
    expect(sameMealDetails(roundTrip.details, { ...roundTrip.details })).toBe(true);
    expect(sameMealDetails(roundTrip.details, { ...roundTrip.details, energyKcal: null })).toBe(false);
    expect(sameMealDetails(roundTrip.details, { ...roundTrip.details, title: 'yoghurt' })).toBe(false);
  });
});

describe('meal presentation', () => {
  it('labels inputs with units and shows unknown values as not recorded, never zero', () => {
    expect(nutritionInputLabel('energyKcal')).toBe('Food energy (kcal)');
    expect(nutritionInputLabel('carbohydrateG')).toBe('Carbohydrate (g)');
    expect(summarizeMeal(view)).toEqual([
      { label: 'Food energy', value: '0 kcal' },
      { label: 'Protein', value: '1,061.1 g' },
      { label: 'Carbohydrate', value: 'Not recorded' },
      { label: 'Fat', value: '12.5 g' },
    ]);
    expect(formatNutritionNumber(20_000)).toBe('20,000');
    expect(formatNutritionNumber(0.1)).toBe('0.1');
  });

  it('summarizes the day: entries logged, and one total per metric with its own coverage', () => {
    const none = { recordedEntries: 0, total: null };
    expect(mealsSummary({ count: 0 })).toBe('No meal or snack logged for this day.');
    expect(mealsSummary({ count: 1 })).toBe('1 entry logged for this day.');
    expect(mealTotalRows({ carbohydrateG: none, count: 0, energyKcal: none, fatG: none, proteinG: none, source: 'manual' })).toEqual([]);
    expect(
      mealTotalRows({
        carbohydrateG: { recordedEntries: 3, total: 0 },
        count: 3,
        energyKcal: { recordedEntries: 2, total: 1061.1 },
        fatG: none,
        proteinG: { recordedEntries: 1, total: 30.2 },
        source: 'manual',
      }),
    ).toEqual([
      {
        coverage: 'Recorded for 2 of 3 logged entries; 1 entry is unknown, so the total covers only the recorded entries.',
        label: 'Food energy recorded (kcal)',
        recorded: true,
        value: '1,061.1',
      },
      {
        coverage: 'Recorded for 1 of 3 logged entries; 2 entries are unknown, so the total covers only the recorded entry.',
        label: 'Protein recorded (g)',
        recorded: true,
        value: '30.2',
      },
      { coverage: 'Recorded for 3 of 3 logged entries.', label: 'Carbohydrate recorded (g)', recorded: true, value: '0' },
      { coverage: 'Not recorded for any of the 3 logged entries.', label: 'Fat recorded (g)', recorded: false, value: 'Not recorded' },
    ]);
  });
});

import { mealDraftProposalResponseSchema, type MealNutritionField } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { groundMealDraft, groundNutrient } from './meal-draft-grounding.js';
import type { MealDraftWireDraft, NutrientClaim } from './meal-draft-wire.js';

// Regressions for three confirmed grounding defects of ADR-0092 (2026-11-14): a per-portion qualifier lost at a comma or
// in a list, a minus sign hidden by whitespace or left out of the excerpt, and decimal text compared and range-checked
// only after a lossy Number conversion. Every case is an UNSAFE claim a model could make, checked against the text.

const claim = (value: string, evidence: string): NutrientClaim => ({ abstain: null, evidence, value });
const ground = (text: string, field: MealNutritionField, value: string, evidence: string) => groundNutrient(text, field, claim(value, evidence)).result;
const withheld = (reason: string) => ({ reason, status: 'withheld' });

describe('defect 1: a per-portion qualifier keeps its scope across commas, lists and sentences', () => {
  const yogurt = 'Yogurt. Nutrition per 100 g, 60 kcal, protein 4 g. I ate 200 g.';

  it('withholds the reproduction: "Nutrition per 100 g, 60 kcal, protein 4 g"', () => {
    expect(ground(yogurt, 'energyKcal', '60', '60 kcal')).toEqual(withheld('per_portion'));
    expect(ground(yogurt, 'proteinG', '4', 'protein 4 g')).toEqual(withheld('per_portion'));
  });

  it.each([
    // Qualifier BEFORE a list, in a heading, across line breaks and bullets.
    ['en heading list', 'Granola\nPer 100 g:\n• 450 kcal\n• protein 10 g\n• carbs 60 g\n• fat 18 g'],
    ['en label heading', 'Granola bar. Nutrition facts: 190 kcal, protein 4 g, carbs 29 g, fat 7 g.'],
    ['en per serving list', 'Cereal, per serving: 150 kcal, protein 3 g, carbohydrate 30 g, fat 2 g'],
    // Qualifier AFTER a list.
    ['en qualifier after list', 'Cheese: 350 kcal, protein 25 g, carbs 1 g, fat 27 g, all per 100 g'],
    ['en qualifier in a later sentence', 'Bread: 250 kcal, protein 9 g, carbs 49 g, fat 3 g. Values are per 100 g.'],
    // Russian, before and after.
    ['ru heading list', 'Творог. Пищевая ценность на 100 г: 120 ккал, белки 16 г, углеводы 3 г, жиры 5 г'],
    ['ru qualifier after list', 'Сыр: 350 ккал, белок 25 г, углеводы 1 г, жиры 27 г — это на 100 г'],
    ['ru per portion', 'Каша, на порцию: 200 ккал, белки 6 г, углеводы 35 г, жиры 4 г'],
  ])('withholds every field when the %s scopes the values', (_name, text) => {
    const values: Array<[MealNutritionField, RegExp]> = [
      ['energyKcal', /(\d+) ?(?:kcal|ккал)/u],
      ['proteinG', /(?:protein|белки|белок) (\d+) ?(?:g|г)/u],
      ['carbohydrateG', /(?:carbs|carbohydrate|углеводы) (\d+) ?(?:g|г)/u],
      ['fatG', /(?:fat|жиры) (\d+) ?(?:g|г)/u],
    ];
    for (const [field, pattern] of values) {
      const match = pattern.exec(text);
      if (match === null) continue;
      expect(ground(text, field, match[1]!, match[0]), `${field} in ${text}`).toEqual(withheld('per_portion'));
    }
  });

  it('does not treat a shorter model excerpt as the end of the qualifier', () => {
    const text = 'Muesli, per 100 g 370 kcal, protein 10 g';
    expect(ground(text, 'proteinG', '10', 'protein 10 g')).toEqual(withheld('per_portion'));
    expect(ground(text, 'energyKcal', '370', '370 kcal')).toEqual(withheld('per_portion'));
  });

  it('accepts explicitly stated whole-entry totals alongside per-100 g information, in EN and RU', () => {
    const en = 'Yogurt 200 g. Per 100 g: 60 kcal, protein 4 g. In total I ate 120 kcal, protein 8 g, carbs 9 g, fat 3 g.';
    expect(ground(en, 'energyKcal', '120', '120 kcal')).toEqual({ excerpt: '120 kcal', status: 'proposed', value: 120 });
    expect(ground(en, 'proteinG', '8', 'protein 8 g')).toMatchObject({ status: 'proposed', value: 8 });
    expect(ground(en, 'carbohydrateG', '9', 'carbs 9 g')).toMatchObject({ status: 'proposed', value: 9 });
    expect(ground(en, 'fatG', '3', 'fat 3 g')).toMatchObject({ status: 'proposed', value: 3 });
    // The per-100 g values stay withheld, and are not a conflict with the totals.
    expect(ground(en, 'energyKcal', '60', '60 kcal')).toEqual(withheld('per_portion'));
    const ru = 'Творог 200 г. На 100 г: 120 ккал, белки 16 г. Итого 240 ккал, белки 32 г.';
    expect(ground(ru, 'energyKcal', '240', '240 ккал')).toMatchObject({ status: 'proposed', value: 240 });
    expect(ground(ru, 'proteinG', '32', 'белки 32 г')).toMatchObject({ status: 'proposed', value: 32 });
    expect(ground(ru, 'proteinG', '16', 'белки 16 г')).toEqual(withheld('per_portion'));
  });

  it('does not let a total share a sentence with a qualifier, a nutrition-label "Total fat", or a value-less qualifier', () => {
    // Same sentence as the qualifier: the scope of "in total" cannot be established.
    expect(ground('Chicken (165 kcal per 100 g), I ate 330 kcal in total', 'energyKcal', '330', '330 kcal')).toEqual(withheld('per_portion'));
    // "Total fat" and "Total carbohydrate" are label lines, not whole-entry totals.
    const label = 'Crackers. Per 30 g: 130 kcal. Total fat 5 g. Total carbohydrate 20 g.';
    expect(ground(label, 'fatG', '5', 'fat 5 g')).toEqual(withheld('per_portion'));
    expect(ground(label, 'carbohydrateG', '20', 'carbohydrate 20 g')).toEqual(withheld('per_portion'));
    // A qualifier sentence with no values of its own may refer to any sentence, so no total escapes it.
    expect(ground('Values are per 100 g. Total 60 kcal.', 'energyKcal', '60', '60 kcal')).toEqual(withheld('per_portion'));
  });

  it('keeps conflict detection on the same scope', () => {
    // Two whole-entry totals that differ conflict; a per-portion value never conflicts with a total.
    expect(ground('Soup. Per 100 g: 50 kcal. In total 300 kcal. In total 350 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(withheld('conflicting'));
    expect(ground('Soup. Per 100 g: 50 kcal. In total 300 kcal.', 'energyKcal', '300', '300 kcal')).toMatchObject({ status: 'proposed', value: 300 });
    expect(ground('Суп. На 100 г: 50 ккал. Итого 300 ккал. Итого 350 ккал.', 'energyKcal', '350', '350 ккал')).toEqual(withheld('conflicting'));
    // Changed on purpose (second correction, 2026-11-14): these two cases expected `conflicting` and a proposed 300.
    // Beside "Per 100 g", a bare "Total" is what a label prints (a pack's total, not necessarily what was eaten), so it no
    // longer establishes whole-entry scope; the person's own summing phrase above does.
    expect(ground('Soup. Per 100 g: 50 kcal. Total 300 kcal. Total 350 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(withheld('per_portion'));
    expect(ground('Soup. Per 100 g: 50 kcal. Total 300 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(withheld('per_portion'));
  });

  it('still withholds negated, approximate and ranged values, also when the hedge is in another clause', () => {
    expect(ground('Soup. Total not 300 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(withheld('negated'));
    expect(ground('Soup, total 300-350 kcal', 'energyKcal', '350', '350 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('These are estimates, 500 kcal, protein 20 g', 'proteinG', '20', 'protein 20 g')).toEqual(withheld('ambiguous'));
    expect(ground('Примерно так: 500 ккал, белок 20 г', 'proteinG', '20', 'белок 20 г')).toEqual(withheld('ambiguous'));
    expect(ground('Roughly. 500 kcal.', 'energyKcal', '500', '500 kcal')).toEqual(withheld('ambiguous'));
  });

  it('keeps extracting plain whole-entry statements with no qualifier (positive controls)', () => {
    const text = 'Dinner: stew, 650 kcal, protein 40 g, carbs 55 g, fat 20 g';
    expect(ground(text, 'energyKcal', '650', '650 kcal')).toMatchObject({ status: 'proposed', value: 650 });
    expect(ground(text, 'proteinG', '40', 'protein 40 g')).toMatchObject({ status: 'proposed', value: 40 });
    expect(ground(text, 'carbohydrateG', '55', 'carbs 55 g')).toMatchObject({ status: 'proposed', value: 55 });
    expect(ground(text, 'fatG', '20', 'fat 20 g')).toMatchObject({ status: 'proposed', value: 20 });
    // Words that merely contain "по" or a date with a slash are not portion qualifiers.
    expect(ground('Суп по-домашнему, 300 ккал', 'energyKcal', '300', '300 ккал')).toMatchObject({ status: 'proposed', value: 300 });
    expect(ground('Ужин 14/11: рыба, 420 ккал', 'energyKcal', '420', '420 ккал')).toMatchObject({ status: 'proposed', value: 420 });
  });
});

describe('defect 2: a sign is read from the text before the magnitude is accepted', () => {
  it('withholds the reproductions with a spaced minus', () => {
    expect(ground('Soup, - 500 kcal', 'energyKcal', '500', '500 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Soup, - 5 g of protein', 'proteinG', '5', '5 g of protein')).toEqual(withheld('ambiguous'));
  });

  it.each([
    ['ASCII minus, adjacent', 'Soup, -500 kcal', 'energyKcal', '500', '500 kcal', 'outside_contract'],
    ['Unicode minus, adjacent', 'Soup, \u2212500 kcal', 'energyKcal', '500', '500 kcal', 'outside_contract'],
    ['Unicode minus, spaced', 'Soup, \u2212 500 kcal', 'energyKcal', '500', '500 kcal', 'ambiguous'],
    ['minus and a no-break space', 'Soup, -\u00A0500 kcal', 'energyKcal', '500', '500 kcal', 'ambiguous'],
    ['minus and a narrow no-break space', 'Soup, -\u202F500 kcal', 'energyKcal', '500', '500 kcal', 'ambiguous'],
    ['fullwidth minus', 'Soup, \uFF0D500 kcal', 'energyKcal', '500', '500 kcal', 'outside_contract'],
    ['carbohydrate', 'Rice, carbs - 40 g', 'carbohydrateG', '40', '40 g', 'ambiguous'],
    ['carbohydrate with the nutrient after', 'Rice, - 40 g carbs', 'carbohydrateG', '40', '40 g carbs', 'ambiguous'],
    ['fat, Russian', 'Салат, жиры: −3 г', 'fatG', '3', '3 г', 'outside_contract'],
    ['fat, Russian, nutrient after', 'Салат, −3 г жира', 'fatG', '3', '3 г жира', 'outside_contract'],
  ])('never turns a %s into a positive proposal', (_name, text, field, value, evidence, reason) => {
    expect(ground(text, field as MealNutritionField, value, evidence)).toEqual(withheld(reason));
  });

  it('reads the sign from the text even when the excerpt leaves it out, and also when the excerpt includes it', () => {
    expect(ground('Steak, protein -30 g', 'proteinG', '30', 'protein -30 g')).toEqual(withheld('outside_contract'));
    expect(ground('Steak, protein - 30 g', 'proteinG', '30', 'protein - 30 g')).toEqual(withheld('ambiguous'));
    expect(ground('Steak, protein − 30 g', 'proteinG', '-30', 'protein − 30 g')).toEqual(withheld('unverified'));
  });

  it('keeps ranges ambiguous, dashes as separators, and unsigned values positive', () => {
    expect(ground('Pasta, 500 - 600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Pasta, 500−600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Белки — 35 г, гречка', 'proteinG', '35', 'Белки — 35 г')).toMatchObject({ status: 'proposed', value: 35 });
    expect(ground('Soup – 300 kcal', 'energyKcal', '300', '300 kcal')).toMatchObject({ status: 'proposed', value: 300 });
    expect(ground('Soup, 300 kcal, fat 0 g', 'fatG', '0', 'fat 0 g')).toMatchObject({ status: 'proposed', value: 0 });
  });
});

describe('defect 3: decimal text is compared and validated exactly before any Number conversion', () => {
  const text = 'Soup, protein 12.5000000000000001 g';

  it('withholds the reproduction, whether the claim repeats the digits or rounds them', () => {
    expect(ground(text, 'proteinG', '12.5000000000000001', 'protein 12.5000000000000001 g')).toEqual(withheld('outside_contract'));
    expect(ground(text, 'proteinG', '12.5', 'protein 12.5000000000000001 g')).toEqual(withheld('unverified'));
  });

  it.each([
    ['energyKcal', 'Stew, 650.00000000000001 kcal', '650', '650.00000000000001 kcal'],
    ['carbohydrateG', 'Rice, carbs 40.04 g', '40', 'carbs 40.04 g'],
    ['fatG', 'Oil, fat 13.99999999999999999 g', '14', 'fat 13.99999999999999999 g'],
  ])('refuses a rounded claim for %s', (field, source, value, evidence) => {
    expect(ground(source, field as MealNutritionField, value, evidence)).toEqual(withheld('unverified'));
  });

  it('checks bounds on the exact value, including values Number would round down into range', () => {
    expect(ground('Feast, 20000.05 kcal', 'energyKcal', '20000.05', '20000.05 kcal')).toEqual(withheld('outside_contract'));
    expect(ground('Feast, 20000.1 kcal', 'energyKcal', '20000.1', '20000.1 kcal')).toEqual(withheld('outside_contract'));
    expect(ground('Feast, 20000 kcal', 'energyKcal', '20000', '20000 kcal')).toMatchObject({ status: 'proposed', value: 20000 });
    expect(ground('Oil, fat 2000.0000000000001 g', 'fatG', '2000.0000000000001', 'fat 2000.0000000000001 g')).toEqual(withheld('outside_contract'));
    expect(ground('Huge, protein 99999999999999999999 g', 'proteinG', '99999999999999999999', 'protein 99999999999999999999 g')).toEqual(withheld('outside_contract'));
  });

  it('accepts exact one-decimal values with either separator and trailing zeros (positive controls)', () => {
    expect(ground('Yogurt, protein 12.50 g', 'proteinG', '12.50', 'protein 12.50 g')).toMatchObject({ status: 'proposed', value: 12.5 });
    expect(ground('Yogurt, protein 12.50 g', 'proteinG', '12.5', 'protein 12.50 g')).toMatchObject({ status: 'proposed', value: 12.5 });
    expect(ground('Йогурт, белок 12,50 г', 'proteinG', '12,5', 'белок 12,50 г')).toMatchObject({ status: 'proposed', value: 12.5 });
    expect(ground('Rice, carbs 40.0 g', 'carbohydrateG', '40', 'carbs 40.0 g')).toMatchObject({ status: 'proposed', value: 40 });
    expect(ground('Tea, 0.0 kcal', 'energyKcal', '0', '0.0 kcal')).toMatchObject({ status: 'proposed', value: 0 });
    expect(ground('Oil, fat 007.5 g', 'fatG', '7.5', 'fat 007.5 g')).toMatchObject({ status: 'proposed', value: 7.5 });
    // Thousands notation stays ambiguous.
    expect(ground('Pizza, 1.200 kcal', 'energyKcal', '1200', '1.200 kcal')).toEqual(withheld('ambiguous'));
  });
});

describe('a grounded answer still fits the public response contract', () => {
  it('builds a valid mixed draft: totals proposed, per-portion values withheld', () => {
    const text = 'Lunch: yogurt bowl. Per 100 g: 60 kcal, protein 4 g. In total 180 kcal, protein 12.0 g, fat 0 g.';
    const answer: MealDraftWireDraft = {
      carbohydrateG: { abstain: 'not_stated', evidence: null, value: null },
      energyKcal: claim('180', '180 kcal'),
      fatG: claim('0', 'fat 0 g'),
      mealType: 'lunch',
      mealTypeEvidence: 'Lunch',
      outcome: 'draft',
      proteinG: claim('4', 'protein 4 g'),
      title: 'yogurt bowl',
    };
    const { proposal } = groundMealDraft(text, answer);
    expect(proposal).toMatchObject({
      nutrition: {
        energyKcal: { status: 'proposed', value: 180 },
        fatG: { status: 'proposed', value: 0 },
        proteinG: { reason: 'per_portion', status: 'withheld' },
      },
    });
    expect(mealDraftProposalResponseSchema.safeParse({ ...proposal, localDate: '2026-11-14', timeZone: 'Europe/Warsaw', version: 'meal-draft-1' }).success).toBe(true);
  });
});

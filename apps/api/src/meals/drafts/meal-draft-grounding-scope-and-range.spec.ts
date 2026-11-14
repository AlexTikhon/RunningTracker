import { mealDraftProposalResponseSchema, type MealNutritionField } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { groundMealDraft, groundNutrient } from './meal-draft-grounding.js';
import type { MealDraftWireDraft, NutrientClaim } from './meal-draft-wire.js';

// Regressions for two further confirmed grounding defects of ADR-0092 (second correction, 2026-11-14):
//   A. a nutrition label's "total" was taken as proof that a value is the amount eaten, so a label line escaped the
//      label's per-portion scope ("Nutrition facts per 100 g: 60 kcal. Total protein 4 g.");
//   B. a line break hid a range, because the range check looked only at the value's clause, which ends at the line break
//      ("Soup, 500 -\n600 kcal").
// Every claim below is schema-valid and UNSAFE unless marked as a positive control. Nothing here calls a model.

const claim = (value: string, evidence: string): NutrientClaim => ({ abstain: null, evidence, value });
const ground = (text: string, field: MealNutritionField, value: string, evidence: string) => groundNutrient(text, field, claim(value, evidence)).result;
const withheld = (reason: string) => ({ reason, status: 'withheld' });
const proposed = (value: number, excerpt: string) => ({ excerpt, status: 'proposed', value });

describe('defect A: a nutrition label\'s "total" never establishes the amount eaten', () => {
  it('withholds the three reproductions', () => {
    expect(ground('Yogurt. Nutrition facts per 100 g: 60 kcal. Total protein 4 g.', 'proteinG', '4', 'protein 4 g')).toEqual(withheld('per_portion'));
    expect(ground('Yogurt. Nutrition facts per 100 g: 60 kcal. Fat 4 g total.', 'fatG', '4', 'Fat 4 g')).toEqual(withheld('per_portion'));
    expect(ground('Yogurt. Nutrition facts per 100 g: 60 kcal. Total: fat 4 g.', 'fatG', '4', 'fat 4 g')).toEqual(withheld('per_portion'));
  });

  it('withholds them also when the excerpt includes the word "total"', () => {
    expect(ground('Yogurt. Nutrition facts per 100 g: 60 kcal. Total protein 4 g.', 'proteinG', '4', 'Total protein 4 g')).toEqual(withheld('per_portion'));
    expect(ground('Yogurt. Nutrition facts per 100 g: 60 kcal. Fat 4 g total.', 'fatG', '4', 'Fat 4 g total')).toEqual(withheld('per_portion'));
  });

  // Every field, every placement of the word, EN and RU: one rule, not a list of nutrients or word orders.
  const enHeading = 'Granola. Nutrition facts per 100 g: 450 kcal, protein 10 g.';
  const ruHeading = 'Гранола. Пищевая ценность на 100 г: 450 ккал, белки 10 г.';
  it.each([
    ['energy, total before', `${enHeading} Total 250 kcal.`, 'energyKcal', '250', '250 kcal'],
    ['energy, total after', `${enHeading} 250 kcal total.`, 'energyKcal', '250', '250 kcal'],
    ['energy, total with a colon', `${enHeading} Total: 250 kcal.`, 'energyKcal', '250', '250 kcal'],
    ['protein, total after', `${enHeading} Protein 12 g total.`, 'proteinG', '12', 'Protein 12 g'],
    ['protein, total with a colon', `${enHeading} Total: protein 12 g.`, 'proteinG', '12', 'protein 12 g'],
    ['carbohydrate, total before', `${enHeading} Total carbohydrate 60 g.`, 'carbohydrateG', '60', 'carbohydrate 60 g'],
    ['carbohydrate, nutrient after', `${enHeading} Total: 60 g carbs.`, 'carbohydrateG', '60', '60 g carbs'],
    ['fat, totals', `${enHeading} Totals: fat 18 g.`, 'fatG', '18', 'fat 18 g'],
    ['fat, overall', `${enHeading} Overall fat 18 g.`, 'fatG', '18', 'fat 18 g'],
    ['ru energy, всего before', `${ruHeading} Всего 250 ккал.`, 'energyKcal', '250', '250 ккал'],
    ['ru protein, всего after', `${ruHeading} Белки 12 г всего.`, 'proteinG', '12', 'Белки 12 г'],
    ['ru carbohydrate, всего with a colon', `${ruHeading} Всего: углеводы 60 г.`, 'carbohydrateG', '60', 'углеводы 60 г'],
    ['ru fat, nutrient after', `${ruHeading} Всего 18 г жиров.`, 'fatG', '18', '18 г жиров'],
    ['ru fat, целиком', `${ruHeading} Пачка целиком: жиры 18 г.`, 'fatG', '18', 'жиры 18 г'],
  ])('withholds the label line (%s)', (_name, text, field, value, evidence) => {
    expect(ground(text, field as MealNutritionField, value, evidence)).toEqual(withheld('per_portion'));
  });

  it('keeps the label context across line breaks and blank lines, where no sentence ends', () => {
    expect(ground('Yogurt\nNutrition facts per 100 g\n60 kcal\nTotal protein 4 g', 'proteinG', '4', 'protein 4 g')).toEqual(withheld('per_portion'));
    expect(ground('Yogurt\n\nPer 100 g:\n60 kcal\n\nIn total I ate 120 kcal', 'energyKcal', '120', '120 kcal')).toEqual(withheld('per_portion'));
    expect(ground('Crackers, per serving: 130 kcal.\nTotal protein 3 g.', 'proteinG', '3', 'protein 3 g')).toEqual(withheld('per_portion'));
    expect(ground('Bar, label: 190 kcal. Total protein 4 g.', 'proteinG', '4', 'protein 4 g')).toEqual(withheld('per_portion'));
  });

  it('withholds a summed sentence that also states a food quantity: the sum may be of the food, not of the nutrient', () => {
    expect(ground('Yogurt. Per 100 g: 60 kcal, protein 4 g. I ate 200 g in total, protein 8 g.', 'proteinG', '8', 'protein 8 g')).toEqual(withheld('per_portion'));
    expect(ground('Творог. На 100 г: 120 ккал. Итого съел 200 г, 240 ккал.', 'energyKcal', '240', '240 ккал')).toEqual(withheld('per_portion'));
  });

  it('proposes the totals the person states as eaten next to a label, and withholds the label\'s values (positive control)', () => {
    const text = 'Yogurt 200 g. Per 100 g: 60 kcal, protein 4 g. In total I ate 120 kcal, protein 8 g.';
    expect(ground(text, 'energyKcal', '120', '120 kcal')).toEqual(proposed(120, '120 kcal'));
    expect(ground(text, 'proteinG', '8', 'protein 8 g')).toEqual(proposed(8, 'protein 8 g'));
    expect(ground(text, 'energyKcal', '60', '60 kcal')).toEqual(withheld('per_portion'));
    expect(ground(text, 'proteinG', '4', 'protein 4 g')).toEqual(withheld('per_portion'));

    const label = 'Yogurt 200 g. Nutrition facts per 100 g: 60 kcal, total fat 2 g. Altogether I ate 120 kcal, fat 4 g, carbs 9,5 g.';
    expect(ground(label, 'fatG', '4', 'fat 4 g')).toEqual(proposed(4, 'fat 4 g'));
    expect(ground(label, 'carbohydrateG', '9,5', 'carbs 9,5 g')).toEqual(proposed(9.5, 'carbs 9,5 g'));
    expect(ground(label, 'fatG', '2', 'fat 2 g')).toEqual(withheld('per_portion'));

    const ru = 'Йогурт 200 г. Пищевая ценность на 100 г: 60 ккал, белки 4 г. В сумме съел 120 ккал, белки 8,0 г, жиры 0 г.';
    expect(ground(ru, 'energyKcal', '120', '120 ккал')).toEqual(proposed(120, '120 ккал'));
    expect(ground(ru, 'proteinG', '8', 'белки 8,0 г')).toEqual(proposed(8, 'белки 8,0 г'));
    expect(ground(ru, 'fatG', '0', 'жиры 0 г')).toEqual(proposed(0, 'жиры 0 г'));
    expect(ground(ru, 'proteinG', '4', 'белки 4 г')).toEqual(withheld('per_portion'));
  });

  it('keeps ordinary whole-entry descriptions without portion or label context (positive controls)', () => {
    expect(ground('Yogurt, total protein 4 g', 'proteinG', '4', 'protein 4 g')).toEqual(proposed(4, 'protein 4 g'));
    expect(ground('Yogurt bowl. Fat 4 g total.', 'fatG', '4', 'Fat 4 g')).toEqual(proposed(4, 'Fat 4 g'));
    const stew = 'Dinner: stew. Total: 650 kcal, protein 40 g, carbs 55.0 g, fat 0 g.';
    expect(ground(stew, 'energyKcal', '650', '650 kcal')).toEqual(proposed(650, '650 kcal'));
    expect(ground(stew, 'carbohydrateG', '55', 'carbs 55.0 g')).toEqual(proposed(55, 'carbs 55.0 g'));
    expect(ground(stew, 'fatG', '0', 'fat 0 g')).toEqual(proposed(0, 'fat 0 g'));
    expect(ground('Каша, всего 310 ккал, белки 9,5 г', 'proteinG', '9,5', 'белки 9,5 г')).toEqual(proposed(9.5, 'белки 9,5 г'));
  });
});

describe('defect B: a range is read from the original text around the number, across line breaks', () => {
  it('withholds the two reproductions', () => {
    expect(ground('Soup, 500 -\n600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Soup, 500 to\n600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
  });

  it.each([
    ['ASCII hyphen', '-'],
    ['hyphen', '\u2010'],
    ['non-breaking hyphen', '\u2011'],
    ['figure dash', '\u2012'],
    ['en dash', '\u2013'],
    ['em dash', '\u2014'],
    ['minus sign', '\u2212'],
    ['small hyphen-minus', '\uFE63'],
    ['fullwidth hyphen-minus', '\uFF0D'],
    ['to', 'to'],
    ['or', 'or'],
    ['до', 'до'],
    ['или', 'или'],
  ])('withholds a range across a line break with %s, before or after the break', (_name, separator) => {
    for (const text of [`Soup, 500 ${separator}\n600 kcal`, `Soup, 500\n${separator} 600 kcal`, `Soup, 500 ${separator}\r\n600 kcal`, `Soup, 500\u00A0${separator}\n\u00A0600 kcal`]) {
      expect(ground(text, 'energyKcal', '600', '600 kcal'), JSON.stringify(text)).toEqual(withheld('ambiguous'));
    }
  });

  it('withholds Russian "от … до" and a range whose first endpoint repeats the unit', () => {
    expect(ground('Суп, от 500 до\n600 ккал', 'energyKcal', '600', '600 ккал')).toEqual(withheld('ambiguous'));
    expect(ground('Soup, 500 kcal –\n600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
  });

  it('checks the other endpoint after the number too (the claimed value is the lower end)', () => {
    expect(ground('Soup, 500 kcal to\n600', 'energyKcal', '500', '500 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Soup, 500 kcal -\n600 kcal', 'energyKcal', '500', '500 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Steak, protein 30 g –\n35', 'proteinG', '30', 'protein 30 g')).toEqual(withheld('ambiguous'));
    expect(ground('Calories: 650 -\n700', 'energyKcal', '650', 'Calories: 650')).toEqual(withheld('ambiguous'));
  });

  it.each([
    ['protein, hyphen', 'Soup, 5 -\n6 g protein', 'proteinG', '6', '6 g protein'],
    ['protein, to', 'Soup, 5 to\n6 g of protein', 'proteinG', '6', '6 g of protein'],
    ['carbohydrate, en dash', 'Rice, 40 –\n45 g carbs', 'carbohydrateG', '45', '45 g carbs'],
    ['fat, Russian до', 'Салат, 3 до\n5 г жира', 'fatG', '5', '5 г жира'],
    ['protein, Russian или', 'Рыба, 30 или\n35 г белка', 'proteinG', '35', '35 г белка'],
    ['fat, decimal comma endpoints', 'Oil, 4,5 -\n5,5 g fat', 'fatG', '5,5', '5,5 g fat'],
  ])('withholds a macronutrient range across a line break (%s)', (_name, text, field, value, evidence) => {
    expect(ground(text, field as MealNutritionField, value, evidence)).toEqual(withheld('ambiguous'));
  });

  it('does not join numbers of separate statements or of different units into a range (positive controls)', () => {
    expect(ground('Rice 150 g.\n— 600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(proposed(600, '600 kcal'));
    expect(ground('Soup 500 g;\n– 600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(proposed(600, '600 kcal'));
    expect(ground('Soup, 2 bowls.\nTo be exact, 600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(proposed(600, '600 kcal'));
    const mixed = 'Soup 300 kcal –\n5 g protein';
    expect(ground(mixed, 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
    expect(ground(mixed, 'proteinG', '5', '5 g protein')).toEqual(proposed(5, '5 g protein'));
    expect(ground('Milk 200 ml –\n120 kcal', 'energyKcal', '120', '120 kcal')).toEqual(proposed(120, '120 kcal'));
    // The other number states a different nutrient: two statements, not a range.
    expect(ground('Shake, protein 30 g\n– 5 g fat', 'fatG', '5', '5 g fat')).toEqual(proposed(5, '5 g fat'));
    expect(ground('Shake, protein 30 g\n– 5 g fat', 'proteinG', '30', 'protein 30 g')).toEqual(proposed(30, 'protein 30 g'));
    expect(ground('Soup – 300 kcal', 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
    expect(ground('Белки — 35 г, гречка', 'proteinG', '35', 'Белки — 35 г')).toEqual(proposed(35, 'Белки — 35 г'));
  });

  it('keeps unsigned values, zero, a decimal comma and trailing zeros on their own lines (positive controls)', () => {
    expect(ground('Soup\n600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(proposed(600, '600 kcal'));
    expect(ground('Tea\n0 kcal', 'energyKcal', '0', '0 kcal')).toEqual(proposed(0, '0 kcal'));
    expect(ground('Йогурт\nбелок 12,5 г', 'proteinG', '12,5', 'белок 12,5 г')).toEqual(proposed(12.5, 'белок 12,5 г'));
    expect(ground('Soup\n600.0 kcal\nfat 3.50 g', 'fatG', '3.5', 'fat 3.50 g')).toEqual(proposed(3.5, 'fat 3.50 g'));
  });

  it('keeps the earlier fixes: signs across whitespace and line breaks, exact decimals, precision and bounds', () => {
    expect(ground('Soup, -\n500 kcal', 'energyKcal', '500', '500 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Soup,\n-500 kcal', 'energyKcal', '500', '500 kcal')).toEqual(withheld('outside_contract'));
    expect(ground('Soup, - 500 kcal', 'energyKcal', '500', '500 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Soup\nprotein 12.5000000000000001 g', 'proteinG', '12.5', 'protein 12.5000000000000001 g')).toEqual(withheld('unverified'));
    expect(ground('Soup\nprotein 12.55 g', 'proteinG', '12.55', 'protein 12.55 g')).toEqual(withheld('outside_contract'));
    expect(ground('Feast\n20000.05 kcal', 'energyKcal', '20000.05', '20000.05 kcal')).toEqual(withheld('outside_contract'));
    expect(ground('Feast\n20000 kcal', 'energyKcal', '20000', '20000 kcal')).toEqual(proposed(20000, '20000 kcal'));
  });
});

describe('a grounded answer with both corrections still fits the public response contract', () => {
  it('builds a valid draft: label values and ranges withheld, stated totals proposed', () => {
    const text = 'Lunch: yogurt 200 g. Nutrition facts per 100 g: 60 kcal. Total protein 4 g.\nIn total I ate 120 kcal, 3 -\n4 g fat, carbs 9,50 g.';
    const answer: MealDraftWireDraft = {
      carbohydrateG: claim('9,5', 'carbs 9,50 g'),
      energyKcal: claim('120', '120 kcal'),
      fatG: claim('4', '4 g fat'),
      mealType: 'lunch',
      mealTypeEvidence: 'Lunch',
      outcome: 'draft',
      proteinG: claim('4', 'protein 4 g'),
      title: 'yogurt',
    };
    const { proposal } = groundMealDraft(text, answer);
    expect(proposal).toMatchObject({
      nutrition: {
        carbohydrateG: { status: 'proposed', value: 9.5 },
        energyKcal: { status: 'proposed', value: 120 },
        fatG: { reason: 'ambiguous', status: 'withheld' },
        proteinG: { reason: 'per_portion', status: 'withheld' },
      },
    });
    expect(mealDraftProposalResponseSchema.safeParse({ ...proposal, localDate: '2026-11-14', timeZone: 'Europe/Warsaw', version: 'meal-draft-1' }).success).toBe(true);
  });
});

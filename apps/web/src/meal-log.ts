import {
  createMealRequestSchema,
  MEAL_NUTRITION_FIELDS,
  MEAL_NUTRITION_MAX,
  MEAL_TITLE_MAX_LENGTH,
  MEAL_TYPES,
  type DailyOverviewMealMetric,
  type DailyOverviewMeals,
  type MealNutritionField,
  type MealSource,
  type MealType,
  type MealView,
  type UpdateMealRequest,
} from '@running-tracker/contracts';

// The Meal log (ADR-0083). Pure functions: every label and sentence the Meal log and the Today meal card show comes from
// here, so each state can be tested without a DOM. Every field of the form is the text the person typed; only a valid
// draft becomes a request, and the server checks the same rules again.
//
// Nutrition values are the person's totals for the whole entry. Empty and zero are different: an empty field is "not
// recorded" (unknown), "0" is a recorded zero. Nothing is estimated, looked up or judged, and food energy is never put
// next to active energy as a balance.

export const mealTypeLabels: Readonly<Record<MealType, string>> = {
  breakfast: 'Breakfast',
  dinner: 'Dinner',
  lunch: 'Lunch',
  other: 'Other',
  snack: 'Snack',
};

export const mealTypeOptions = MEAL_TYPES.map((type) => ({ label: mealTypeLabels[type], value: type }));

const units: Readonly<Record<MealNutritionField, 'g' | 'kcal'>> = {
  carbohydrateG: 'g',
  energyKcal: 'kcal',
  fatG: 'g',
  proteinG: 'g',
};

const names: Readonly<Record<MealNutritionField, string>> = {
  carbohydrateG: 'Carbohydrate',
  energyKcal: 'Food energy',
  fatG: 'Fat',
  proteinG: 'Protein',
};

/** The form label of a nutrition field, with its unit: "Food energy (kcal)", "Protein (g)". */
export function nutritionInputLabel(field: MealNutritionField): string {
  return `${names[field]} (${units[field]})`;
}

const grouping = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 0 });

/** A value with at most one decimal, exactly as stored, with digit grouping: "1,061.1", "0", "30.2". */
export function formatNutritionNumber(value: number): string {
  return grouping.format(value);
}

export function formatNutritionValue(field: MealNutritionField, value: number): string {
  return `${formatNutritionNumber(value)} ${units[field]}`;
}

const sourceLabels: Readonly<Record<MealSource, string>> = { manual: 'Manually entered' };

export function mealSourceLabel(source: MealSource): string {
  return sourceLabels[source];
}

export interface MealDraft {
  carbohydrateG: string;
  // Each value: digits, '.' or ',' as the decimal separator, at most one decimal; empty is "not recorded".
  energyKcal: string;
  fatG: string;
  mealType: MealType;
  proteinG: string;
  title: string;
}

/** The editable details of an entry, every value present (null for "not recorded"): the body of a PUT. */
export type MealDetails = Required<{ [Field in keyof UpdateMealRequest]: Exclude<UpdateMealRequest[Field], undefined> }>;

export type MealValidation = { errors: string[]; ok: false } | { details: MealDetails; ok: true };

export const emptyMealDraft: MealDraft = { carbohydrateG: '', energyKcal: '', fatG: '', mealType: 'lunch', proteinG: '', title: '' };

const valuePattern = /^\d{1,5}(?:[.,]\d)?$/u;

export function validateMealDraft(draft: MealDraft): MealValidation {
  const errors: string[] = [];
  const title = draft.title.trim();
  if (title === '') errors.push('Enter a short title, for example "Porridge with berries".');
  else if ([...title].length > MEAL_TITLE_MAX_LENGTH) errors.push(`The title can be at most ${MEAL_TITLE_MAX_LENGTH} characters.`);

  const values = {} as Record<MealNutritionField, number | null>;
  for (const field of MEAL_NUTRITION_FIELDS) {
    const text = draft[field].trim();
    if (text === '') {
      values[field] = null;
      continue;
    }
    const parsed = valuePattern.test(text) ? Number(text.replace(',', '.')) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed > MEAL_NUTRITION_MAX[field]) {
      errors.push(`${names[field]} must be from 0 to ${formatNutritionValue(field, MEAL_NUTRITION_MAX[field])}, with at most one decimal.`);
      values[field] = null;
    } else {
      values[field] = parsed;
    }
  }
  if (errors.length > 0) return { errors, ok: false };

  const details: MealDetails = { mealType: draft.mealType, title, ...values };
  // The contract is the authority: anything it refuses is shown rather than sent.
  const checked = createMealRequestSchema.safeParse({
    ...details,
    idempotencyKey: '00000000-0000-4000-8000-000000000000',
    localDate: '2000-01-01',
    timeZone: 'UTC',
  });
  if (!checked.success) return { errors: ['Check the title and the values and try again.'], ok: false };
  return { details, ok: true };
}

/** The draft that shows a stored entry, so saving it unchanged sends the same details again. */
export function mealDraftFromView(view: MealView): MealDraft {
  const text = (value: number | null) => (value === null ? '' : String(value));
  return {
    carbohydrateG: text(view.carbohydrateG),
    energyKcal: text(view.energyKcal),
    fatG: text(view.fatG),
    mealType: view.mealType,
    proteinG: text(view.proteinG),
    title: view.title,
  };
}

export function sameMealDetails(left: MealDetails, right: MealDetails): boolean {
  return left.mealType === right.mealType && left.title === right.title && MEAL_NUTRITION_FIELDS.every((field) => left[field] === right[field]);
}

export interface LabelledValue {
  label: string;
  value: string;
}

/** The values of one entry, each recorded or "Not recorded" (never shown as zero). */
export function summarizeMeal(view: MealView): LabelledValue[] {
  return MEAL_NUTRITION_FIELDS.map((field) => ({
    label: names[field],
    value: view[field] === null ? 'Not recorded' : formatNutritionValue(field, view[field]),
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// The Today meal card: the date's entries, the recorded totals and their coverage, metric by metric.

const totalLabels: Readonly<Record<MealNutritionField, string>> = {
  carbohydrateG: 'Carbohydrate recorded (g)',
  energyKcal: 'Food energy recorded (kcal)',
  fatG: 'Fat recorded (g)',
  proteinG: 'Protein recorded (g)',
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function mealsSummary(meals: Pick<DailyOverviewMeals, 'count'>): string {
  if (meals.count === 0) return 'No meal or snack logged for this day.';
  return `${plural(meals.count, 'entry', 'entries')} logged for this day.`;
}

export interface MealTotalRow extends LabelledValue {
  /** Which entries the total covers, and how many are unknown. */
  coverage: string;
  recorded: boolean;
}

function totalRow(field: MealNutritionField, metric: DailyOverviewMealMetric, count: number): MealTotalRow {
  if (metric.total === null) {
    return {
      coverage: `Not recorded for any of the ${plural(count, 'logged entry', 'logged entries')}.`,
      label: totalLabels[field],
      recorded: false,
      value: 'Not recorded',
    };
  }
  const unknown = count - metric.recordedEntries;
  const coverage =
    unknown === 0
      ? `Recorded for ${metric.recordedEntries} of ${plural(count, 'logged entry', 'logged entries')}.`
      : `Recorded for ${metric.recordedEntries} of ${plural(count, 'logged entry', 'logged entries')}; ${plural(unknown, 'entry is', 'entries are')} unknown, so the total covers only the recorded ${metric.recordedEntries === 1 ? 'entry' : 'entries'}.`;
  return { coverage, label: totalLabels[field], recorded: true, value: formatNutritionNumber(metric.total) };
}

/** One row per metric, in display order, each with its own coverage. Empty when no entry was logged. */
export function mealTotalRows(meals: DailyOverviewMeals): MealTotalRow[] {
  if (meals.count === 0) return [];
  return MEAL_NUTRITION_FIELDS.map((field) => totalRow(field, meals[field], meals.count));
}

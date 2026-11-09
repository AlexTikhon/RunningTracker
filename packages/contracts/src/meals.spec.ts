import { describe, expect, it } from 'vitest';

import {
  createMealRequestSchema,
  dailyActiveEnergyKcalSchema,
  hasAtMostOneDecimal,
  MEAL_ALREADY_SAVED,
  MEAL_ENERGY_KCAL_MAX,
  MEAL_LOCAL_DATE_MIN,
  MEAL_MACRONUTRIENT_G_MAX,
  MEAL_NOT_FOUND,
  MEAL_NUTRITION_FIELDS,
  MEAL_NUTRITION_MAX,
  MEAL_PAGE_DEFAULT,
  MEAL_PAGE_MAX,
  MEAL_TITLE_MAX_LENGTH,
  MEAL_TYPES,
  mealAlreadySavedDetailsSchema,
  mealCursorSchema,
  mealListQuerySchema,
  mealListResponseSchema,
  mealPathSchema,
  mealViewSchema,
  openApiDocument,
  putDailyMovementRequestSchema,
  updateMealRequestSchema,
} from './index.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const key = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const minimal = { idempotencyKey: key, localDate: '2026-10-05', mealType: 'lunch', timeZone: 'Europe/Warsaw', title: 'Soup' };
const view = {
  carbohydrateG: 40.5,
  createdAt: '2026-10-05T08:00:00.123Z',
  energyKcal: 512.5,
  fatG: 0,
  localDate: '2026-10-05',
  mealId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  mealType: 'lunch',
  proteinG: null,
  source: 'manual',
  timeZone: 'Europe/Warsaw',
  title: 'Soup',
  updatedAt: '2026-10-05T08:00:00.123Z',
};

const acceptsCreate = (body: unknown) => createMealRequestSchema.safeParse(body).success;
const acceptsUpdate = (body: unknown) => updateMealRequestSchema.safeParse(body).success;

describe('meal creation request', () => {
  it('accepts a title-only entry: every nutrition value is optional and unknown when omitted or null', () => {
    expect(createMealRequestSchema.parse(minimal)).toEqual(minimal);
    expect(acceptsCreate({ ...minimal, carbohydrateG: null, energyKcal: null, fatG: null, proteinG: null })).toBe(true);
  });

  it('accepts every value alone or together, a recorded zero included', () => {
    for (const field of MEAL_NUTRITION_FIELDS) {
      expect(acceptsCreate({ ...minimal, [field]: 0 })).toBe(true);
      expect(acceptsCreate({ ...minimal, [field]: 12.5 })).toBe(true);
    }
    const full = { ...minimal, carbohydrateG: 60, energyKcal: 650.5, fatG: 20.1, proteinG: 30 };
    expect(createMealRequestSchema.parse(full)).toEqual(full);
  });

  it('knows the five meal types and nothing else', () => {
    expect(MEAL_TYPES).toEqual(['breakfast', 'lunch', 'dinner', 'snack', 'other']);
    for (const mealType of MEAL_TYPES) expect(acceptsCreate({ ...minimal, mealType })).toBe(true);
    for (const mealType of ['brunch', 'Lunch', '', null, 3]) expect(acceptsCreate({ ...minimal, mealType })).toBe(false);
    expect(acceptsCreate({ ...minimal, mealType: undefined })).toBe(false);
  });

  it.each(MEAL_NUTRITION_FIELDS)('bounds %s to a finite, non-negative number up to its maximum with at most one decimal', (field) => {
    const max = MEAL_NUTRITION_MAX[field];
    for (const value of [0, 0.1, 1.1, 0.3, max - 0.1, max]) expect(acceptsCreate({ ...minimal, [field]: value })).toBe(true);
    for (const value of [-0.1, -1, max + 0.1, max + 1, 12.55, 0.05, 1e-7, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '12.5', true]) {
      expect(acceptsCreate({ ...minimal, [field]: value })).toBe(false);
    }
  });

  it('uses broad technical bounds: 20,000 kcal of food energy and 2,000 g of each macronutrient per entry', () => {
    expect(MEAL_ENERGY_KCAL_MAX).toBe(20_000);
    expect(MEAL_MACRONUTRIENT_G_MAX).toBe(2_000);
    expect(MEAL_NUTRITION_MAX).toEqual({ carbohydrateG: 2_000, energyKcal: 20_000, fatG: 2_000, proteinG: 2_000 });
  });

  it('stores -0 as 0 and keeps 12.50 and 12.5 as one number', () => {
    expect(createMealRequestSchema.parse({ ...minimal, energyKcal: -0 }).energyKcal).toBe(0);
    expect(Object.is(createMealRequestSchema.parse({ ...minimal, fatG: -0 }).fatG, 0)).toBe(true);
    expect(createMealRequestSchema.parse(JSON.parse('{"idempotencyKey":"' + key + '","localDate":"2026-10-05","mealType":"lunch","timeZone":"UTC","title":"x","energyKcal":12.50}'))).toMatchObject({
      energyKcal: 12.5,
    });
  });

  it('decides "one decimal" exactly as the movement contract does (the rule the database CHECKs state)', () => {
    for (const value of [0, 0.1, 0.2, 0.3, 1.1, 250, 412.5, 412.55, 412.49, 0.05, 1e-7, 19_999.9, 20_000]) {
      expect(hasAtMostOneDecimal(value)).toBe(dailyActiveEnergyKcalSchema.safeParse(value).success);
    }
  });

  it('requires a short, non-blank, well-formed title', () => {
    expect(MEAL_TITLE_MAX_LENGTH).toBe(120);
    for (const title of ['x', 'Porridge with berries', 'Śniadanie 🍓', 'a'.repeat(MEAL_TITLE_MAX_LENGTH), ' Leading space']) {
      expect(acceptsCreate({ ...minimal, title })).toBe(true);
    }
    for (const title of ['', ' ', '\t\n', '  ', 'a'.repeat(MEAL_TITLE_MAX_LENGTH + 1), 'nul\u0000inside', 'lone \ud800 surrogate', null, 42]) {
      expect(acceptsCreate({ ...minimal, title })).toBe(false);
    }
    // The length is in code points, as the database's char_length counts: 120 emoji (240 UTF-16 units) are accepted.
    expect(acceptsCreate({ ...minimal, title: '🍓'.repeat(MEAL_TITLE_MAX_LENGTH) })).toBe(true);
    expect(acceptsCreate({ ...minimal, title: '🍓'.repeat(MEAL_TITLE_MAX_LENGTH + 1) })).toBe(false);
  });

  it('takes a real date not before the check-in lower bound and an IANA zone', () => {
    expect(MEAL_LOCAL_DATE_MIN).toBe('2000-01-01');
    for (const localDate of ['2000-01-01', '2024-02-29']) expect(acceptsCreate({ ...minimal, localDate })).toBe(true);
    for (const localDate of ['1999-12-31', '2026-02-29', '2026-13-01', '2026-10-5', 'today', undefined]) {
      expect(acceptsCreate({ ...minimal, localDate })).toBe(false);
    }
    for (const timeZone of ['+01:00', 'CET-ish', '', undefined]) expect(acceptsCreate({ ...minimal, timeZone })).toBe(false);
  });

  it('requires a UUID idempotency key', () => {
    for (const idempotencyKey of [undefined, '', 'not-a-uuid', 42]) expect(acceptsCreate({ ...minimal, idempotencyKey })).toBe(false);
  });

  it('refuses an id, an owner, an organization, a source, timestamps, per-100 g fields or any other unknown field', () => {
    for (const extra of [
      { mealId: view.mealId },
      { id: view.mealId },
      { userId: orgId },
      { orgId },
      { source: 'manual' },
      { source: 'barcode' },
      { createdAt: view.createdAt },
      { energyKcalPer100g: 50 },
      { servings: 2 },
      { estimatedEnergyKcal: 300 },
      { sugarG: 5 },
    ]) {
      expect(acceptsCreate({ ...minimal, ...extra })).toBe(false);
    }
  });

  it('is not the movement contract: food energy is not active energy', () => {
    expect(putDailyMovementRequestSchema.safeParse({ energyKcal: 100, timeZone: 'UTC' }).success).toBe(false);
    expect(acceptsCreate({ ...minimal, activeEnergyKcal: 100 })).toBe(false);
  });
});

describe('meal update request', () => {
  it('replaces the editable fields only; a title-only replacement clears every value', () => {
    expect(updateMealRequestSchema.parse({ mealType: 'snack', title: 'Apple' })).toEqual({ mealType: 'snack', title: 'Apple' });
    expect(acceptsUpdate({ carbohydrateG: 1, energyKcal: 2, fatG: 0, mealType: 'other', proteinG: 0.5, title: 'x' })).toBe(true);
  });

  it('refuses a change of date, zone, identity, key, source or timestamps, and a missing type or title', () => {
    for (const extra of [
      { localDate: '2026-10-04' },
      { timeZone: 'UTC' },
      { mealId: view.mealId },
      { idempotencyKey: key },
      { source: 'manual' },
      { createdAt: view.createdAt },
      { updatedAt: view.updatedAt },
    ]) {
      expect(acceptsUpdate({ mealType: 'lunch', title: 'x', ...extra })).toBe(false);
    }
    expect(acceptsUpdate({ title: 'x' })).toBe(false);
    expect(acceptsUpdate({ mealType: 'lunch' })).toBe(false);
    expect(acceptsUpdate({ energyKcal: 412.55, mealType: 'lunch', title: 'x' })).toBe(false);
  });
});

describe('meal path, list and view', () => {
  it('takes UUIDs in the path', () => {
    expect(mealPathSchema.safeParse({ mealId: view.mealId, orgId }).success).toBe(true);
    expect(mealPathSchema.safeParse({ mealId: 'x', orgId }).success).toBe(false);
    expect(mealPathSchema.safeParse({ mealId: view.mealId, orgId, extra: '1' }).success).toBe(false);
  });

  it('lists one date with a bounded page and an optional cursor', () => {
    expect(MEAL_PAGE_DEFAULT).toBe(20);
    expect(MEAL_PAGE_MAX).toBe(50);
    expect(mealListQuerySchema.parse({ localDate: '2026-10-05' })).toEqual({ localDate: '2026-10-05' });
    expect(mealListQuerySchema.parse({ cursor: 'abc', limit: '50', localDate: '2026-10-05' })).toEqual({
      cursor: 'abc',
      limit: 50,
      localDate: '2026-10-05',
    });
    for (const query of [
      {},
      { localDate: '1999-12-31' },
      { localDate: '2026-10-05', limit: '0' },
      { localDate: '2026-10-05', limit: '51' },
      { localDate: '2026-10-05', limit: '1.5' },
      { localDate: '2026-10-05', limit: '-1' },
      { localDate: '2026-10-05', cursor: '' },
      { from: '2026-10-01', to: '2026-10-05' },
      { localDate: '2026-10-05', userId: orgId },
      { localDate: '2026-10-05', mealType: 'lunch' },
    ]) {
      expect(mealListQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it('describes a stored entry strictly, with server-owned manual provenance and unknown values as null', () => {
    expect(mealViewSchema.parse(view)).toEqual(view);
    const titleOnly = { ...view, carbohydrateG: null, energyKcal: null, fatG: null, proteinG: null };
    expect(mealViewSchema.parse(titleOnly)).toEqual(titleOnly);
    expect(mealViewSchema.safeParse({ ...view, source: 'barcode' }).success).toBe(false);
    expect(mealViewSchema.safeParse({ ...view, userId: orgId }).success).toBe(false);
    expect(mealViewSchema.safeParse({ ...view, idempotencyKey: key }).success).toBe(false);
    const withoutEnergy: Partial<typeof view> = { ...view };
    delete withoutEnergy.energyKcal;
    expect(mealViewSchema.safeParse(withoutEnergy).success).toBe(false);
  });

  it('bounds a page and documents the cursor content and the error codes', () => {
    expect(mealListResponseSchema.safeParse({ items: Array.from({ length: MEAL_PAGE_MAX }, () => view), nextCursor: null }).success).toBe(true);
    expect(mealListResponseSchema.safeParse({ items: Array.from({ length: MEAL_PAGE_MAX + 1 }, () => view), nextCursor: null }).success).toBe(false);
    const cursor = { context: 'a'.repeat(43), createdAt: '2026-10-05T08:00:00.123456Z', mealId: view.mealId, version: 1 };
    expect(mealCursorSchema.parse(cursor)).toEqual(cursor);
    expect(mealCursorSchema.safeParse({ ...cursor, createdAt: '2026-10-05T08:00:00.123Z' }).success).toBe(false);
    expect(mealCursorSchema.safeParse({ ...cursor, version: 2 }).success).toBe(false);
    expect(mealAlreadySavedDetailsSchema.parse({ mealId: view.mealId })).toEqual({ mealId: view.mealId });
    expect(MEAL_NOT_FOUND).toBe('MEAL_NOT_FOUND');
    expect(MEAL_ALREADY_SAVED).toBe('MEAL_ALREADY_SAVED');
  });
});

describe('meal OpenAPI operations', () => {
  it('documents the date list, the idempotent create and the three entry operations, with CSRF on mutations', () => {
    const list = openApiDocument.paths['/api/orgs/{orgId}/meals'];
    const item = openApiDocument.paths['/api/orgs/{orgId}/meals/{mealId}'];
    expect(Object.keys(list).sort()).toEqual(['get', 'post']);
    expect(Object.keys(item).sort()).toEqual(['delete', 'get', 'put']);
    expect(list.get.parameters).toEqual([
      { $ref: '#/components/parameters/OrgId' },
      { $ref: '#/components/parameters/MealLocalDate' },
      { $ref: '#/components/parameters/Limit50' },
      { $ref: '#/components/parameters/Cursor' },
    ]);
    for (const operation of [list.post, item.put, item.delete]) {
      expect(operation.parameters).toContainEqual({ $ref: '#/components/parameters/CsrfToken' });
      expect(operation.parameters).toContainEqual({ $ref: '#/components/parameters/Origin' });
    }
    expect(Object.keys(list.post.responses).sort()).toEqual(['200', '201', 'default']);
    expect(Object.keys(item.put.responses).sort()).toEqual(['200', 'default']);
    expect(Object.keys(item.delete.responses).sort()).toEqual(['204', 'default']);
    const schemas = openApiDocument.components.schemas;
    for (const name of ['CreateMealRequest', 'UpdateMealRequest', 'MealView', 'MealListResponse'] as const) expect(schemas[name]).toBeDefined();
    // A request cannot carry a source, an owner or an id; the view names the only source.
    for (const request of [schemas.CreateMealRequest, schemas.UpdateMealRequest]) {
      expect(JSON.stringify(request)).not.toMatch(/"(source|userId|orgId|mealId)"/u);
    }
    expect(JSON.stringify(schemas.UpdateMealRequest)).not.toMatch(/"(localDate|timeZone|idempotencyKey)"/u);
    expect(JSON.stringify(schemas.MealView)).toContain('manual');
  });
});

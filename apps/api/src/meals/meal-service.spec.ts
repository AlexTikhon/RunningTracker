import { createMealRequestSchema } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { decodeMealCursor, encodeMealCursor, mealListContext } from './meal-cursor.js';
import { mealCreationDigest } from './meal-service.js';

const key = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const parse = (json: string) => createMealRequestSchema.parse(JSON.parse(json));
const base = `"idempotencyKey":"${key}","localDate":"2026-10-05","mealType":"lunch","timeZone":"Europe/Warsaw","title":"Soup"`;

describe('meal creation digest (ADR-0083)', () => {
  it('is 32 bytes and equal for requests that are equal after parsing: number spelling, -0, omitted vs null, field order', () => {
    const reference = mealCreationDigest(parse(`{${base},"energyKcal":12.5,"fatG":0}`), 'Europe/Warsaw');
    expect(reference).toHaveLength(32);
    for (const json of [
      `{${base},"energyKcal":12.50,"fatG":0}`,
      `{${base},"energyKcal":1.25e1,"fatG":-0}`,
      `{${base},"energyKcal":12.5,"fatG":0.0,"proteinG":null}`,
      `{"fatG":0,"energyKcal":12.5,${base},"carbohydrateG":null}`,
    ]) {
      expect(mealCreationDigest(parse(json), 'Europe/Warsaw').equals(reference)).toBe(true);
    }
  });

  it('differs for any change of date, zone, type, title or value, and between a zero and an unknown value', () => {
    const reference = mealCreationDigest(parse(`{${base},"energyKcal":12.5}`), 'Europe/Warsaw');
    const different = [
      mealCreationDigest(parse(`{${base},"energyKcal":12.5}`), 'UTC'),
      mealCreationDigest(parse(`{${base.replace('2026-10-05', '2026-10-04')},"energyKcal":12.5}`), 'Europe/Warsaw'),
      mealCreationDigest(parse(`{${base.replace('lunch', 'dinner')},"energyKcal":12.5}`), 'Europe/Warsaw'),
      mealCreationDigest(parse(`{${base.replace('Soup', 'soup')},"energyKcal":12.5}`), 'Europe/Warsaw'),
      mealCreationDigest(parse(`{${base.replace('Soup', 'Soup ')},"energyKcal":12.5}`), 'Europe/Warsaw'),
      mealCreationDigest(parse(`{${base},"energyKcal":12.6}`), 'Europe/Warsaw'),
      mealCreationDigest(parse(`{${base},"proteinG":12.5}`), 'Europe/Warsaw'),
      mealCreationDigest(parse(`{${base}}`), 'Europe/Warsaw'),
    ];
    for (const digest of different) expect(digest.equals(reference)).toBe(false);
    expect(mealCreationDigest(parse(`{${base},"fatG":0}`), 'UTC').equals(mealCreationDigest(parse(`{${base}}`), 'UTC'))).toBe(false);
  });

  it('does not depend on the idempotency key (the key finds the entry; the digest says whether the request is the same)', () => {
    const other = base.replace(key, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    expect(mealCreationDigest(parse(`{${base}}`), 'UTC').equals(mealCreationDigest(parse(`{${other}}`), 'UTC'))).toBe(true);
  });
});

describe('meal list cursor', () => {
  const owner = { localDate: '2026-10-05', orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
  const position = { createdAt: '2026-10-05T08:00:00.123456Z', mealId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };

  it('round-trips a position under the same person, organization and date', () => {
    const context = mealListContext(owner);
    expect(decodeMealCursor(encodeMealCursor({ ...position, context }), { context })).toEqual({ ...position, context, version: 1 });
  });

  it('is refused for another date, person or organization, and when tampered with', () => {
    const context = mealListContext(owner);
    const cursor = encodeMealCursor({ ...position, context });
    for (const other of [
      { ...owner, localDate: '2026-10-04' },
      { ...owner, userId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
      { ...owner, orgId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    ]) {
      expect(() => decodeMealCursor(cursor, { context: mealListContext(other) })).toThrow('The meal list cursor is invalid');
    }
    const tampered = Buffer.from(JSON.stringify({ ...position, context, createdAt: '2026-10-05T08:00:00.123Z', version: 1 })).toString('base64url');
    for (const bad of ['not base64!', tampered, Buffer.from('{').toString('base64url'), `${cursor}=`]) {
      expect(() => decodeMealCursor(bad, { context })).toThrow('The meal list cursor is invalid');
    }
  });
});

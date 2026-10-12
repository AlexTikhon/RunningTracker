import { describe, expect, it } from 'vitest';

import {
  isSupportedIanaTimeZone,
  openApiDocument,
  RUN_SEARCH_PAGE_MAX,
  runSearchCursorSchema,
  runSearchQuerySchema,
  runSearchResponseSchema,
} from './index.js';

const runId = 'ad32e5d8-dd0d-4652-b26a-026033120c33';
const base = { fromDate: '2026-10-01', timeZone: 'Europe/Warsaw', toDate: '2026-10-31' };
const contextDigest = 'A'.repeat(43);

function accepts(query: unknown): boolean {
  return runSearchQuerySchema.safeParse(query).success;
}

describe('run search query', () => {
  it('accepts an explicit range of local dates with a time zone', () => {
    expect(accepts(base)).toBe(true);
  });

  it('accepts a preset in place of dates', () => {
    expect(accepts({ preset: 'this-month', timeZone: 'UTC' })).toBe(true);
    expect(accepts({ preset: 'previous-month', timeZone: 'America/New_York' })).toBe(true);
  });

  it('accepts distance bounds that carry an explicit unit, sorting and paging', () => {
    expect(
      accepts({
        ...base,
        cursor: 'abc',
        distanceUnit: 'mi',
        limit: '25',
        maxDistance: '13.1',
        minDistance: '3',
        sort: 'longest',
      }),
    ).toBe(true);
  });

  it('transforms the page size to a number', () => {
    const parsed = runSearchQuerySchema.parse({ ...base, limit: '50' });
    expect(parsed.limit).toBe(50);
  });

  it.each(['userId', 'ownerId', 'user_id', 'orgId', 'status', 'from', 'to', 'offset'])(
    'rejects the unknown field %s, so an owner can never be named',
    (field) => {
      expect(accepts({ ...base, [field]: runId })).toBe(false);
    },
  );

  it('requires a time zone', () => {
    expect(accepts({ fromDate: base.fromDate, toDate: base.toDate })).toBe(false);
  });

  it.each([
    ['both a preset and dates', { ...base, preset: 'this-month' }],
    ['neither a preset nor dates', { timeZone: 'UTC' }],
    ['only a start date', { fromDate: '2026-10-01', timeZone: 'UTC' }],
    ['only an end date', { timeZone: 'UTC', toDate: '2026-10-01' }],
    ['a preset with one date', { fromDate: '2026-10-01', preset: 'this-month', timeZone: 'UTC' }],
    ['a start after the end', { fromDate: '2026-10-02', timeZone: 'UTC', toDate: '2026-10-01' }],
    ['a period of 367 days', { fromDate: '2026-01-01', timeZone: 'UTC', toDate: '2027-01-02' }],
    ['an impossible date', { fromDate: '2026-02-30', timeZone: 'UTC', toDate: '2026-03-01' }],
    ['a date with a time', { fromDate: '2026-10-01T00:00:00Z', timeZone: 'UTC', toDate: '2026-10-02' }],
    ['a date before 1970', { fromDate: '1969-12-31', timeZone: 'UTC', toDate: '2026-01-01' }],
    ['an unknown preset', { preset: 'last-year', timeZone: 'UTC' }],
  ])('rejects %s', (_label, query) => {
    expect(accepts(query)).toBe(false);
  });

  it('accepts exactly 366 inclusive days and a leap day', () => {
    expect(accepts({ fromDate: '2027-01-01', timeZone: 'UTC', toDate: '2027-12-31' })).toBe(true);
    expect(accepts({ fromDate: '2028-01-01', timeZone: 'UTC', toDate: '2028-12-31' })).toBe(true);
    expect(accepts({ fromDate: '2028-02-29', timeZone: 'UTC', toDate: '2028-02-29' })).toBe(true);
    expect(accepts({ fromDate: '2027-02-29', timeZone: 'UTC', toDate: '2027-03-01' })).toBe(false);
  });

  it.each(['+01:00', 'GMT+1', 'Mars/Olympus', '', ' Europe/Warsaw', 'Europe/Warsaw ', 'Europe//Warsaw', 'a'.repeat(80)])(
    'rejects the time zone %j as not an IANA name',
    (timeZone) => {
      expect(accepts({ ...base, timeZone })).toBe(false);
    },
  );

  it.each(['Europe/Warsaw', 'UTC', 'America/Argentina/Buenos_Aires', 'Australia/Lord_Howe', 'Etc/GMT+5'])(
    'accepts the time zone %s',
    (timeZone) => {
      expect(accepts({ ...base, timeZone })).toBe(true);
      expect(isSupportedIanaTimeZone(timeZone)).toBe(true);
    },
  );

  it('requires a unit with a bound and refuses a unit with no bound', () => {
    expect(accepts({ ...base, minDistance: '5' })).toBe(false);
    expect(accepts({ ...base, maxDistance: '5' })).toBe(false);
    expect(accepts({ ...base, distanceUnit: 'km' })).toBe(false);
    expect(accepts({ ...base, distanceUnit: 'km', minDistance: '5' })).toBe(true);
    expect(accepts({ ...base, distanceUnit: 'km', maxDistance: '5' })).toBe(true);
  });

  it.each(['yd', 'm', 'KM', 'kilometres'])('rejects the distance unit %s', (distanceUnit) => {
    expect(accepts({ ...base, distanceUnit, minDistance: '5' })).toBe(false);
  });

  it.each(['-1', 'NaN', 'Infinity', '1e3', '0x10', '', '.5', '5.', '1,5', '05', '1.2345', '100001', ' 5'])(
    'rejects the distance bound %j',
    (minDistance) => {
      expect(accepts({ ...base, distanceUnit: 'km', minDistance })).toBe(false);
    },
  );

  it('accepts zero, whole, fractional and the largest bound', () => {
    for (const minDistance of ['0', '5', '5.0', '10.25', '0.001', '100000']) {
      expect(accepts({ ...base, distanceUnit: 'km', minDistance })).toBe(true);
    }
  });

  it('rejects a minimum above the maximum and accepts equal bounds', () => {
    expect(accepts({ ...base, distanceUnit: 'km', maxDistance: '4.9', minDistance: '5' })).toBe(false);
    expect(accepts({ ...base, distanceUnit: 'km', maxDistance: '5.000', minDistance: '5' })).toBe(true);
  });

  it('bounds the page size', () => {
    expect(RUN_SEARCH_PAGE_MAX).toBe(50);
    expect(accepts({ ...base, limit: '51' })).toBe(false);
    expect(accepts({ ...base, limit: '0' })).toBe(false);
    expect(accepts({ ...base, limit: '-1' })).toBe(false);
    expect(accepts({ ...base, limit: '1.5' })).toBe(false);
  });

  it('rejects an unknown sort and a repeated (array) value', () => {
    expect(accepts({ ...base, sort: 'fastest' })).toBe(false);
    expect(accepts({ ...base, sort: ['newest', 'longest'] })).toBe(false);
    expect(accepts({ ...base, timeZone: ['UTC', 'UTC'] })).toBe(false);
  });
});

describe('run search response', () => {
  const item = {
    distanceM: 5_012.4,
    gpsQuality: 'good',
    observedDurationS: 1_800,
    runId,
    startedAt: '2026-10-05T06:00:00.000Z',
  };
  const applied = {
    from: '2026-09-30T22:00:00.000Z',
    fromDate: '2026-10-01',
    maxDistanceM: null,
    minDistanceM: 5_000,
    sort: 'newest',
    timeZone: 'Europe/Warsaw',
    to: '2026-10-31T23:00:00.000Z',
    toDate: '2026-10-31',
  };
  const response = { applied, items: [item], nextCursor: null, pendingSummaryCount: 2 };

  it('accepts a page', () => {
    expect(runSearchResponseSchema.safeParse(response).success).toBe(true);
  });

  it('is strict about unknown fields, an owner among them', () => {
    expect(runSearchResponseSchema.safeParse({ ...response, extra: 1 }).success).toBe(false);
    expect(
      runSearchResponseSchema.safeParse({ ...response, items: [{ ...item, userId: runId }] }).success,
    ).toBe(false);
  });

  it('refuses a quality label the server does not produce and a negative pending count', () => {
    expect(
      runSearchResponseSchema.safeParse({ ...response, items: [{ ...item, gpsQuality: 'fine' }] }).success,
    ).toBe(false);
    expect(runSearchResponseSchema.safeParse({ ...response, pendingSummaryCount: -1 }).success).toBe(false);
  });

  it('refuses more items than the page bound', () => {
    expect(
      runSearchResponseSchema.safeParse({
        ...response,
        items: Array.from({ length: RUN_SEARCH_PAGE_MAX + 1 }, () => item),
      }).success,
    ).toBe(false);
  });
});

describe('run search cursor', () => {
  const newest = {
    context: contextDigest,
    distanceKey: null,
    runId,
    sort: 'newest',
    startedAt: '2026-10-05T06:00:00.123456Z',
    version: 1,
  };

  it('accepts a newest-first position with no distance key', () => {
    expect(runSearchCursorSchema.safeParse(newest).success).toBe(true);
  });

  it('requires a distance key exactly for the distance sorts', () => {
    expect(runSearchCursorSchema.safeParse({ ...newest, sort: 'longest' }).success).toBe(false);
    expect(
      runSearchCursorSchema.safeParse({ ...newest, distanceKey: '5012.4', sort: 'longest' }).success,
    ).toBe(true);
    expect(
      runSearchCursorSchema.safeParse({ ...newest, distanceKey: '5012.4', sort: 'shortest' }).success,
    ).toBe(true);
    expect(runSearchCursorSchema.safeParse({ ...newest, distanceKey: '5012.4' }).success).toBe(false);
  });

  it('is strict about fields, version, context and the distance key shape', () => {
    expect(runSearchCursorSchema.safeParse({ ...newest, extra: true }).success).toBe(false);
    expect(runSearchCursorSchema.safeParse({ ...newest, version: 2 }).success).toBe(false);
    expect(runSearchCursorSchema.safeParse({ ...newest, context: 'short' }).success).toBe(false);
    expect(
      runSearchCursorSchema.safeParse({ ...newest, distanceKey: 'NaN', sort: 'longest' }).success,
    ).toBe(false);
    expect(
      runSearchCursorSchema.safeParse({ ...newest, distanceKey: '-1', sort: 'longest' }).success,
    ).toBe(false);
  });
});

describe('run search in the OpenAPI document', () => {
  const path = '/api/orgs/{orgId}/runs/search';

  it('documents the static search path as a GET with its own response', () => {
    const operation = (
      openApiDocument.paths as unknown as Record<string, { get?: { responses: Record<string, unknown> } }>
    )[path]?.get;
    expect(operation).toBeDefined();
    expect(Object.keys(operation?.responses ?? {})).toContain('200');
    expect(openApiDocument.components.schemas).toHaveProperty('RunSearchResponse');
  });

  it('lists every query parameter the schema accepts, and no owner', () => {
    const operation = (
      openApiDocument.paths as unknown as Record<string, { get?: { parameters: Array<{ name?: string; $ref?: string }> } }>
    )[path]?.get;
    const parameters = operation?.parameters ?? [];
    const names = parameters.map((parameter) => {
      if (parameter.name !== undefined) return parameter.name;
      const key = parameter.$ref?.split('/').at(-1) ?? '';
      const component = (openApiDocument.components.parameters as Record<string, { name: string }>)[key];
      return component?.name;
    });
    expect([...names].sort()).toEqual(
      [
        'cursor',
        'distanceUnit',
        'fromDate',
        'limit',
        'maxDistance',
        'minDistance',
        'orgId',
        'preset',
        'sort',
        'timeZone',
        'toDate',
      ].sort(),
    );
  });
});

import { describe, expect, it } from 'vitest';

import {
  openApiDocument,
  RUN_SEARCH_INTERPRETATION_TEXT_MAX,
  runSearchClarificationReasonSchema,
  runSearchInterpretationRequestSchema,
  runSearchInterpretationResponseSchema,
  runSearchUnsupportedReasonSchema,
} from './index.js';

const zone = 'Europe/Warsaw';

function acceptsRequest(value: unknown): boolean {
  return runSearchInterpretationRequestSchema.safeParse(value).success;
}

function acceptsResponse(value: unknown): boolean {
  return runSearchInterpretationResponseSchema.safeParse(value).success;
}

const presetFilters = {
  distanceUnit: 'km',
  maxDistance: null,
  minDistance: '5',
  period: { kind: 'preset', preset: 'previous-month' },
  sort: 'longest',
  timeZone: zone,
};

describe('run search interpretation request', () => {
  it('accepts text with a time zone', () => {
    expect(acceptsRequest({ text: 'Runs of at least 5 km last month', timeZone: zone })).toBe(true);
  });

  it('accepts Russian text', () => {
    expect(acceptsRequest({ text: 'Мои пробежки от 5 км за прошлый месяц', timeZone: zone })).toBe(true);
  });

  it.each([
    ['empty text', { text: '', timeZone: zone }],
    ['whitespace only text', { text: '   \n\t ', timeZone: zone }],
    ['text that is not a string', { text: 5, timeZone: zone }],
    ['no time zone', { text: 'runs' }],
    ['an offset in place of a zone', { text: 'runs', timeZone: '+01:00' }],
    ['an unknown field', { extra: true, text: 'runs', timeZone: zone }],
    ['a model name', { model: 'gpt-x', text: 'runs', timeZone: zone }],
    ['an owner', { text: 'runs', timeZone: zone, userId: 'ad32e5d8-dd0d-4652-b26a-026033120c33' }],
  ])('rejects %s', (_name, value) => {
    expect(acceptsRequest(value)).toBe(false);
  });

  it('accepts exactly the maximum length and rejects one more code point', () => {
    expect(acceptsRequest({ text: 'a'.repeat(RUN_SEARCH_INTERPRETATION_TEXT_MAX), timeZone: zone })).toBe(true);
    expect(acceptsRequest({ text: 'a'.repeat(RUN_SEARCH_INTERPRETATION_TEXT_MAX + 1), timeZone: zone })).toBe(false);
  });

  it('counts code points, not UTF-16 units, so a long Russian or emoji request is not penalised', () => {
    const emoji = '🏃'.repeat(RUN_SEARCH_INTERPRETATION_TEXT_MAX);
    expect(emoji.length).toBe(RUN_SEARCH_INTERPRETATION_TEXT_MAX * 2);
    expect(acceptsRequest({ text: emoji, timeZone: zone })).toBe(true);
  });

  it('rejects control characters but keeps line breaks and tabs', () => {
    expect(acceptsRequest({ text: 'runs\nlast month\tplease', timeZone: zone })).toBe(true);
    expect(acceptsRequest({ text: 'runs\u0000', timeZone: zone })).toBe(false);
    expect(acceptsRequest({ text: 'runs‮', timeZone: zone })).toBe(true);
    expect(acceptsRequest({ text: 'runs\u009f', timeZone: zone })).toBe(false);
  });
});

describe('run search interpretation response', () => {
  it('accepts a search with a preset period', () => {
    expect(acceptsResponse({ filters: presetFilters, outcome: 'search' })).toBe(true);
  });

  it('accepts a search with explicit dates and no distance bound', () => {
    expect(
      acceptsResponse({
        filters: {
          distanceUnit: null,
          maxDistance: null,
          minDistance: null,
          period: { fromDate: '2026-03-01', kind: 'dates', toDate: '2026-03-31' },
          sort: 'newest',
          timeZone: zone,
        },
        outcome: 'search',
      }),
    ).toBe(true);
  });

  it.each(['period_missing', 'distance_boundary_strict'])('accepts the clarification %s', (reason) => {
    expect(acceptsResponse({ outcome: 'clarify', reason })).toBe(true);
  });

  it.each(['location', 'not_a_run_search'])('accepts the unsupported reason %s', (reason) => {
    expect(acceptsResponse({ outcome: 'unsupported', reason })).toBe(true);
  });

  it('has bounded reason code lists', () => {
    expect(runSearchClarificationReasonSchema.options).toHaveLength(8);
    expect(runSearchUnsupportedReasonSchema.options).toHaveLength(10);
  });

  it.each([
    ['free text in place of a reason', { outcome: 'clarify', reason: 'Which month do you mean?' }],
    ['an unknown outcome', { outcome: 'answer', reason: 'location' }],
    ['a clarification that also carries filters', { filters: presetFilters, outcome: 'clarify', reason: 'period_missing' }],
    ['a search with a message', { filters: presetFilters, message: 'Here you go', outcome: 'search' }],
    ['an unsupported reason used as a clarification', { outcome: 'clarify', reason: 'location' }],
    ['a search with no filters', { outcome: 'search' }],
    ['a search that names an owner', { filters: { ...presetFilters, userId: 'x' }, outcome: 'search' }],
    ['a search that names a cursor', { filters: { ...presetFilters, cursor: 'abc' }, outcome: 'search' }],
    ['a search with sql', { filters: { ...presetFilters, sql: 'select 1' }, outcome: 'search' }],
    ['a distance with four decimals', { filters: { ...presetFilters, minDistance: '5.2345' }, outcome: 'search' }],
    ['a distance with a sign', { filters: { ...presetFilters, minDistance: '-5' }, outcome: 'search' }],
    ['a bound without a unit', { filters: { ...presetFilters, distanceUnit: null }, outcome: 'search' }],
    ['a unit without a bound', { filters: { ...presetFilters, minDistance: null }, outcome: 'search' }],
    ['a minimum above the maximum', { filters: { ...presetFilters, maxDistance: '4' }, outcome: 'search' }],
    [
      'a range that ends before it starts',
      {
        filters: { ...presetFilters, period: { fromDate: '2026-03-31', kind: 'dates', toDate: '2026-03-01' } },
        outcome: 'search',
      },
    ],
    [
      'a range longer than 366 days',
      {
        filters: { ...presetFilters, period: { fromDate: '2025-01-01', kind: 'dates', toDate: '2026-03-01' } },
        outcome: 'search',
      },
    ],
    [
      'a date that does not exist',
      {
        filters: { ...presetFilters, period: { fromDate: '2026-02-30', kind: 'dates', toDate: '2026-03-01' } },
        outcome: 'search',
      },
    ],
    ['a preset that is not supported', { filters: { ...presetFilters, period: { kind: 'preset', preset: 'last-week' } }, outcome: 'search' }],
    ['a sort that is not supported', { filters: { ...presetFilters, sort: 'fastest' }, outcome: 'search' }],
  ])('rejects %s', (_name, value) => {
    expect(acceptsResponse(value)).toBe(false);
  });
});

describe('run search interpretation in the OpenAPI document', () => {
  const path = openApiDocument.paths['/api/orgs/{orgId}/runs/search/interpretations'];

  it('describes a CSRF-protected POST', () => {
    expect(path.post.requestBody.required).toBe(true);
    const names = path.post.parameters.map((parameter) => parameter.$ref);
    expect(names).toContain('#/components/parameters/Origin');
    expect(names).toContain('#/components/parameters/CsrfToken');
  });

  it('declares both schemas', () => {
    expect(openApiDocument.components.schemas.RunSearchInterpretationRequest).toBeDefined();
    expect(openApiDocument.components.schemas.RunSearchInterpretationResponse).toBeDefined();
  });
});

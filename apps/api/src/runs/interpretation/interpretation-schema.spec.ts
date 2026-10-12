import {
  runSearchClarificationReasonSchema,
  runSearchUnsupportedReasonSchema,
} from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import {
  INTERPRETATION_SCHEMA_NAME,
  providerOutputJsonSchema,
  providerProposalSchema,
} from './interpretation-schema.js';

const search = {
  clarificationReason: null,
  distanceUnit: 'km',
  fromDate: null,
  maxDistance: null,
  minDistance: '5',
  outcome: 'search',
  period: 'previous-month',
  sort: 'longest',
  toDate: null,
  unsupportedReason: null,
};

function accepts(value: unknown): boolean {
  return providerProposalSchema.safeParse(value).success;
}

function walk(node: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    node.forEach((entry) => walk(entry, visit));
  } else if (node !== null && typeof node === 'object') {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((entry) => walk(entry, visit));
  }
}

describe('provider output JSON schema', () => {
  it('is a provider-compatible strict root object', () => {
    expect(INTERPRETATION_SCHEMA_NAME).toMatch(/^[a-zA-Z0-9_-]{1,64}$/u);
    expect(providerOutputJsonSchema.type).toBe('object');
    expect(providerOutputJsonSchema.additionalProperties).toBe(false);
  });

  it('lists every property as required, so optional values are nullable instead', () => {
    const properties = Object.keys(providerOutputJsonSchema.properties).sort();
    expect([...providerOutputJsonSchema.required].sort()).toEqual(properties);
  });

  it('uses no composition keyword anywhere, and no root anyOf', () => {
    walk(providerOutputJsonSchema, (node) => {
      for (const keyword of ['anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else', '$ref', '$defs']) {
        expect(node, keyword).not.toHaveProperty(keyword);
      }
    });
  });

  it('closes every object', () => {
    walk(providerOutputJsonSchema, (node) => {
      if (node.type === 'object') {
        expect(node.additionalProperties).toBe(false);
      }
    });
  });

  it('carries the contract\'s reason codes, so the two cannot drift', () => {
    const { properties } = providerOutputJsonSchema;
    expect(properties.clarificationReason.enum).toEqual([...runSearchClarificationReasonSchema.options, null]);
    expect(properties.unsupportedReason.enum).toEqual([...runSearchUnsupportedReasonSchema.options, null]);
    expect(properties.outcome.enum).toEqual(['search', 'clarify', 'unsupported']);
  });

  it('has no field that names a person, an organization, SQL, a cursor, a time zone or a count', () => {
    const names = Object.keys(providerOutputJsonSchema.properties).join(' ').toLowerCase();
    for (const forbidden of ['user', 'org', 'sql', 'cursor', 'zone', 'count', 'limit', 'run', 'status']) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });

  it('is JSON serializable and small', () => {
    expect(JSON.stringify(providerOutputJsonSchema).length).toBeLessThan(4_000);
  });
});

describe('provider proposal validation', () => {
  it('accepts a search', () => {
    expect(accepts(search)).toBe(true);
  });

  it('accepts explicit dates', () => {
    expect(accepts({ ...search, fromDate: '2026-03-01', period: 'dates', toDate: '2026-03-31' })).toBe(true);
  });

  it('accepts a clarification and an unsupported answer that carry only a reason', () => {
    const empty = { distanceUnit: null, fromDate: null, maxDistance: null, minDistance: null, period: null, sort: null, toDate: null };
    expect(accepts({ ...empty, clarificationReason: 'period_missing', outcome: 'clarify', unsupportedReason: null })).toBe(true);
    expect(accepts({ ...empty, clarificationReason: null, outcome: 'unsupported', unsupportedReason: 'location' })).toBe(true);
  });

  it.each([
    ['an unknown field', { ...search, userId: 'x' }],
    ['a missing field', Object.fromEntries(Object.entries(search).filter(([name]) => name !== 'sort'))],
    ['a time zone chosen by the model', { ...search, timeZone: 'Pacific/Kiritimati' }],
    ['SQL', { ...search, sql: 'select * from runs' }],
    ['an unknown outcome', { ...search, outcome: 'answer' }],
    ['a search without a period', { ...search, period: null }],
    ['a search that also carries a reason', { ...search, unsupportedReason: 'location' }],
    ['preset dates with a preset', { ...search, fromDate: '2026-03-01', toDate: '2026-03-31' }],
    ['dates without both ends', { ...search, fromDate: '2026-03-01', period: 'dates', toDate: null }],
    ['a clarification without a reason', { ...search, clarificationReason: null, outcome: 'clarify' }],
    ['a clarification that also proposes filters', { ...search, clarificationReason: 'period_missing', outcome: 'clarify' }],
    ['a clarification with an unsupported reason', { ...search, clarificationReason: 'location', outcome: 'clarify' }],
    ['an unsupported answer with a clarification reason', { ...search, clarificationReason: 'period_missing', outcome: 'unsupported', period: null, distanceUnit: null, minDistance: null, sort: null, unsupportedReason: 'period_missing' }],
    ['an unsupported answer that still proposes filters', { ...search, outcome: 'unsupported', unsupportedReason: 'location' }],
    ['free text as a reason', { ...search, clarificationReason: 'Which month?', outcome: 'clarify', period: null, distanceUnit: null, minDistance: null, sort: null }],
    ['a number in place of a decimal string', { ...search, minDistance: 5 }],
  ])('rejects %s', (_name, value) => {
    expect(accepts(value)).toBe(false);
  });
});

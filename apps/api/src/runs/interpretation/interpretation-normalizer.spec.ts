import { describe, expect, it } from 'vitest';

import {
  normalizeProposal,
  ProposalRejectedError,
} from './interpretation-normalizer.js';
import type { ProviderProposal } from './interpretation-schema.js';

// The server's "now" for presets: fixed, never from the model.
const now = new Date('2026-10-15T12:00:00.000Z');
const context = { now, timeZone: 'Europe/Warsaw' };

function search(overrides: Partial<ProviderProposal> = {}): ProviderProposal {
  return {
    clarificationReason: null,
    distanceUnit: null,
    fromDate: null,
    maxDistance: null,
    minDistance: null,
    outcome: 'search',
    period: 'this-month',
    sort: null,
    toDate: null,
    unsupportedReason: null,
    ...overrides,
  };
}

function rejects(proposal: ProviderProposal, ctx = context): void {
  expect(() => normalizeProposal(proposal, ctx)).toThrow(ProposalRejectedError);
}

describe('normalizing a provider proposal', () => {
  it('returns a complete replacement filter set with the server\'s time zone and the default sort', () => {
    expect(normalizeProposal(search(), context)).toEqual({
      filters: {
        distanceUnit: null,
        maxDistance: null,
        minDistance: null,
        period: { kind: 'preset', preset: 'this-month' },
        sort: 'newest',
        timeZone: 'Europe/Warsaw',
      },
      outcome: 'search',
    });
  });

  it('keeps a preset as a preset, for the server clock to resolve when the search runs', () => {
    const result = normalizeProposal(search({ period: 'previous-month' }), context);
    expect(result).toMatchObject({ filters: { period: { kind: 'preset', preset: 'previous-month' } } });
  });

  it('keeps explicit dates as dates and bounds with their unit', () => {
    const result = normalizeProposal(
      search({
        distanceUnit: 'mi',
        fromDate: '2026-03-01',
        maxDistance: '13.1',
        minDistance: '3',
        period: 'dates',
        sort: 'shortest',
        toDate: '2026-03-31',
      }),
      context,
    );
    expect(result).toEqual({
      filters: {
        distanceUnit: 'mi',
        maxDistance: '13.1',
        minDistance: '3',
        period: { fromDate: '2026-03-01', kind: 'dates', toDate: '2026-03-31' },
        sort: 'shortest',
        timeZone: 'Europe/Warsaw',
      },
      outcome: 'search',
    });
  });

  it.each([
    ['5.0', '5'],
    ['5.50', '5.5'],
    ['0.500', '0.5'],
    ['10.000', '10'],
    ['0', '0'],
    ['0.0', '0'],
    ['100000', '100000'],
    ['12.345', '12.345'],
  ])('writes the exact same decimal %s as %s', (given, expected) => {
    const result = normalizeProposal(search({ distanceUnit: 'km', minDistance: given }), context);
    expect(result).toMatchObject({ filters: { minDistance: expected } });
  });

  it.each(['5.2345', '5.', '.5', '05', '1e3', '-1', '+5', '5,5', '1 000', 'five', '100000.001', '100001', ''])(
    'never repairs the invalid or over-precise bound %j',
    (bound) => {
      rejects(search({ distanceUnit: 'km', minDistance: bound }));
    },
  );

  it('refuses a bound without a unit and drops a unit that has no bound', () => {
    rejects(search({ minDistance: '5' }));
    const result = normalizeProposal(search({ distanceUnit: 'mi' }), context);
    expect(result).toMatchObject({ filters: { distanceUnit: null, maxDistance: null, minDistance: null } });
  });

  it('refuses contradictory bounds instead of swapping or widening them', () => {
    rejects(search({ distanceUnit: 'km', maxDistance: '5', minDistance: '10' }));
  });

  it('accepts equal bounds', () => {
    const result = normalizeProposal(search({ distanceUnit: 'km', maxDistance: '10', minDistance: '10' }), context);
    expect(result).toMatchObject({ filters: { maxDistance: '10', minDistance: '10' } });
  });

  it.each([
    ['a range that ends before it starts', '2026-03-31', '2026-03-01'],
    ['a date that does not exist', '2026-02-30', '2026-03-05'],
    ['a range of more than 366 days', '2025-01-01', '2026-03-01'],
    ['a year before 1970', '1969-12-31', '1970-01-05'],
    ['a year after 2100', '2100-12-30', '2101-01-02'],
    ['an offset in place of a date', '2026-03-01T00:00:00+01:00', '2026-03-05'],
  ])('refuses %s', (_name, fromDate, toDate) => {
    rejects(search({ fromDate, period: 'dates', toDate }));
  });

  it('refuses dates that resolve to an empty interval in the zone (a skipped day)', () => {
    rejects(search({ fromDate: '2011-12-30', period: 'dates', toDate: '2011-12-30' }), {
      now,
      timeZone: 'Pacific/Apia',
    });
  });

  it('passes a clarification and an unsupported answer through as bounded codes', () => {
    const empty = { distanceUnit: null, fromDate: null, maxDistance: null, minDistance: null, period: null, sort: null, toDate: null };
    expect(
      normalizeProposal({ ...empty, clarificationReason: 'distance_boundary_strict', outcome: 'clarify', unsupportedReason: null }, context),
    ).toEqual({ outcome: 'clarify', reason: 'distance_boundary_strict' });
    expect(
      normalizeProposal({ ...empty, clarificationReason: null, outcome: 'unsupported', unsupportedReason: 'location' }, context),
    ).toEqual({ outcome: 'unsupported', reason: 'location' });
  });

  it('does not accept a zone from the proposal object even if one is smuggled in', () => {
    const smuggled = { ...search(), timeZone: 'Pacific/Kiritimati' } as unknown as ProviderProposal;
    const result = normalizeProposal(smuggled, context);
    expect(result).toMatchObject({ filters: { timeZone: 'Europe/Warsaw' } });
  });
});

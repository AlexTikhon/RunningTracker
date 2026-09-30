import { describe, expect, it } from 'vitest';

import { datasetInstantWarning } from './load-dataset-check.js';

const now = new Date('2026-09-30T12:00:00.000Z');

describe('datasetInstantWarning', () => {
  it('accepts a dataset seeded today or yesterday', () => {
    expect(datasetInstantWarning(new Date('2026-09-30T00:00:00.000Z'), now)).toBeNull();
    expect(datasetInstantWarning(new Date('2026-09-29T00:00:00.000Z'), now)).toBeNull();
  });

  it('warns when the archive window around now cannot cover the seeded runs', () => {
    expect(datasetInstantWarning(new Date('2026-09-26T00:00:00.000Z'), now)).toMatch(/older/u);
    expect(datasetInstantWarning(new Date('2032-03-01T00:00:00.000Z'), now)).toMatch(/future/u);
  });
});

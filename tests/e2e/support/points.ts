import { expect } from '@playwright/test';

// The server returns seq as a decimal string, so compare as bigint after sorting.
export function sortedSeqs(points: ReadonlyArray<{ seq: string }>): bigint[] {
  return points.map((point) => BigInt(point.seq)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Sorted seqs equal to one consecutive range prove both that none repeats and that none is missing in between.
export function expectUniqueAndGapFree(points: ReadonlyArray<{ seq: string }>): void {
  const seqs = sortedSeqs(points);
  expect(seqs.length).toBeGreaterThan(0);
  const first = seqs[0] ?? 0n;
  expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => first + BigInt(index)));
}

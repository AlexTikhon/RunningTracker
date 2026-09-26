import { pointInputSchema } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import {
  GPS_SCENARIO_NAMES,
  createGpsScenario,
  isGpsScenarioName,
} from './scenarios.js';

function flattenedUploadSequences(name: (typeof GPS_SCENARIO_NAMES)[number]): string[] {
  return createGpsScenario({ name, seed: 42 }).uploads.flatMap(({ points }) =>
    points.map(({ seq }) => seq),
  );
}

function distanceMeters(
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number },
): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(second.latitude - first.latitude);
  const longitudeDelta = radians(second.longitude - first.longitude);
  const firstLatitude = radians(first.latitude);
  const secondLatitude = radians(second.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

describe('GPS scenarios', () => {
  it('generates canonical deterministic points for every named scenario', () => {
    for (const name of GPS_SCENARIO_NAMES) {
      const first = createGpsScenario({ name, seed: 42 });
      const second = createGpsScenario({ name, seed: 42 });
      expect(second).toEqual(first);
      expect(first.captures).toHaveLength(6);
      for (const { point } of first.captures) {
        expect(pointInputSchema.parse(point)).toEqual(point);
      }
    }
    expect(createGpsScenario({ name: 'normal', seed: 43 })).not.toEqual(
      createGpsScenario({ name: 'normal', seed: 42 }),
    );
  });

  it('models an exact duplicate upload and an independently captured second batch', () => {
    const uploads = createGpsScenario({ name: 'duplicates', seed: 42 }).uploads;

    expect(uploads[1]!.batchId).toBe(uploads[0]!.batchId);
    expect(uploads[1]!.attempt).toBe(2);
    expect(uploads[1]!.points).toEqual(uploads[0]!.points);
    expect(uploads[2]!.points.map(({ seq }) => seq)).toEqual(['4', '5', '6']);
  });

  it('models the required 41 then 43 then 42 upload order', () => {
    expect(flattenedUploadSequences('reordered').slice(0, 3)).toEqual(['41', '43', '42']);
  });

  it('separates delayed transmission from regular measurement timestamps', () => {
    const scenario = createGpsScenario({ name: 'delayed-batch', seed: 42 });
    const recordedTimes = scenario.captures.map(({ point }) => Date.parse(point.recordedAt));

    expect(scenario.uploads[0]!.atMs).toBe(60_000);
    expect(recordedTimes[5]! - recordedTimes[0]!).toBe(10_000);
  });

  it('describes a post-commit response loss followed by an exact retry', () => {
    const [lost, retry] = createGpsScenario({ name: 'dropped-response', seed: 42 }).uploads;

    expect(lost!.response).toBe('drop-after-commit');
    expect(retry!.response).toBe('delivered');
    expect(retry!.batchId).toBe(lost!.batchId);
    expect(retry!.points).toEqual(lost!.points);
  });

  it('models device clock rollback independently of monotonic capture order', () => {
    const captures = createGpsScenario({ name: 'clock-jump', seed: 42 }).captures;

    expect(captures[3]!.atMs).toBeGreaterThan(captures[2]!.atMs);
    expect(Date.parse(captures[3]!.point.recordedAt)).toBeLessThan(
      Date.parse(captures[2]!.point.recordedAt),
    );
  });

  it('models a GPS spike surrounded by normal route points', () => {
    const captures = createGpsScenario({ name: 'gps-spike', seed: 42 }).captures;

    expect(distanceMeters(captures[2]!.point, captures[3]!.point)).toBeGreaterThan(5_000);
    expect(distanceMeters(captures[0]!.point, captures[1]!.point)).toBeLessThan(20);
  });

  it('validates scenario names, seeds, and start timestamps', () => {
    expect(isGpsScenarioName('normal')).toBe(true);
    expect(isGpsScenarioName('unknown')).toBe(false);
    expect(() =>
      createGpsScenario({ name: 'unknown' as never, seed: 1 }),
    ).toThrow('unknown GPS scenario');
    expect(() => createGpsScenario({ name: 'normal', seed: -1 })).toThrow('seed');
    expect(() => createGpsScenario({ name: 'normal', seed: 1, startAt: 'invalid' })).toThrow(
      'startAt',
    );
  });
});

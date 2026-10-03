import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadFixtureFile, loadFixtures } from './fixtures.js';
import { FIXTURE_DIR, REPOSITORY_ROOT } from './paths.js';
import { findPrivacyViolations } from './privacy-scan.js';
import { anchorTrace, REPLAY_ANCHOR } from './replay.js';
import { sanitizeRawTrace } from './sanitize.js';
import { parseSanitizedTraceText, serializeSanitizedTrace } from './trace-schema.js';
import { FAKE_PRIVATE_ORIGIN, FAKE_PRIVATE_START_MS, gpxFromRaw, rawFromLocal, straightLine } from './test-traces.js';
import { parseGpx } from './gpx.js';

const cleanText = serializeSanitizedTrace(
  sanitizeRawTrace(rawFromLocal(straightLine(30, 3, 1, 5)), { scenario: 'steady_run' }),
);

describe('privacy scan of a fixture text', () => {
  it('finds nothing in a freshly sanitized fixture', () => {
    expect(findPrivacyViolations(cleanText)).toEqual([]);
  });

  it('flags coordinate-like fields and precision', () => {
    expect(findPrivacyViolations('{"latitude": 52.5}')).not.toEqual([]);
    expect(findPrivacyViolations('{"lon": 21}')).not.toEqual([]);
    expect(findPrivacyViolations('{"xM": 52.1234567}')).not.toEqual([]);
  });

  it('flags absolute time in any common form', () => {
    expect(findPrivacyViolations('{"recordedAt": "2026-03-04T05:06:07Z"}')).not.toEqual([]);
    expect(findPrivacyViolations('{"x": "2026-03-04"}')).not.toEqual([]);
    expect(findPrivacyViolations('{"x": "05:06:07"}')).not.toEqual([]);
    expect(findPrivacyViolations(`{"elapsedMs": ${String(FAKE_PRIVATE_START_MS)}}`)).not.toEqual([]);
    expect(findPrivacyViolations('{"elapsedMs": 1700000000}')).not.toEqual([]);
    expect(findPrivacyViolations('{"timestamp": 5}')).not.toEqual([]);
  });

  it('flags device and identity fields', () => {
    for (const key of ['deviceId', 'serial', 'creator', 'author', 'name', 'email', 'filename', 'origin', 'anchor']) {
      expect(findPrivacyViolations(`{"${key}": "x"}`), key).not.toEqual([]);
    }
  });

  it('does not repeat the offending value in its findings', () => {
    const findings = findPrivacyViolations('{"xM": 52.1234567, "recordedAt": "2026-03-04T05:06:07Z"}').join(' ');
    expect(findings).not.toContain('52.1234567');
    expect(findings).not.toContain('2026-03-04');
  });
});

describe('what the sanitizer removes', () => {
  const raw = rawFromLocal(straightLine(30, 3, 1, 5));
  const text = serializeSanitizedTrace(sanitizeRawTrace(raw, { scenario: 'steady_run' }));

  it('keeps no original latitude or longitude, in any fixture field or in the serialized text', () => {
    const parsed = parseSanitizedTraceText(text) as unknown as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['points', 'scenario', 'schemaVersion', 'source']);
    for (const point of parsed.points as Record<string, unknown>[]) {
      expect(Object.keys(point).sort()).toEqual(['accuracyM', 'elapsedMs', 'xM', 'yM']);
    }
    for (const point of raw.points) {
      expect(text).not.toContain(point.latitude.toFixed(5));
      expect(text).not.toContain(point.longitude.toFixed(5));
    }
  });

  it('keeps no absolute time: elapsed time starts at zero and no date or epoch appears', () => {
    const parsed = parseSanitizedTraceText(text);
    expect(parsed.points[0]?.elapsedMs).toBe(0);
    expect(Math.max(...parsed.points.map((point) => point.elapsedMs))).toBeLessThan(1e9);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/u);
    expect(text).not.toContain(String(FAKE_PRIVATE_START_MS));
  });

  it('keeps no absolute coordinate origin: the first point is the local origin', () => {
    const parsed = parseSanitizedTraceText(text);
    expect(parsed.points[0]).toMatchObject({ elapsedMs: 0, xM: 0, yM: 0 });
  });

  it('keeps no source metadata from the export: names, device, creator, serial, waypoints, file name', () => {
    const exported = gpxFromRaw(raw);
    expect(exported).toContain('Jane Q. Example');
    expect(exported).toContain('SN-0042');
    const fixtureText = serializeSanitizedTrace(sanitizeRawTrace(parseGpx(exported), { scenario: 'steady_run' }));
    for (const metadata of ['Jane', 'Example', 'Fake Watch', 'SN-0042', 'creator', 'home loop', 'metadata', 'gpx']) {
      expect(fixtureText, metadata).not.toContain(metadata);
    }
  });

  it('replays from the sanitized geometry alone, away from the private origin', () => {
    // Nothing but the fixture text is used from here on: no raw trace, no origin.
    const points = anchorTrace(parseSanitizedTraceText(text));
    expect(points).toHaveLength(30);
    expect(points[0]?.latitude).toBeCloseTo(REPLAY_ANCHOR.latitude, 6);
    expect(Math.abs((points[0]?.latitude ?? 0) - FAKE_PRIVATE_ORIGIN.latitude)).toBeGreaterThan(30);
  });
});

describe('loading a fixture that fits the schema but carries private-looking data', () => {
  it('is refused, without repeating the value', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gps-privacy-'));
    try {
      const leaky = cleanText.replace(/("elapsedMs":1000,"xM":)[-\d.]+/u, (_match, prefix: string) => `${prefix}52.1234567`);
      expect(leaky).not.toBe(cleanText);
      writeFileSync(join(directory, 'leaky.trace.json'), leaky);
      expect(() => loadFixtureFile(join(directory, 'leaky.trace.json'))).toThrow(/looks like a geographic coordinate/u);
      try {
        loadFixtureFile(join(directory, 'leaky.trace.json'));
      } catch (error) {
        expect((error as Error).message).not.toContain('52.1234567');
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe('committed fixtures', () => {
  it('contain only sanitized fixtures and a README', () => {
    const entries = (() => {
      try {
        return readdirSync(FIXTURE_DIR);
      } catch {
        return [];
      }
    })();
    for (const entry of entries) {
      expect(entry, entry).toMatch(/^(?:[a-z0-9][a-z0-9_-]*\.trace\.json|README\.md)$/u);
    }
  });

  it('pass the strict schema, are written canonically and show no privacy finding', () => {
    for (const fixture of loadFixtures()) {
      expect(findPrivacyViolations(fixture.text), fixture.name).toEqual([]);
      expect(serializeSanitizedTrace(fixture.trace), `${fixture.name} is not in canonical form`).toBe(fixture.text);
      expect(fixture.trace.source, fixture.name).toBe('real-device-sanitized');
    }
  });
});

const gitAvailable = spawnSync('git', ['--version']).status === 0;

describe.skipIf(!gitAvailable)('git protection of raw exports', () => {
  const git = (...args: string[]) => spawnSync('git', args, { cwd: REPOSITORY_ROOT, encoding: 'utf8' });
  const ignored = (path: string) => git('check-ignore', '-q', '--', path).status === 0;

  it('ignores everything under the private raw directory and raw GPS formats anywhere', () => {
    for (const path of [
      '.local/gps-traces/raw/morning.gpx',
      '.local/gps-traces/raw/anything.json',
      '.local/gps-traces/raw/export.csv',
      '.local/gps-traces/raw/watch.fit',
      'morning.gpx',
      'docs/morning.GPX',
      'apps/api/test/fixtures/gps-traces/leaked.gpx',
      'a/b/activity.tcx',
      'activity.fit',
      'route.kml',
    ]) {
      expect(ignored(path), path).toBe(true);
    }
  });

  it('does not ignore what must be committed', () => {
    for (const path of [
      'apps/api/test/fixtures/gps-traces/steady_run_01.trace.json',
      'apps/api/test/fixtures/gps-traces/README.md',
      'docs/reports/d10-real-traces.md',
    ]) {
      expect(ignored(path), path).toBe(false);
    }
  });

  it('tracks no raw GPS format and nothing under .local', () => {
    const tracked = git('ls-files').stdout.split('\n').filter(Boolean);
    expect(tracked.filter((path) => /\.(?:gpx|tcx|fit|kml|kmz)$/iu.test(path))).toEqual([]);
    expect(tracked.filter((path) => path.startsWith('.local/'))).toEqual([]);
  });
});

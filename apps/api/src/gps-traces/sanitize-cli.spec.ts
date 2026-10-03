import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runSanitizeCli } from './sanitize-cli.js';
import { parseSanitizedTraceText } from './trace-schema.js';
import { FAKE_PRIVATE_ORIGIN, FAKE_PRIVATE_START_MS, gpxFromRaw, rawFromLocal, straightLine } from './test-traces.js';

describe('gps:sanitize', () => {
  let root: string;
  let rawDir: string;
  let outDir: string;
  let log: string[];
  const raw = rawFromLocal(straightLine(40, 3, Math.PI / 5, 4.5));

  const run = (argv: string[]) => runSanitizeCli({ argv, cwd: root, log: (line) => log.push(line), rawDir });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gps-sanitize-'));
    rawDir = join(root, '.local', 'gps-traces', 'raw');
    outDir = join(root, 'fixtures');
    mkdirSync(rawDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(rawDir, 'morning-run.gpx'), gpxFromRaw(raw));
    log = [];
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  const baseArgs = () => [join(rawDir, 'morning-run.gpx'), '--scenario', 'steady_run', '--output', join(outDir, 'steady_run_01.trace.json')];

  it('writes a canonical, valid fixture and prints a non-sensitive summary', () => {
    run(baseArgs());
    const text = readFileSync(join(outDir, 'steady_run_01.trace.json'), 'utf8');
    const trace = parseSanitizedTraceText(text);
    expect(trace.points).toHaveLength(40);
    expect(trace.scenario).toBe('steady_run');
    const output = log.join('\n');
    expect(output).toMatch(/points: 40/u);
    expect(output).toMatch(/duration: 39\.0 s/u);
    expect(output).toMatch(/sampling interval/u);
    expect(output).toMatch(/accuracy: reported/u);
    expect(output).toContain('steady_run_01.trace.json');
  });

  it('prints and writes nothing that reveals the raw location, time, filename or device', () => {
    run(baseArgs());
    const everything = `${log.join('\n')}\n${readFileSync(join(outDir, 'steady_run_01.trace.json'), 'utf8')}`;
    for (const secret of [
      String(FAKE_PRIVATE_ORIGIN.latitude),
      String(FAKE_PRIVATE_ORIGIN.longitude),
      '12.3456',
      '98.7654',
      String(FAKE_PRIVATE_START_MS),
      '2031',
      'morning-run',
      'Jane',
      'Fake Watch',
      'SN-0042',
    ]) {
      expect(everything, secret).not.toContain(secret);
    }
  });

  it('refuses to overwrite an existing fixture unless --force is given', () => {
    run(baseArgs());
    const before = readFileSync(join(outDir, 'steady_run_01.trace.json'), 'utf8');
    expect(() => run(baseArgs())).toThrow(/already exists.*--force/u);
    expect(readFileSync(join(outDir, 'steady_run_01.trace.json'), 'utf8')).toBe(before);
    expect(() => run([...baseArgs(), '--force'])).not.toThrow();
  });

  it('writes nothing when the input is invalid, and the message carries no coordinates', () => {
    writeFileSync(join(rawDir, 'bad.gpx'), gpxFromRaw({ points: [...raw.points].reverse() }));
    let message = '';
    try {
      run([join(rawDir, 'bad.gpx'), '--scenario', 'steady_run', '--output', join(outDir, 'bad.trace.json')]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/before/u);
    expect(message).not.toMatch(/12\.34|98\.76/u);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it('points to GPX for formats it does not read', () => {
    for (const extension of ['fit', 'tcx', 'kml', 'csv', 'geojson', 'json']) {
      const file = join(rawDir, `trace.${extension}`);
      writeFileSync(file, 'x');
      expect(() => run([file, '--scenario', 'steady_run', '--output', join(outDir, 'a.trace.json')]), extension).toThrow(
        extension === 'fit' ? /export.*FIT.*GPX first/iu : /GPX/u,
      );
    }
  });

  it('requires a known scenario, an output, and an input file', () => {
    expect(() => run([join(rawDir, 'morning-run.gpx'), '--output', join(outDir, 'a.trace.json')])).toThrow(/--scenario/u);
    expect(() => run([join(rawDir, 'morning-run.gpx'), '--scenario', 'home_run', '--output', join(outDir, 'a.trace.json')])).toThrow(/steady_run/u);
    expect(() => run([join(rawDir, 'morning-run.gpx'), '--scenario', 'steady_run'])).toThrow(/--output/u);
    expect(() => run(['--scenario', 'steady_run', '--output', join(outDir, 'a.trace.json')])).toThrow(/raw file/u);
    expect(() => run([join(rawDir, 'missing.gpx'), '--scenario', 'steady_run', '--output', join(outDir, 'a.trace.json')])).toThrow(/cannot read/iu);
  });

  it('only accepts neutral fixture file names, so a name cannot carry a person or a place by accident', () => {
    for (const name of ['Alex Home Run.trace.json', 'a.json', 'UPPER.trace.json', 'home..trace.json x']) {
      expect(() => run([join(rawDir, 'morning-run.gpx'), '--scenario', 'steady_run', '--output', join(outDir, name)]), name).toThrow(
        /file name/u,
      );
    }
  });

  it('refuses to write a fixture into the private raw directory', () => {
    expect(() =>
      run([join(rawDir, 'morning-run.gpx'), '--scenario', 'steady_run', '--output', join(rawDir, 'steady_run_01.trace.json')]),
    ).toThrow(/raw directory/u);
    expect(existsSync(join(rawDir, 'steady_run_01.trace.json'))).toBe(false);
  });

  it('resolves relative paths against the directory the user ran the command from', () => {
    run(['.local/gps-traces/raw/morning-run.gpx', '--scenario', 'steady_run', '--output', 'fixtures/relative.trace.json']);
    expect(existsSync(join(outDir, 'relative.trace.json'))).toBe(true);
  });

  it('records an optional reference distance, and rejects a malformed one', () => {
    run([...baseArgs(), '--reference-distance-m', '123.5']);
    expect(parseSanitizedTraceText(readFileSync(join(outDir, 'steady_run_01.trace.json'), 'utf8')).referenceDistanceM).toBe(123.5);
    expect(() => run([...baseArgs(), '--force', '--reference-distance-m', 'far'])).toThrow(/--reference-distance-m/u);
  });

  it('says when the trace has no accuracy, so the replay assumption is visible', () => {
    const bare = rawFromLocal(straightLine(10, 3));
    writeFileSync(join(rawDir, 'bare.gpx'), gpxFromRaw(bare));
    run([join(rawDir, 'bare.gpx'), '--scenario', 'steady_run', '--output', join(outDir, 'bare.trace.json')]);
    expect(log.join('\n')).toMatch(/accuracy: not reported.*assumes 5 m/u);
  });

  it('rejects an unknown flag', () => {
    expect(() => run([...baseArgs(), '--verbose'])).toThrow(/Unknown argument/u);
  });
});

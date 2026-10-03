import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { runAnalyzeCli } from '../src/gps-traces/analyze-cli.js';
import { FIXTURE_DIR, REPORT_PATH, REPOSITORY_ROOT } from '../src/gps-traces/paths.js';
import { runReportCli } from '../src/gps-traces/report-cli.js';
import { serializeSanitizedTrace, type SanitizedTrace } from '../src/gps-traces/trace-schema.js';

function fixture(speedMps: number, scenario: SanitizedTrace['scenario']): string {
  return serializeSanitizedTrace({
    points: Array.from({ length: 40 }, (_, index) => ({
      accuracyM: 6,
      elapsedMs: index * 1000,
      xM: index * speedMps,
      yM: 0,
    })),
    scenario,
    schemaVersion: 1,
    source: 'synthetic',
  });
}

describe('D10 analyze and aggregate report commands', () => {
  let pool: Pool;
  let dir: string;
  let fixtures: string;
  let log: string[];

  beforeAll(() => {
    pool = new Pool({ connectionString: loadIntegrationTestConfiguration().migration.connectionString, max: 1 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gps-report-'));
    fixtures = join(dir, 'fixtures');
    mkdirSync(fixtures);
    log = [];
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  const report = (argv: string[], fixtureDir = fixtures) =>
    runReportCli({ argv, cwd: dir, fixtureDir, log: (line) => log.push(line), pool, reportPath: join(dir, 'report.md') });

  it('analyzes one fixture and prints its report, or JSON with --json', async () => {
    writeFileSync(join(dir, 'steady_run_01.trace.json'), fixture(3, 'steady_run'));
    await runAnalyzeCli({ argv: [join(dir, 'steady_run_01.trace.json')], cwd: dir, log: (line) => log.push(line), pool });
    expect(log.join('\n')).toContain('### steady_run_01');
    expect(log.join('\n')).toContain('Raw observed polyline distance');

    log = [];
    await runAnalyzeCli({ argv: [join(dir, 'steady_run_01.trace.json'), '--json'], cwd: dir, log: (line) => log.push(line), pool });
    const parsed = JSON.parse(log.join('\n')) as { edges: { edgeCount: number }; name: string };
    expect(parsed.name).toBe('steady_run_01');
    expect(parsed.edges.edgeCount).toBe(39);
  });

  it('rejects an invalid fixture before it touches the database', async () => {
    writeFileSync(join(dir, 'bad.trace.json'), '{"schemaVersion":2}');
    await expect(
      runAnalyzeCli({ argv: [join(dir, 'bad.trace.json')], cwd: dir, log: () => undefined, pool }),
    ).rejects.toThrow(/schemaVersion 2/u);
  });

  it('writes an aggregate report of every fixture in a stable order, and --check accepts the file it wrote', async () => {
    writeFileSync(join(fixtures, 'b_city_run_01.trace.json'), fixture(4, 'city_run'));
    writeFileSync(join(fixtures, 'a_steady_run_01.trace.json'), fixture(3, 'steady_run'));
    await report([]);
    const text = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(text).toMatch(/Traces analyzed: 2/u);
    expect(text.indexOf('a_steady_run_01')).toBeLessThan(text.indexOf('b_city_run_01'));
    await expect(report(['--check'])).resolves.toBeUndefined();
  });

  it('--check fails when the committed report is stale', async () => {
    writeFileSync(join(fixtures, 'steady_run_01.trace.json'), fixture(3, 'steady_run'));
    await report([]);
    writeFileSync(join(dir, 'report.md'), `${readFileSync(join(dir, 'report.md'), 'utf8')}\nedited by hand\n`);
    await expect(report(['--check'])).rejects.toThrow(/out of date.*gps:report/u);
  });

  it('produces an honest empty report when there are no fixtures', async () => {
    await report([]);
    const text = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(text).toMatch(/Traces analyzed: 0/u);
    expect(text).toMatch(/blocked on collecting/u);
  });

  it('refuses a fixture directory that contains anything but fixtures, such as a raw export', async () => {
    writeFileSync(join(fixtures, 'steady_run_01.trace.json'), fixture(3, 'steady_run'));
    writeFileSync(join(fixtures, 'morning.gpx'), '<gpx/>');
    await expect(report([])).rejects.toThrow(/unexpected file.*morning\.gpx/iu);
  });

  it('keeps the committed D10 trace report in step with the committed fixtures', async () => {
    await runReportCli({
      argv: ['--check'],
      cwd: REPOSITORY_ROOT,
      fixtureDir: FIXTURE_DIR,
      log: () => undefined,
      pool,
      reportPath: REPORT_PATH,
    });
  });
});

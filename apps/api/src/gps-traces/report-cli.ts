import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Pool } from 'pg';

import { analyzeTrace } from './analyze.js';
import { loadFixtures } from './fixtures.js';
import { FIXTURE_DIR, REPORT_PATH } from './paths.js';
import { renderAggregateReport } from './report-render.js';

export const REPORT_USAGE = 'Usage: npm run gps:report [-- --check | --stdout]';

export interface ReportCliDependencies {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly fixtureDir?: string;
  readonly log: (text: string) => void;
  /** Connected to the integration test database as the schema owner. */
  readonly pool: Pick<Pool, 'connect'>;
  readonly reportPath?: string;
}

/**
 * Replays every committed sanitized fixture and writes the aggregate D10 report. `--check` writes nothing and fails
 * when the committed report differs from a fresh one; `--stdout` prints instead of writing.
 */
export async function runReportCli(dependencies: ReportCliDependencies): Promise<void> {
  let check = false;
  let stdout = false;
  for (const argument of dependencies.argv) {
    if (argument === '--check') {
      check = true;
    } else if (argument === '--stdout') {
      stdout = true;
    } else {
      throw new Error(`Unknown argument ${argument}. ${REPORT_USAGE}`);
    }
  }
  if (check && stdout) {
    throw new Error(`--check and --stdout cannot be combined. ${REPORT_USAGE}`);
  }

  const reportPath = dependencies.reportPath ?? REPORT_PATH;
  const fixtures = loadFixtures(dependencies.fixtureDir ?? FIXTURE_DIR);
  const reports = [];
  for (const fixture of fixtures) {
    reports.push(await analyzeTrace(dependencies.pool, fixture.name, fixture.trace, fixture.text));
  }
  const text = renderAggregateReport(reports);

  if (stdout) {
    dependencies.log(text);
    return;
  }
  if (check) {
    const committed = existsSync(reportPath) ? readFileSync(reportPath, 'utf8').replace(/\r\n/gu, '\n') : null;
    if (committed !== text) {
      throw new Error('The D10 trace report is out of date; run `npm run gps:report` and commit the result');
    }
    dependencies.log(`The D10 trace report is current (${String(fixtures.length)} trace(s)).`);
    return;
  }
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, text);
  dependencies.log(`Wrote the D10 trace report for ${String(fixtures.length)} trace(s).`);
}

import type { Pool } from 'pg';

import { analyzeTrace } from './analyze.js';
import { loadFixtureFile } from './fixtures.js';
import { resolveUserPath } from './paths.js';
import { renderTraceReport } from './report-render.js';

export const ANALYZE_USAGE = 'Usage: npm run gps:analyze -- <fixture.trace.json> [--json]';

export interface AnalyzeCliDependencies {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly log: (text: string) => void;
  /** Connected to the integration test database as the schema owner. */
  readonly pool: Pick<Pool, 'connect'>;
}

/** Replays one sanitized fixture through the production evaluator and prints the measurements. */
export async function runAnalyzeCli(dependencies: AnalyzeCliDependencies): Promise<void> {
  let fixturePath: string | undefined;
  let json = false;
  for (const argument of dependencies.argv) {
    if (argument === '--json') {
      json = true;
    } else if (argument.startsWith('--') || fixturePath !== undefined) {
      throw new Error(`Unknown argument ${argument}. ${ANALYZE_USAGE}`);
    } else {
      fixturePath = argument;
    }
  }
  if (fixturePath === undefined) {
    throw new Error(`A fixture is required. ${ANALYZE_USAGE}`);
  }

  // Validation happens before any connection is used.
  const fixture = loadFixtureFile(resolveUserPath(fixturePath, dependencies.cwd));
  const report = await analyzeTrace(dependencies.pool, fixture.name, fixture.trace, fixture.text);
  dependencies.log(json ? JSON.stringify(report, null, 2) : renderTraceReport(report));
}

import process from 'node:process';

import { createAnalysisPool } from './analysis-pool.js';
import { runAnalyzeCli } from './analyze-cli.js';
import { userWorkingDirectory } from './paths.js';

let pool: ReturnType<typeof createAnalysisPool> | undefined;
try {
  pool = createAnalysisPool();
  await runAnalyzeCli({
    argv: process.argv.slice(2),
    cwd: userWorkingDirectory(process.env),
    log: (text) => console.log(text),
    pool,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Analysis failed');
  process.exitCode = 1;
} finally {
  await pool?.end();
}

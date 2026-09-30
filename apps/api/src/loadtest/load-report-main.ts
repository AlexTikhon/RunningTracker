import process from 'node:process';

import { runReportCli } from './load-report-cli.js';

try {
  await runReportCli({ argv: process.argv.slice(2) });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The report could not be generated');
  process.exitCode = 1;
}

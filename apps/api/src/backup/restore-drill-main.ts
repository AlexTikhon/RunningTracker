import process from 'node:process';

import { operatorEnvironment } from './operator-environment.js';
import { runDrillCli } from './restore-drill-cli.js';

try {
  process.exitCode = await runDrillCli({ argv: process.argv.slice(2), env: operatorEnvironment() });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The restore drill failed');
  process.exitCode = 1;
}

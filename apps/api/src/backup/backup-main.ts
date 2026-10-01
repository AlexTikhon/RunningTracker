import process from 'node:process';

import { runBackupCli } from './backup-cli.js';
import { operatorEnvironment } from './operator-environment.js';

try {
  process.exitCode = await runBackupCli({ argv: process.argv.slice(2), env: operatorEnvironment() });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The backup command failed');
  process.exitCode = 1;
}

import process from 'node:process';

import { runReapplyCli } from './reapply-deletions-cli.js';

try {
  process.exitCode = await runReapplyCli({ argv: process.argv.slice(2), env: process.env });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Deletion reapplication failed');
  process.exitCode = 1;
}

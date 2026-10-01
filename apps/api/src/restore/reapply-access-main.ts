import process from 'node:process';

import { runReapplyAccessCli } from './reapply-access-cli.js';

try {
  process.exitCode = await runReapplyAccessCli({ argv: process.argv.slice(2), env: process.env });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Access restriction reapplication failed');
  process.exitCode = 1;
}

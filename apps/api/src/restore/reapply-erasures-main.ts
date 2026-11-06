import process from 'node:process';

import { runReapplyErasuresCli } from './reapply-erasures-cli.js';

try {
  process.exitCode = await runReapplyErasuresCli({ argv: process.argv.slice(2), env: process.env });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Erasure replay failed');
  process.exitCode = 1;
}

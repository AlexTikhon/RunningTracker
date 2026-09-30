import process from 'node:process';

import { runSeedCli } from './seed-dataset-cli.js';

try {
  await runSeedCli({ argv: process.argv.slice(2), env: process.env });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Dataset seeding failed');
  process.exitCode = 1;
}

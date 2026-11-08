import process from 'node:process';

import { runClearSessionsCli } from './clear-sessions-cli.js';

try {
  process.exitCode = await runClearSessionsCli({ argv: process.argv.slice(2), env: process.env });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Clearing sessions failed');
  process.exitCode = 1;
}

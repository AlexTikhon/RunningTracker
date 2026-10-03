import process from 'node:process';

import { userWorkingDirectory } from './paths.js';
import { runSanitizeCli } from './sanitize-cli.js';

try {
  runSanitizeCli({
    argv: process.argv.slice(2),
    cwd: userWorkingDirectory(process.env),
    log: (line) => console.log(line),
  });
} catch (error) {
  // Messages name fields and point numbers, never coordinates or times.
  console.error(error instanceof Error ? error.message : 'Sanitizing failed');
  process.exitCode = 1;
}

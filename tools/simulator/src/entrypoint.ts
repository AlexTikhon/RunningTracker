#!/usr/bin/env node

import { runCli } from './cli.js';

try {
  runCli(process.argv.slice(2), (text) => process.stdout.write(text));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`GPS simulator: ${message}\n`);
  process.exitCode = 1;
}

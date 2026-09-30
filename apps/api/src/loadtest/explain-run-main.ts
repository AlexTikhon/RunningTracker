import process from 'node:process';

import { runExplainCli } from './explain-run-cli.js';

// Ctrl-C stops between statements; the recording fixture is restored before the process exits.
const interrupt = new AbortController();
process.once('SIGINT', () => interrupt.abort(new Error('Interrupted')));

try {
  const outcome = await runExplainCli({ argv: process.argv.slice(2), env: process.env, signal: interrupt.signal });
  process.exitCode = outcome.exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The measurement failed');
  process.exitCode = 1;
}

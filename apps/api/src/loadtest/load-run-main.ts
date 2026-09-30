import process from 'node:process';

import { runLoadCli } from './load-run-cli.js';

// Ctrl-C stops new load, closes every stream, cleans up, and still writes a partial result.
const interrupt = new AbortController();
process.once('SIGINT', () => interrupt.abort(new Error('Interrupted')));

try {
  const outcome = await runLoadCli({ argv: process.argv.slice(2), env: process.env, signal: interrupt.signal });
  process.exitCode = outcome.exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The load run failed');
  process.exitCode = 1;
}

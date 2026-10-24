// Read-only readiness report for the local demo. See docs/runbooks/demo.md. Run with `npm run demo:doctor`.
// It starts nothing, writes nothing and never prints a credential; it exits 1 when demo:up would refuse to start.
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { collectChecks, printChecks } from './demo-preflight.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { checks } = await collectChecks({ root });
printChecks(checks);

const failures = checks.filter((check) => check.status === 'fail').length;
console.log('');
if (failures === 0) {
  console.log('Ready: npm run demo:up');
} else {
  console.log(`${failures} problem${failures === 1 ? '' : 's'} to fix before npm run demo:up.`);
  process.exitCode = 1;
}

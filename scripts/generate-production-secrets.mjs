import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import process from 'node:process';

import { writeProductionSecrets } from './production-secrets.mjs';

const args = process.argv.slice(2);
const directoryIndex = args.indexOf('--dir');
const directory = directoryIndex >= 0 ? args[directoryIndex + 1] : undefined;

if (!directory || directory.startsWith('--')) {
  console.error('Usage: npm run deploy:secrets -- --dir <absolute-or-relative-directory> [--force | --rotate-roles]');
  process.exit(2);
}

try {
  const names = writeProductionSecrets(resolve(directory), {
    force: args.includes('--force'),
    rotateRoles: args.includes('--rotate-roles'),
    randomBytes,
  });
  console.info(`Wrote ${names.length} secret files to ${resolve(directory)}: ${names.join(', ')}`);
  console.info('Keep this directory private (0700) and out of version control and backups of the application host.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

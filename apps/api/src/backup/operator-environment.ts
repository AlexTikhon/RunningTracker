import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { parseEnv } from 'node:util';

import { repositoryRoot } from './restore-drill-operations.js';

/** The repository `.env` (development fixtures) underneath the real process environment, which wins. */
export function operatorEnvironment(): Record<string, string | undefined> {
  const file = join(repositoryRoot, '.env');
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...process.env };
}

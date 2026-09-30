import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { namedProfiles, type DatasetProfile } from './dataset-plan.js';
import { defaultSeed } from './seed-dataset-cli.js';

export const loadRunUsage =
  'Usage: LOAD_DATABASE_URL=... LOAD_RUNTIME_DATABASE_URL=... LOAD_MAINTENANCE_DATABASE_URL=... ' +
  'npm run load:run -- --profile ordinary|stress|smoke [--seed <uint32>] [--as-of <UTC instant>] ' +
  '[--results-dir <path>] [--no-cleanup | --cleanup-only] [--no-tiles]';

/** <repo>/.local/load-results, which is gitignored. */
export const defaultResultsDirectory = fileURLToPath(new URL('../../../../.local/load-results', import.meta.url));

export interface LoadRunArguments {
  /** Explicit dataset instant; when absent it is derived from the seeded rows and then verified. */
  asOf: Date | undefined;
  cleanup: boolean;
  cleanupOnly: boolean;
  profile: DatasetProfile;
  /** False sends no tile bursts, giving a baseline for ingestion and live latency without tile load. */
  tiles: boolean;
  resultsDir: string;
  seed: number;
}

/** There is deliberately no flag for a URL, a database, or a reseed: the target comes only from the environment. */
export function parseLoadArguments(argv: readonly string[]): LoadRunArguments {
  let profile: DatasetProfile | undefined;
  let seed = defaultSeed;
  let asOf: Date | undefined;
  let resultsDir = defaultResultsDirectory;
  let cleanup = true;
  let cleanupOnly = false;
  let tiles = true;

  for (let position = 0; position < argv.length; position += 1) {
    const flag = argv[position];
    if (flag === '--no-cleanup') {
      cleanup = false;
      continue;
    }
    if (flag === '--cleanup-only') {
      cleanupOnly = true;
      continue;
    }
    if (flag === '--no-tiles') {
      tiles = false;
      continue;
    }
    const value = argv[position + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag ?? ''} requires a value. ${loadRunUsage}`);
    }
    position += 1;

    if (flag === '--profile') {
      profile = Object.hasOwn(namedProfiles, value) ? namedProfiles[value] : undefined;
      if (!profile) {
        throw new Error(`Unknown profile ${value}. ${loadRunUsage}`);
      }
    } else if (flag === '--seed') {
      if (!/^\d{1,10}$/u.test(value) || Number(value) > 0xffff_ffff) {
        throw new Error(`--seed must be an unsigned 32-bit integer. ${loadRunUsage}`);
      }
      seed = Number(value);
    } else if (flag === '--as-of') {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
        throw new Error(`--as-of must be a canonical UTC instant such as 2032-03-01T00:00:00.000Z. ${loadRunUsage}`);
      }
      asOf = parsed;
    } else if (flag === '--results-dir') {
      resultsDir = resolve(value);
    } else {
      throw new Error(`Unknown argument ${flag ?? ''}. ${loadRunUsage}`);
    }
  }

  if (!profile) {
    throw new Error(`--profile is required. ${loadRunUsage}`);
  }
  if (cleanupOnly && !cleanup) {
    throw new Error(`--cleanup-only and --no-cleanup contradict each other. ${loadRunUsage}`);
  }
  return { asOf, cleanup, cleanupOnly, profile, resultsDir, seed, tiles };
}

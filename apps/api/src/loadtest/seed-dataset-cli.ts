import { Pool } from 'pg';

import { namedProfiles, type DatasetProfile } from './dataset-plan.js';
import { loadDatabaseSuffix, seedDataset, type DatasetManifest } from './seed-dataset.js';

export const defaultSeed = 42;

const usage =
  'Usage: LOAD_DATABASE_URL=postgres://running_tracker_owner:...@host/<name>_load_test ' +
  'npm run load:seed -- --profile ordinary|stress|smoke [--seed <uint32>] [--as-of <UTC instant>] [--reset]';

export interface SeedArguments {
  asOf: Date;
  profile: DatasetProfile;
  reset: boolean;
  seed: number;
}

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function parseSeedArguments(argv: readonly string[], now: Date): SeedArguments {
  let profile: DatasetProfile | undefined;
  let seed = defaultSeed;
  let asOf = utcMidnight(now);
  let reset = false;

  for (let position = 0; position < argv.length; position += 1) {
    const flag = argv[position];
    if (flag === '--reset') {
      reset = true;
      continue;
    }
    const value = argv[position + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag ?? ''} requires a value. ${usage}`);
    }
    position += 1;

    if (flag === '--profile') {
      profile = Object.hasOwn(namedProfiles, value) ? namedProfiles[value] : undefined;
      if (!profile) {
        throw new Error(`Unknown profile ${value}. ${usage}`);
      }
    } else if (flag === '--seed') {
      if (!/^\d{1,10}$/.test(value) || Number(value) > 0xffff_ffff) {
        throw new Error(`--seed must be an unsigned 32-bit integer. ${usage}`);
      }
      seed = Number(value);
    } else if (flag === '--as-of') {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
        throw new Error(`--as-of must be a canonical UTC instant such as 2032-03-01T00:00:00.000Z. ${usage}`);
      }
      asOf = parsed;
    } else {
      throw new Error(`Unknown argument ${flag ?? ''}. ${usage}`);
    }
  }

  if (!profile) {
    throw new Error(`--profile is required. ${usage}`);
  }
  return { asOf, profile, reset, seed };
}

export interface SeedCliDependencies {
  argv: readonly string[];
  createPool?: (connectionString: string) => Pick<Pool, 'connect' | 'end'>;
  env: Record<string, string | undefined>;
  log?: (line: string) => void;
  now?: () => Date;
  write?: (line: string) => void;
}

/**
 * Seeds a dedicated `*_load_test` database as the object owner and prints the manifest (identifiers, counts,
 * timings, sizes, and the reproducibility digest) as one JSON document. Progress goes to `log` (stderr).
 */
export async function runSeedCli(dependencies: SeedCliDependencies): Promise<DatasetManifest> {
  const log = dependencies.log ?? ((line: string) => console.error(line));
  const write = dependencies.write ?? ((line: string) => console.info(line));
  const parsed = parseSeedArguments(dependencies.argv, dependencies.now?.() ?? new Date());
  const connectionString = dependencies.env.LOAD_DATABASE_URL;
  if (!connectionString) {
    throw new Error(`LOAD_DATABASE_URL is required. ${usage}`);
  }

  const pool =
    dependencies.createPool?.(connectionString) ??
    new Pool({ application_name: 'running-tracker-load-seed', connectionString, max: 1 });
  try {
    const manifest = await seedDataset(pool, {
      allowedDatabaseSuffixes: [loadDatabaseSuffix],
      asOf: parsed.asOf,
      log,
      profile: parsed.profile,
      requireEmptyDatabase: !parsed.reset,
      reset: parsed.reset,
      seed: parsed.seed,
    });
    write(JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    await pool.end();
  }
}

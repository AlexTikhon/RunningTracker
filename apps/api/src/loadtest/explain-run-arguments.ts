import { resolve } from 'node:path';

import { namedProfiles, type DatasetProfile } from './dataset-plan.js';
import { defaultResultsDirectory } from './load-run-arguments.js';
import { defaultSeed } from './seed-dataset-cli.js';

export const explainUsage =
  'Usage: LOAD_DATABASE_URL=... LOAD_RUNTIME_DATABASE_URL=... LOAD_MAINTENANCE_DATABASE_URL=... ' +
  'npm run load:explain -- --profile ordinary|stress|smoke [--seed <uint32>] [--as-of <UTC instant>] ' +
  '[--repetitions <1-50>] [--results-dir <path>] [--keep-plans]';

export const defaultRepetitions = 5;
const maximumRepetitions = 50;

export interface ExplainArguments {
  asOf: Date | undefined;
  /** Also write the raw first plan of each statement to a separate file; plans can contain literal values. */
  keepPlans: boolean;
  profile: DatasetProfile;
  repetitions: number;
  resultsDir: string;
  seed: number;
}

/** As for the load runner, no flag names a URL or a database: the target comes only from the environment. */
export function parseExplainArguments(argv: readonly string[]): ExplainArguments {
  let profile: DatasetProfile | undefined;
  let seed = defaultSeed;
  let asOf: Date | undefined;
  let repetitions = defaultRepetitions;
  let resultsDir = defaultResultsDirectory;
  let keepPlans = false;

  for (let position = 0; position < argv.length; position += 1) {
    const flag = argv[position];
    if (flag === '--keep-plans') {
      keepPlans = true;
      continue;
    }
    const value = argv[position + 1];
    if (flag !== '--profile' && flag !== '--seed' && flag !== '--as-of' && flag !== '--repetitions' && flag !== '--results-dir') {
      throw new Error(`Unknown argument ${flag ?? ''}. ${explainUsage}`);
    }
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value. ${explainUsage}`);
    }
    position += 1;

    if (flag === '--profile') {
      profile = Object.hasOwn(namedProfiles, value) ? namedProfiles[value] : undefined;
      if (!profile) {
        throw new Error(`Unknown profile ${value}. ${explainUsage}`);
      }
    } else if (flag === '--seed') {
      if (!/^\d{1,10}$/u.test(value) || Number(value) > 0xffff_ffff) {
        throw new Error(`--seed must be an unsigned 32-bit integer. ${explainUsage}`);
      }
      seed = Number(value);
    } else if (flag === '--as-of') {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
        throw new Error(`--as-of must be a canonical UTC instant such as 2026-09-30T00:00:00.000Z. ${explainUsage}`);
      }
      asOf = parsed;
    } else if (flag === '--repetitions') {
      if (!/^\d{1,2}$/u.test(value) || Number(value) < 1 || Number(value) > maximumRepetitions) {
        throw new Error(`--repetitions must be a whole number from 1 to ${maximumRepetitions}. ${explainUsage}`);
      }
      repetitions = Number(value);
    } else {
      resultsDir = resolve(value);
    }
  }

  if (!profile) {
    throw new Error(`--profile is required. ${explainUsage}`);
  }
  return { asOf, keepPlans, profile, repetitions, resultsDir, seed };
}

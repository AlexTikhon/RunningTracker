import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

const environmentSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65_535).default(3000),
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith('postgresql://') || value.startsWith('postgres://'), {
      message: 'DATABASE_URL must use the postgres or postgresql protocol',
    })
    .refine((value) => decodeURIComponent(new URL(value).username) === 'running_tracker_runtime', {
      message: 'DATABASE_URL must authenticate as running_tracker_runtime',
    }),
  DB_POOL_MAX: z.coerce.number().int().positive().max(50).default(10),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(2_000),
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(1_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(5_000),
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(input: Record<string, unknown>): Environment {
  const result = environmentSchema.safeParse(input);

  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${z.prettifyError(result.error)}`);
  }

  return result.data;
}

export interface LoadEnvironmentOptions {
  environment?: NodeJS.ProcessEnv;
  envFiles?: readonly string[];
}

function defaultEnvFiles(): readonly string[] {
  return [join(process.cwd(), '.env'), join(process.cwd(), '..', '..', '.env')];
}

function readEnvFiles(paths: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};

  for (const path of paths) {
    if (!existsSync(path)) {
      continue;
    }

    const parsed = parseEnv(readFileSync(path, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined) {
        values[key] ??= value;
      }
    }
  }

  return values;
}

function environmentSource(options: LoadEnvironmentOptions): Record<string, string | undefined> {
  return {
    ...readEnvFiles(options.envFiles ?? defaultEnvFiles()),
    ...(options.environment ?? process.env),
  };
}

export function loadRequiredPostgresUrl(
  variableName: string,
  options: LoadEnvironmentOptions = {},
): string {
  const value = z
    .string({ error: `${variableName} is required` })
    .url()
    .refine((candidate) => candidate.startsWith('postgresql://') || candidate.startsWith('postgres://'), {
      message: `${variableName} must use the postgres or postgresql protocol`,
    })
    .parse(environmentSource(options)[variableName]);

  return value;
}

export function loadEnvironment(options: LoadEnvironmentOptions = {}): Environment {
  return validateEnvironment(environmentSource(options));
}

export function loadTestEnvironment(options: LoadEnvironmentOptions = {}): Environment {
  const source = environmentSource(options);
  const testDatabaseUrl = loadRequiredPostgresUrl('TEST_DATABASE_URL', options);
  const databaseName = new URL(testDatabaseUrl).pathname.slice(1);

  if (!databaseName.endsWith('_test')) {
    throw new Error(`Integration tests require a database ending in _test, received ${databaseName}`);
  }

  return validateEnvironment({ ...source, APP_ENV: 'test', DATABASE_URL: testDatabaseUrl });
}

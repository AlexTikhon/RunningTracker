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

export interface VerifiedIntegrationDatabaseConnection {
  connectionString: string;
  database: string;
  user: string;
}

export interface IntegrationTestConfiguration {
  environment: Environment;
  maintenance: VerifiedIntegrationDatabaseConnection;
  migration: VerifiedIntegrationDatabaseConnection;
  runtime: VerifiedIntegrationDatabaseConnection;
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

interface ParsedIntegrationDatabaseConnection extends VerifiedIntegrationDatabaseConnection {
  host: string;
  port: string;
}

function integrationConfigurationError(message: string): Error {
  return new Error(`Invalid integration database configuration: ${message}`);
}

function parseIntegrationDatabaseConnection(
  source: Record<string, string | undefined>,
  variableName: string,
  expectedUser: string,
): ParsedIntegrationDatabaseConnection {
  const connectionString = source[variableName];

  if (!connectionString) {
    throw integrationConfigurationError(`${variableName} is required`);
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw integrationConfigurationError(`${variableName} must be a valid PostgreSQL URL`);
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw integrationConfigurationError(`${variableName} must use the postgres or postgresql protocol`);
  }

  const identityOverrides = ['database', 'dbname', 'host', 'port', 'user'].filter((name) =>
    url.searchParams.has(name),
  );
  if (identityOverrides.length > 0) {
    throw integrationConfigurationError(
      `${variableName} must not override connection identity in query parameters`,
    );
  }

  let database: string;
  let user: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    user = decodeURIComponent(url.username);
  } catch {
    throw integrationConfigurationError(`${variableName} contains invalid percent-encoding`);
  }

  if (user !== expectedUser) {
    throw integrationConfigurationError(`${variableName} must authenticate as ${expectedUser}`);
  }
  if (!database.endsWith('_test')) {
    throw integrationConfigurationError(`${variableName} database name must end in _test`);
  }

  const port = url.port || '5432';
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
    throw integrationConfigurationError(`${variableName} must use a valid PostgreSQL port`);
  }

  return {
    connectionString,
    database,
    host: url.hostname.toLowerCase(),
    port: numericPort.toString(),
    user,
  };
}

function assertSameIntegrationDatabase(
  connections: readonly ParsedIntegrationDatabaseConnection[],
): void {
  const [first, ...rest] = connections;
  if (
    !first ||
    rest.some(
      (connection) =>
        connection.host !== first.host ||
        connection.port !== first.port ||
        connection.database !== first.database,
    )
  ) {
    throw integrationConfigurationError(
      'runtime, migration, and maintenance URLs must use the same host, port, and database',
    );
  }
}

export function loadEnvironment(options: LoadEnvironmentOptions = {}): Environment {
  return validateEnvironment(environmentSource(options));
}

export function loadIntegrationTestConfiguration(
  options: LoadEnvironmentOptions = {},
): IntegrationTestConfiguration {
  const source = environmentSource(options);
  const runtime = parseIntegrationDatabaseConnection(
    source,
    'TEST_DATABASE_URL',
    'running_tracker_runtime',
  );
  const migration = parseIntegrationDatabaseConnection(
    source,
    'TEST_MIGRATION_DATABASE_URL',
    'running_tracker_owner',
  );
  const maintenance = parseIntegrationDatabaseConnection(
    source,
    'TEST_MAINTENANCE_DATABASE_URL',
    'running_tracker_maintenance',
  );

  assertSameIntegrationDatabase([runtime, migration, maintenance]);

  return {
    environment: validateEnvironment({
      ...source,
      APP_ENV: 'test',
      DATABASE_URL: runtime.connectionString,
    }),
    maintenance,
    migration,
    runtime,
  };
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const environmentBoolean = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((value) => value === 'true'),
]);

const uuidList = z
  .string()
  .default('')
  .transform((value, context) => {
    const entries = value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const entry of entries) {
      if (!canonicalUuidPattern.test(entry)) {
        context.addIssue({ code: 'custom', message: `invalid canonical UUID: ${entry}` });
      }
    }

    return [...new Set(entries)];
  });

const originList = z
  .string()
  .default('')
  .transform((value, context) => {
    const entries = value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const entry of entries) {
      try {
        const parsed = new URL(entry);
        if (parsed.origin !== entry || !['http:', 'https:'].includes(parsed.protocol)) {
          throw new Error('not a canonical HTTP origin');
        }
      } catch {
        context.addIssue({ code: 'custom', message: `invalid canonical HTTP origin: ${entry}` });
      }
    }

    return [...new Set(entries)];
  });

interface ParsedDatabaseConnection {
  connectionString: string;
  database: string;
  host: string;
  port: string;
  user: string;
}

function parseDatabaseConnection(
  connectionString: string,
  variableName: string,
  expectedUser: string,
  requireTestDatabase: boolean,
  createError: (message: string) => Error,
): ParsedDatabaseConnection {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw createError(`${variableName} must be a valid PostgreSQL URL`);
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw createError(`${variableName} must use the postgres or postgresql protocol`);
  }

  const identityOverrides = ['database', 'dbname', 'host', 'port', 'user'].filter((name) =>
    url.searchParams.has(name),
  );
  if (identityOverrides.length > 0) {
    throw createError(`${variableName} must not override connection identity in query parameters`);
  }

  let database: string;
  let user: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    user = decodeURIComponent(url.username);
  } catch {
    throw createError(`${variableName} contains invalid percent-encoding`);
  }

  if (user !== expectedUser) {
    throw createError(`${variableName} must authenticate as ${expectedUser}`);
  }
  if (!database) {
    throw createError(`${variableName} must include a database name`);
  }
  if (requireTestDatabase && !database.endsWith('_test')) {
    throw createError(`${variableName} database name must end in _test`);
  }

  const port = url.port || '5432';
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
    throw createError(`${variableName} must use a valid PostgreSQL port`);
  }

  return {
    connectionString,
    database,
    host: url.hostname.toLowerCase(),
    port: numericPort.toString(),
    user,
  };
}

function sameDatabaseTarget(
  first: ParsedDatabaseConnection,
  second: ParsedDatabaseConnection,
): boolean {
  return (
    first.host === second.host &&
    first.port === second.port &&
    first.database === second.database
  );
}

const environmentSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().max(65_535).default(3000),
    DATABASE_URL: z.string(),
    MAINTENANCE_DATABASE_URL: z.string(),
    RUN_AUTO_FINISH_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1_000)
      .default(60_000),
    DB_POOL_MAX: z.coerce.number().int().positive().max(50).default(10),
    DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(2_000),
    DB_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(1_000),
    ALLOWED_ORIGINS: originList,
    LOCAL_AUTH_ENABLED: environmentBoolean.default(false),
    LOCAL_AUTH_USER_IDS: uuidList,
    SESSION_COOKIE_SECURE: environmentBoolean.default(true),
    SESSION_STORE_MAX_ENTRIES: z.coerce.number().int().positive().max(10_000).default(100),
    SESSION_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1_000)
      .default(8 * 60 * 60 * 1_000),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(5_000),
  })
  .superRefine((environment, context) => {
    let runtime: ParsedDatabaseConnection | undefined;
    let maintenance: ParsedDatabaseConnection | undefined;
    try {
      runtime = parseDatabaseConnection(
        environment.DATABASE_URL,
        'DATABASE_URL',
        'running_tracker_runtime',
        false,
        (message) => new Error(message),
      );
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'DATABASE_URL is invalid',
        path: ['DATABASE_URL'],
      });
    }
    try {
      maintenance = parseDatabaseConnection(
        environment.MAINTENANCE_DATABASE_URL,
        'MAINTENANCE_DATABASE_URL',
        'running_tracker_maintenance',
        false,
        (message) => new Error(message),
      );
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'MAINTENANCE_DATABASE_URL is invalid',
        path: ['MAINTENANCE_DATABASE_URL'],
      });
    }
    if (runtime && maintenance && !sameDatabaseTarget(runtime, maintenance)) {
      context.addIssue({
        code: 'custom',
        message: 'MAINTENANCE_DATABASE_URL must target the same host, port, and database as DATABASE_URL',
        path: ['MAINTENANCE_DATABASE_URL'],
      });
    }
    if (environment.APP_ENV === 'production' && environment.LOCAL_AUTH_ENABLED) {
      context.addIssue({
        code: 'custom',
        message: 'LOCAL_AUTH_ENABLED must be false in production',
        path: ['LOCAL_AUTH_ENABLED'],
      });
    }
    if (environment.APP_ENV === 'production' && !environment.SESSION_COOKIE_SECURE) {
      context.addIssue({
        code: 'custom',
        message: 'SESSION_COOKIE_SECURE must be true in production',
        path: ['SESSION_COOKIE_SECURE'],
      });
    }
    if (environment.LOCAL_AUTH_ENABLED && environment.LOCAL_AUTH_USER_IDS.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'LOCAL_AUTH_USER_IDS must contain at least one user when local auth is enabled',
        path: ['LOCAL_AUTH_USER_IDS'],
      });
    }
    if (environment.LOCAL_AUTH_ENABLED && environment.ALLOWED_ORIGINS.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'ALLOWED_ORIGINS must contain at least one origin when local auth is enabled',
        path: ['ALLOWED_ORIGINS'],
      });
    }
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

type ParsedIntegrationDatabaseConnection = ParsedDatabaseConnection;

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

  return parseDatabaseConnection(
    connectionString,
    variableName,
    expectedUser,
    true,
    integrationConfigurationError,
  );
}

function assertSameIntegrationDatabase(
  connections: readonly ParsedIntegrationDatabaseConnection[],
): void {
  const [first, ...rest] = connections;
  if (
    !first ||
    rest.some(
      (connection) =>
        !sameDatabaseTarget(connection, first),
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
      MAINTENANCE_DATABASE_URL: maintenance.connectionString,
    }),
    maintenance,
    migration,
    runtime,
  };
}

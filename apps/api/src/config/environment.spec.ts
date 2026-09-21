import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadIntegrationTestConfiguration,
  validateEnvironment,
} from './environment.js';

const temporaryDirectories: string[] = [];

const validIntegrationEnvironment = {
  TEST_DATABASE_URL:
    'postgresql://running_tracker_runtime:runtime-secret@localhost:5432/running_tracker%5Ftest',
  TEST_MAINTENANCE_DATABASE_URL:
    'postgres://running_tracker_maintenance:maintenance-secret@LOCALHOST:5432/running_tracker_test',
  TEST_MIGRATION_DATABASE_URL:
    'postgresql://running_tracker_owner:owner-secret@localhost/running_tracker_test',
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('validateEnvironment', () => {
  it('coerces bounded values and applies defaults', () => {
    const environment = validateEnvironment({
      DATABASE_URL: 'postgresql://running_tracker_runtime:password@127.0.0.1:5433/database',
      PORT: '3100',
    });

    expect(environment).toMatchObject({
      APP_ENV: 'development',
      DB_CONNECTION_TIMEOUT_MS: 2_000,
      DB_POOL_MAX: 10,
      DB_QUERY_TIMEOUT_MS: 1_000,
      PORT: 3_100,
      SHUTDOWN_TIMEOUT_MS: 5_000,
    });
  });

  it('rejects startup without a PostgreSQL URL', () => {
    expect(() => validateEnvironment({})).toThrow('Invalid environment configuration');
    expect(() => validateEnvironment({ DATABASE_URL: 'https://example.com' })).toThrow(
      'DATABASE_URL must use the postgres or postgresql protocol',
    );
    expect(() =>
      validateEnvironment({
        DATABASE_URL: 'postgresql://running_tracker_owner:password@127.0.0.1:5433/database',
      }),
    ).toThrow('DATABASE_URL must authenticate as running_tracker_runtime');
  });

  it('fails production startup before infrastructure when local auth or insecure cookies are configured', () => {
    const databaseUrl =
      'postgresql://running_tracker_runtime:password@127.0.0.1:5433/running_tracker';

    expect(() =>
      validateEnvironment({
        ALLOWED_ORIGINS: 'https://tracker.example',
        APP_ENV: 'production',
        DATABASE_URL: databaseUrl,
        LOCAL_AUTH_ENABLED: 'true',
        LOCAL_AUTH_USER_IDS: '11111111-1111-4111-8111-111111111111',
      }),
    ).toThrow('LOCAL_AUTH_ENABLED must be false in production');
    expect(() =>
      validateEnvironment({
        APP_ENV: 'production',
        DATABASE_URL: databaseUrl,
        SESSION_COOKIE_SECURE: 'false',
      }),
    ).toThrow('SESSION_COOKIE_SECURE must be true in production');
  });

  it('requires canonical explicit local identities and origins', () => {
    const databaseUrl =
      'postgresql://running_tracker_runtime:password@127.0.0.1:5433/running_tracker';

    expect(() =>
      validateEnvironment({
        APP_ENV: 'test',
        DATABASE_URL: databaseUrl,
        LOCAL_AUTH_ENABLED: 'true',
      }),
    ).toThrow('LOCAL_AUTH_USER_IDS must contain at least one user');
    expect(() =>
      validateEnvironment({
        ALLOWED_ORIGINS: 'http://127.0.0.1:5173/',
        APP_ENV: 'test',
        DATABASE_URL: databaseUrl,
        LOCAL_AUTH_ENABLED: 'true',
        LOCAL_AUTH_USER_IDS: '11111111-1111-4111-8111-111111111111',
      }),
    ).toThrow('invalid canonical HTTP origin');
  });

  it('uses TEST_DATABASE_URL instead of DATABASE_URL for integration configuration', () => {
    const config = loadIntegrationTestConfiguration({
      envFiles: [],
      environment: {
        ...validIntegrationEnvironment,
        DATABASE_URL:
          'postgresql://running_tracker_runtime:password@127.0.0.1:5433/running_tracker',
      },
    });

    expect(config.environment.APP_ENV).toBe('test');
    expect(config.environment.DATABASE_URL).toBe(validIntegrationEnvironment.TEST_DATABASE_URL);
  });

  it('loads TEST_DATABASE_URL from an explicit env file before validation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'running-tracker-config-'));
    temporaryDirectories.push(directory);
    const envFile = join(directory, '.env');
    writeFileSync(
      envFile,
      'TEST_DATABASE_URL=postgresql://running_tracker_runtime:password@127.0.0.1:5433/from_file_test\n',
      'utf8',
    );

    const config = loadIntegrationTestConfiguration({
      envFiles: [envFile],
      environment: {
        TEST_MAINTENANCE_DATABASE_URL:
          'postgresql://running_tracker_maintenance:password@127.0.0.1:5433/from_file_test',
        TEST_MIGRATION_DATABASE_URL:
          'postgresql://running_tracker_owner:password@127.0.0.1:5433/from_file_test',
        DATABASE_URL: 'postgresql://running_tracker_runtime:password@127.0.0.1:5433/main',
      },
    });

    expect(config.environment.DATABASE_URL.endsWith('/from_file_test')).toBe(true);
  });

  it('rejects a non-test URL synchronously before a pool can be created', () => {
    expect(() =>
      loadIntegrationTestConfiguration({
        envFiles: [],
        environment: {
          ...validIntegrationEnvironment,
          TEST_DATABASE_URL:
            'postgresql://running_tracker_runtime:password@127.0.0.1:5433/production',
        },
      }),
    ).toThrow('TEST_DATABASE_URL database name must end in _test');
  });
});

describe('loadIntegrationTestConfiguration', () => {
  it('accepts role-separated URLs for the same test database', () => {
    const config = loadIntegrationTestConfiguration({
      envFiles: [],
      environment: validIntegrationEnvironment,
    });

    expect(config.environment).toMatchObject({
      APP_ENV: 'test',
      DATABASE_URL: validIntegrationEnvironment.TEST_DATABASE_URL,
    });
    expect(config.runtime).toMatchObject({
      database: 'running_tracker_test',
      user: 'running_tracker_runtime',
    });
    expect(config.migration).toMatchObject({
      database: 'running_tracker_test',
      user: 'running_tracker_owner',
    });
    expect(config.maintenance).toMatchObject({
      database: 'running_tracker_test',
      user: 'running_tracker_maintenance',
    });
  });

  it('rejects an owner URL for the main database even when runtime is isolated', () => {
    expect(() =>
      loadIntegrationTestConfiguration({
        envFiles: [],
        environment: {
          ...validIntegrationEnvironment,
          TEST_MIGRATION_DATABASE_URL:
            'postgresql://running_tracker_owner:owner-secret@localhost:5432/running_tracker',
        },
      }),
    ).toThrow('TEST_MIGRATION_DATABASE_URL database name must end in _test');
  });

  it('rejects a non-PostgreSQL protocol before any pool construction', () => {
    expect(() =>
      loadIntegrationTestConfiguration({
        envFiles: [],
        environment: {
          ...validIntegrationEnvironment,
          TEST_MAINTENANCE_DATABASE_URL:
            'https://running_tracker_maintenance:maintenance-secret@localhost:5432/running_tracker_test',
        },
      }),
    ).toThrow('TEST_MAINTENANCE_DATABASE_URL must use the postgres or postgresql protocol');
  });

  it('rejects query parameters that could override the validated connection identity', () => {
    expect(() =>
      loadIntegrationTestConfiguration({
        envFiles: [],
        environment: {
          ...validIntegrationEnvironment,
          TEST_MIGRATION_DATABASE_URL:
            'postgresql://running_tracker_owner:owner-secret@localhost/running_tracker_test?host=production.internal',
        },
      }),
    ).toThrow(
      'TEST_MIGRATION_DATABASE_URL must not override connection identity in query parameters',
    );
  });

  it.each([
    {
      field: 'host',
      migrationUrl:
        'postgresql://running_tracker_owner:owner-secret@database.internal:5432/running_tracker_test',
    },
    {
      field: 'port',
      migrationUrl:
        'postgresql://running_tracker_owner:owner-secret@localhost:5433/running_tracker_test',
    },
    {
      field: 'database',
      migrationUrl:
        'postgresql://running_tracker_owner:owner-secret@localhost:5432/other_test',
    },
  ])('rejects a different $field for one role', ({ migrationUrl }) => {
    expect(() =>
      loadIntegrationTestConfiguration({
        envFiles: [],
        environment: {
          ...validIntegrationEnvironment,
          TEST_MIGRATION_DATABASE_URL: migrationUrl,
        },
      }),
    ).toThrow('runtime, migration, and maintenance URLs must use the same host, port, and database');
  });

  it('rejects a URL authenticated as the wrong role without exposing credentials', () => {
    let thrown: unknown;
    try {
      loadIntegrationTestConfiguration({
        envFiles: [],
        environment: {
          ...validIntegrationEnvironment,
          TEST_MIGRATION_DATABASE_URL:
            'postgresql://running_tracker_runtime:owner-secret@localhost:5432/running_tracker_test',
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      'TEST_MIGRATION_DATABASE_URL must authenticate as running_tracker_owner',
    );
    expect((thrown as Error).message).not.toContain('owner-secret');
    expect((thrown as Error).message).not.toContain('postgresql://');
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

const validApplicationEnvironment = {
  DATABASE_URL:
    'postgresql://running_tracker_runtime:runtime-secret@127.0.0.1:5433/running_tracker',
  MAINTENANCE_DATABASE_URL:
    'postgresql://running_tracker_maintenance:maintenance-secret@127.0.0.1:5433/running_tracker',
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('validateEnvironment', () => {
  it('coerces bounded values and applies defaults', () => {
    const environment = validateEnvironment({
      ...validApplicationEnvironment,
      PORT: '3100',
    });

    expect(environment).toMatchObject({
      APP_ENV: 'development',
      DB_CONNECTION_TIMEOUT_MS: 2_000,
      DB_POOL_MAX: 10,
      DB_QUERY_TIMEOUT_MS: 1_000,
      PORT: 3_100,
      LIVE_TRACK_CURSOR_SIGNING_KEY:
        'cnVubmluZy10cmFja2VyLWxvY2FsLWN1cnNvci1rZXktdjE',
      LIVE_SSE_BACKPRESSURE_TIMEOUT_MS: 10_000,
      LIVE_SSE_HEARTBEAT_INTERVAL_MS: 15_000,
      LIVE_SSE_MAX_CONNECTIONS: 64,
      LIVE_SSE_POLL_CONCURRENCY: 2,
      LIVE_SSE_POLL_INTERVAL_MS: 2_000,
      RUN_AUTO_FINISH_INTERVAL_MS: 60_000,
      RUN_RAW_PURGE_INTERVAL_MS: 60_000,
      RUN_RETENTION_DELETE_INTERVAL_MS: 60_000,
      RUN_SUMMARY_CONCURRENCY: 2,
      RUN_SUMMARY_INTERVAL_MS: 60_000,
      RUN_TOMBSTONE_RECLAIM_INTERVAL_MS: 300_000,
      SHUTDOWN_TIMEOUT_MS: 5_000,
    });
  });

  it('rejects startup without a PostgreSQL URL', () => {
    expect(() => validateEnvironment({})).toThrow('Invalid environment configuration');
    expect(() =>
      validateEnvironment({
        ...validApplicationEnvironment,
        DATABASE_URL: 'https://example.com',
      }),
    ).toThrow(
      'DATABASE_URL must use the postgres or postgresql protocol',
    );
    expect(() =>
      validateEnvironment({
        ...validApplicationEnvironment,
        DATABASE_URL: 'postgresql://running_tracker_owner:password@127.0.0.1:5433/database',
      }),
    ).toThrow('DATABASE_URL must authenticate as running_tracker_runtime');
  });

  it('fails production startup before infrastructure when local auth or insecure cookies are configured', () => {
    expect(() =>
      validateEnvironment({
        ...validApplicationEnvironment,
        ALLOWED_ORIGINS: 'https://tracker.example',
        APP_ENV: 'production',
        LOCAL_AUTH_ENABLED: 'true',
        LOCAL_AUTH_USER_IDS: '11111111-1111-4111-8111-111111111111',
      }),
    ).toThrow('LOCAL_AUTH_ENABLED must be false in production');
    expect(() =>
      validateEnvironment({
        ...validApplicationEnvironment,
        APP_ENV: 'production',
        SESSION_COOKIE_SECURE: 'false',
      }),
    ).toThrow('SESSION_COOKIE_SECURE must be true in production');
    expect(() =>
      validateEnvironment({
        ...validApplicationEnvironment,
        APP_ENV: 'production',
      }),
    ).toThrow('LIVE_TRACK_CURSOR_SIGNING_KEY must be replaced in production');
  });

  it('requires explicit HTTPS origins in production', () => {
    const production = {
      ...validApplicationEnvironment,
      APP_ENV: 'production',
      DELETION_JOURNAL_DIR: resolve('/var/lib/running-tracker/deletion-journal'),
      LIVE_TRACK_CURSOR_SIGNING_KEY: Buffer.from(
        'deployment-specific-live-track-key-material',
        'utf8',
      ).toString('base64url'),
    };

    expect(() => validateEnvironment(production)).toThrow(
      'ALLOWED_ORIGINS must contain at least one origin in production',
    );
    expect(() =>
      validateEnvironment({ ...production, ALLOWED_ORIGINS: 'http://tracker.example' }),
    ).toThrow('ALLOWED_ORIGINS must contain only https origins in production');
    expect(() =>
      validateEnvironment({
        ...production,
        ALLOWED_ORIGINS: 'https://tracker.example,http://127.0.0.1:5173',
      }),
    ).toThrow('ALLOWED_ORIGINS must contain only https origins in production');
    expect(
      validateEnvironment({ ...production, ALLOWED_ORIGINS: 'https://tracker.example' })
        .ALLOWED_ORIGINS,
    ).toEqual(['https://tracker.example']);
    expect(
      validateEnvironment({ ...validApplicationEnvironment, ALLOWED_ORIGINS: 'http://127.0.0.1:5173' })
        .ALLOWED_ORIGINS,
    ).toEqual(['http://127.0.0.1:5173']);
  });

  it('requires a canonical base64url cursor key with at least 256 bits', () => {
    for (const signingKey of ['short', 'not+base64url', 'c2hvcnQ=']) {
      expect(() =>
        validateEnvironment({
          ...validApplicationEnvironment,
          LIVE_TRACK_CURSOR_SIGNING_KEY: signingKey,
        }),
      ).toThrow('LIVE_TRACK_CURSOR_SIGNING_KEY');
    }

    const productionKey = Buffer.from(
      'deployment-specific-live-track-key-material',
      'utf8',
    ).toString('base64url');
    expect(
      validateEnvironment({
        ...validApplicationEnvironment,
        ALLOWED_ORIGINS: 'https://tracker.example',
        APP_ENV: 'production',
        DELETION_JOURNAL_DIR: resolve('/var/lib/running-tracker/deletion-journal'),
        LIVE_TRACK_CURSOR_SIGNING_KEY: productionKey,
      }).LIVE_TRACK_CURSOR_SIGNING_KEY,
    ).toBe(productionKey);
  });

  it('bounds the deletion journal export settings and requires the directory in production', () => {
    const journalDirectory = resolve('/var/lib/running-tracker/deletion-journal');
    const environment = validateEnvironment({
      ...validApplicationEnvironment,
      DELETION_JOURNAL_DIR: journalDirectory,
    });
    expect(environment.DELETION_JOURNAL_DIR).toBe(journalDirectory);
    expect(environment.RUN_DELETION_JOURNAL_EXPORT_INTERVAL_MS).toBe(30_000);
    expect(validateEnvironment(validApplicationEnvironment).DELETION_JOURNAL_DIR).toBeUndefined();

    for (const interval of ['0', '-1', '1.5', 'abc', String(24 * 60 * 60 * 1_000 + 1)]) {
      expect(() =>
        validateEnvironment({
          ...validApplicationEnvironment,
          RUN_DELETION_JOURNAL_EXPORT_INTERVAL_MS: interval,
        }),
      ).toThrow('RUN_DELETION_JOURNAL_EXPORT_INTERVAL_MS');
    }
    expect(() =>
      validateEnvironment({ ...validApplicationEnvironment, DELETION_JOURNAL_DIR: 'relative/dir' }),
    ).toThrow('DELETION_JOURNAL_DIR');
    expect(() =>
      validateEnvironment({ ...validApplicationEnvironment, DELETION_JOURNAL_DIR: '' }),
    ).toThrow('DELETION_JOURNAL_DIR');
    expect(() =>
      validateEnvironment({
        ...validApplicationEnvironment,
        APP_ENV: 'production',
        LIVE_TRACK_CURSOR_SIGNING_KEY: Buffer.from(
          'deployment-specific-live-track-key-material',
          'utf8',
        ).toString('base64url'),
      }),
    ).toThrow('DELETION_JOURNAL_DIR must be set in production');
  });

  it('requires canonical explicit local identities and origins', () => {
    expect(() =>
      validateEnvironment({
        ...validApplicationEnvironment,
        APP_ENV: 'test',
        LOCAL_AUTH_ENABLED: 'true',
      }),
    ).toThrow('LOCAL_AUTH_USER_IDS must contain at least one user');
    expect(() =>
      validateEnvironment({
        ...validApplicationEnvironment,
        ALLOWED_ORIGINS: 'http://127.0.0.1:5173/',
        APP_ENV: 'test',
        LOCAL_AUTH_ENABLED: 'true',
        LOCAL_AUTH_USER_IDS: '11111111-1111-4111-8111-111111111111',
      }),
    ).toThrow('invalid canonical HTTP origin');
  });

  it('requires the maintenance role on the same database target', () => {
    expect(() =>
      validateEnvironment({
        ...validApplicationEnvironment,
        MAINTENANCE_DATABASE_URL:
          'postgresql://running_tracker_runtime:secret@127.0.0.1:5433/running_tracker',
      }),
    ).toThrow('MAINTENANCE_DATABASE_URL must authenticate as running_tracker_maintenance');
    expect(() =>
      validateEnvironment({
        ...validApplicationEnvironment,
        MAINTENANCE_DATABASE_URL:
          'postgresql://running_tracker_maintenance:secret@127.0.0.1:5433/other_database',
      }),
    ).toThrow('must target the same host, port, and database as DATABASE_URL');
  });

  it('bounds summary worker concurrency', () => {
    expect(
      validateEnvironment({
        ...validApplicationEnvironment,
        RUN_SUMMARY_CONCURRENCY: '8',
      }).RUN_SUMMARY_CONCURRENCY,
    ).toBe(8);
    expect(() =>
      validateEnvironment({
        ...validApplicationEnvironment,
        RUN_SUMMARY_CONCURRENCY: '9',
      }),
    ).toThrow('RUN_SUMMARY_CONCURRENCY');
  });

  it('bounds the tombstone reclaim interval', () => {
    expect(
      validateEnvironment({
        ...validApplicationEnvironment,
        RUN_TOMBSTONE_RECLAIM_INTERVAL_MS: '86400000',
      }).RUN_TOMBSTONE_RECLAIM_INTERVAL_MS,
    ).toBe(86_400_000);
    for (const invalid of ['0', '-1', '86400001', '1.5', 'often']) {
      expect(() =>
        validateEnvironment({
          ...validApplicationEnvironment,
          RUN_TOMBSTONE_RECLAIM_INTERVAL_MS: invalid,
        }),
      ).toThrow('RUN_TOMBSTONE_RECLAIM_INTERVAL_MS');
    }
  });

  it('keeps the metrics listener off by default and loopback-bound when enabled (P11.1)', () => {
    const defaults = validateEnvironment(validApplicationEnvironment);
    expect(defaults.METRICS_PORT).toBeUndefined();
    expect(defaults.METRICS_HOST).toBe('127.0.0.1');

    expect(
      validateEnvironment({
        ...validApplicationEnvironment,
        METRICS_HOST: '0.0.0.0',
        METRICS_PORT: '9464',
      }),
    ).toMatchObject({ METRICS_HOST: '0.0.0.0', METRICS_PORT: 9_464 });

    for (const invalid of ['0', '65536', '-1', '1.5', 'metrics', '']) {
      expect(() =>
        validateEnvironment({ ...validApplicationEnvironment, METRICS_PORT: invalid }),
      ).toThrow('METRICS_PORT');
    }
    for (const invalid of ['', 'bad host', 'http://x']) {
      expect(() =>
        validateEnvironment({ ...validApplicationEnvironment, METRICS_HOST: invalid }),
      ).toThrow('METRICS_HOST');
    }
    expect(() =>
      validateEnvironment({ ...validApplicationEnvironment, METRICS_PORT: '3000', PORT: '3000' }),
    ).toThrow('METRICS_PORT must differ from PORT');
  });

  it('bounds live SSE connections and polling concurrency', () => {
    expect(
      validateEnvironment({
        ...validApplicationEnvironment,
        LIVE_SSE_MAX_CONNECTIONS: '1000',
        LIVE_SSE_POLL_CONCURRENCY: '8',
      }),
    ).toMatchObject({ LIVE_SSE_MAX_CONNECTIONS: 1_000, LIVE_SSE_POLL_CONCURRENCY: 8 });
    expect(() =>
      validateEnvironment({
        ...validApplicationEnvironment,
        LIVE_SSE_MAX_CONNECTIONS: '1001',
      }),
    ).toThrow('LIVE_SSE_MAX_CONNECTIONS');
    expect(() =>
      validateEnvironment({
        ...validApplicationEnvironment,
        LIVE_SSE_POLL_CONCURRENCY: '9',
      }),
    ).toThrow('LIVE_SSE_POLL_CONCURRENCY');
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

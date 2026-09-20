import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadTestEnvironment, validateEnvironment } from './environment.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('validateEnvironment', () => {
  it('coerces bounded values and applies defaults', () => {
    const environment = validateEnvironment({
      DATABASE_URL: 'postgresql://user:password@127.0.0.1:5433/database',
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
  });

  it('uses TEST_DATABASE_URL instead of DATABASE_URL for integration configuration', () => {
    const environment = loadTestEnvironment({
      envFiles: [],
      environment: {
        DATABASE_URL: 'postgresql://user:password@127.0.0.1:5433/running_tracker',
        TEST_DATABASE_URL: 'postgresql://user:password@127.0.0.1:5433/running_tracker_test',
      },
    });

    expect(environment.APP_ENV).toBe('test');
    expect(environment.DATABASE_URL.endsWith('/running_tracker_test')).toBe(true);
  });

  it('loads TEST_DATABASE_URL from an explicit env file before validation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'running-tracker-config-'));
    temporaryDirectories.push(directory);
    const envFile = join(directory, '.env');
    writeFileSync(
      envFile,
      'TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5433/from_file_test\n',
      'utf8',
    );

    const environment = loadTestEnvironment({
      envFiles: [envFile],
      environment: {
        DATABASE_URL: 'postgresql://user:password@127.0.0.1:5433/main',
      },
    });

    expect(environment.DATABASE_URL.endsWith('/from_file_test')).toBe(true);
  });

  it('rejects a non-test URL synchronously before a pool can be created', () => {
    expect(() =>
      loadTestEnvironment({
        envFiles: [],
        environment: {
          TEST_DATABASE_URL: 'postgresql://user:password@127.0.0.1:5433/production',
        },
      }),
    ).toThrow('Integration tests require a database ending in _test');
  });
});

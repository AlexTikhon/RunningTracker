import { expect, test } from '@playwright/test';

import { resolveE2eEnvironment } from './support/environment.js';

const validSource = {
  TEST_DATABASE_URL:
    'postgresql://running_tracker_runtime:runtime_secret@127.0.0.1:5433/running_tracker_test',
  TEST_MAINTENANCE_DATABASE_URL:
    'postgresql://running_tracker_maintenance:maintenance_secret@127.0.0.1:5433/running_tracker_test',
  TEST_MIGRATION_DATABASE_URL:
    'postgresql://running_tracker_owner:owner_secret@127.0.0.1:5433/running_tracker_test',
};

test.describe('environment guard', () => {
  test('resolves a valid set of test database URLs', () => {
    const environment = resolveE2eEnvironment(validSource);

    expect(environment.apiOrigin).toBe('http://127.0.0.1:3100');
    expect(environment.webOrigin).toBe('http://127.0.0.1:5273');
    expect(environment.runtimeDatabaseUrl).toBe(validSource.TEST_DATABASE_URL);
    expect(environment.maintenanceDatabaseUrl).toBe(validSource.TEST_MAINTENANCE_DATABASE_URL);
    expect(environment.ownerDatabaseUrl).toBe(validSource.TEST_MIGRATION_DATABASE_URL);
  });

  test('returns the two fixed user ids', () => {
    const environment = resolveE2eEnvironment(validSource);

    expect(environment.runnerUserId).toBe('eeeeeeee-eeee-4eee-8eee-eeeeeeee0001');
    expect(environment.coachUserId).toBe('eeeeeeee-eeee-4eee-8eee-eeeeeeee0002');
  });

  for (const name of [
    'TEST_DATABASE_URL',
    'TEST_MAINTENANCE_DATABASE_URL',
    'TEST_MIGRATION_DATABASE_URL',
  ] as const) {
    test(`names ${name} when it is unset`, () => {
      const source: Record<string, string | undefined> = { ...validSource };
      delete source[name];

      expect(() => resolveE2eEnvironment(source)).toThrow(name);
    });

    test(`names ${name} when it is blank`, () => {
      expect(() => resolveE2eEnvironment({ ...validSource, [name]: '  ' })).toThrow(name);
    });

    test(`rejects a ${name} whose database name does not end in _test`, () => {
      const developmentUrl = validSource[name].replace('running_tracker_test', 'running_tracker');
      const source = { ...validSource, [name]: developmentUrl };

      expect(() => resolveE2eEnvironment(source)).toThrow(/"running_tracker"/);
      expect(() => resolveE2eEnvironment(source)).toThrow(name);
    });
  }

  test('rejects a single development URL among otherwise valid test URLs', () => {
    const source = {
      ...validSource,
      TEST_MIGRATION_DATABASE_URL: validSource.TEST_MIGRATION_DATABASE_URL.replace(
        'running_tracker_test',
        'running_tracker',
      ),
    };

    expect(() => resolveE2eEnvironment(source)).toThrow(/"running_tracker"/);
  });

  test('never echoes a password in an error message', () => {
    const source = {
      ...validSource,
      TEST_DATABASE_URL: validSource.TEST_DATABASE_URL.replace(
        'running_tracker_test',
        'running_tracker',
      ),
    };

    expect(() => resolveE2eEnvironment(source)).toThrow(/^(?:(?!runtime_secret)[\s\S])*$/);
  });

  test('rejects URLs that do not share host, port and database', () => {
    expect(() =>
      resolveE2eEnvironment({
        ...validSource,
        TEST_MAINTENANCE_DATABASE_URL: validSource.TEST_MAINTENANCE_DATABASE_URL.replace(
          'running_tracker_test',
          'other_test',
        ),
      }),
    ).toThrow(/same host, port and database/);

    expect(() =>
      resolveE2eEnvironment({
        ...validSource,
        TEST_MIGRATION_DATABASE_URL: validSource.TEST_MIGRATION_DATABASE_URL.replace(
          ':5433/',
          ':5434/',
        ),
      }),
    ).toThrow(/same host, port and database/);

    expect(() =>
      resolveE2eEnvironment({
        ...validSource,
        TEST_DATABASE_URL: validSource.TEST_DATABASE_URL.replace('127.0.0.1', 'localhost'),
      }),
    ).toThrow(/same host, port and database/);
  });
});

import { describe, expect, it } from 'vitest';

import { buildApiEnvironment, ServerLogTally } from './load-api-process.js';
import { parseLoadTarget } from './load-target.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';

const target = parseLoadTarget(
  {
    LOAD_DATABASE_URL: 'postgresql://running_tracker_owner:owner-pw@127.0.0.1:5433/running_tracker_load_test',
    LOAD_MAINTENANCE_DATABASE_URL:
      'postgresql://running_tracker_maintenance:maint-pw@127.0.0.1:5433/running_tracker_load_test',
    LOAD_RUNTIME_DATABASE_URL: 'postgresql://running_tracker_runtime:run-pw@127.0.0.1:5433/running_tracker_load_test',
  },
  ['_load_test'],
);

describe('buildApiEnvironment', () => {
  const inherited = {
    APP_ENV: 'production',
    BOOTSTRAP_DATABASE_URL: 'postgresql://running_tracker:x@127.0.0.1:5433/running_tracker',
    DATABASE_URL: 'postgresql://running_tracker_runtime:x@127.0.0.1:5433/running_tracker',
    LOAD_DATABASE_URL: target.owner.connectionString,
    LOCAL_AUTH_ENABLED: 'false',
    MAINTENANCE_DATABASE_URL: 'postgresql://running_tracker_maintenance:x@127.0.0.1:5433/running_tracker',
    MIGRATION_DATABASE_URL: 'postgresql://running_tracker_owner:x@127.0.0.1:5433/running_tracker',
    PATH: '/usr/bin',
    PORT: '3000',
    RUN_SUMMARY_INTERVAL_MS: '1234',
    TEST_DATABASE_URL: 'postgresql://running_tracker_runtime:x@127.0.0.1:5433/running_tracker_test',
  };

  const environment = buildApiEnvironment(inherited, {
    metricsPort: 9_999,
    origin: 'http://127.0.0.1:5173',
    port: 8_888,
    target,
    userIds: [ownerId, otherId],
  });

  it('points the API at the load database with the runtime and maintenance roles only', () => {
    expect(environment.DATABASE_URL).toBe(target.runtime.connectionString);
    expect(environment.MAINTENANCE_DATABASE_URL).toBe(target.maintenance.connectionString);
  });

  it('drops every other database URL, including the owner and bootstrap credentials', () => {
    for (const key of Object.keys(environment)) {
      if (key.endsWith('DATABASE_URL') && key !== 'DATABASE_URL' && key !== 'MAINTENANCE_DATABASE_URL') {
        throw new Error(`unexpected inherited database variable ${key}`);
      }
    }
    expect(JSON.stringify(environment)).not.toContain('owner-pw');
    expect(JSON.stringify(environment)).not.toContain('running_tracker:x@');
  });

  it('enables local sessions for exactly the planned members and never for production', () => {
    expect(environment.LOCAL_AUTH_ENABLED).toBe('true');
    expect(environment.LOCAL_AUTH_USER_IDS).toBe(`${ownerId},${otherId}`);
    expect(environment.APP_ENV).toBe('test');
    expect(environment.SESSION_COOKIE_SECURE).toBe('false');
    expect(environment.ALLOWED_ORIGINS).toBe('http://127.0.0.1:5173');
  });

  it('binds the listeners the runner will talk to and keeps unrelated tuning values untouched', () => {
    expect(environment.PORT).toBe('8888');
    expect(environment.METRICS_PORT).toBe('9999');
    expect(environment.METRICS_HOST).toBe('127.0.0.1');
    expect(environment.RUN_SUMMARY_INTERVAL_MS).toBe('1234');
    expect(environment.PATH).toBe('/usr/bin');
  });

  it('keeps the aging-data jobs from rewriting the dataset unless the caller opts in', () => {
    const day = String(24 * 60 * 60 * 1_000);
    expect(environment.RUN_RAW_PURGE_INTERVAL_MS).toBe(day);
    expect(environment.RUN_RETENTION_DELETE_INTERVAL_MS).toBe(day);
    expect(environment.RUN_TOMBSTONE_RECLAIM_INTERVAL_MS).toBe(day);
    // The summary worker is part of the workload, so it keeps the caller's or the default cadence.
    expect(environment.RUN_SUMMARY_INTERVAL_MS).toBe('1234');

    const optedIn = buildApiEnvironment(
      { ...inherited, LOAD_KEEP_RETENTION_JOBS: 'true', RUN_RETENTION_DELETE_INTERVAL_MS: '5000' },
      { metricsPort: 9_999, origin: 'http://127.0.0.1:5173', port: 8_888, target, userIds: [ownerId] },
    );
    expect(optedIn.RUN_RETENTION_DELETE_INTERVAL_MS).toBe('5000');
    expect(optedIn.RUN_RAW_PURGE_INTERVAL_MS).toBeUndefined();
  });

  it('refuses to enable local sessions for an empty member list', () => {
    expect(() =>
      buildApiEnvironment(inherited, { metricsPort: 1, origin: 'http://127.0.0.1:5173', port: 2, target, userIds: [] }),
    ).toThrow();
  });
});

describe('ServerLogTally', () => {
  it('counts levels and event names from JSON lines and ignores anything else', () => {
    const tally = new ServerLogTally();
    tally.add('{"event":"api.listening","level":"info","port":1}');
    tally.add('{"event":"live.poll.failed","level":"error","errorCode":"X"}');
    tally.add('{"event":"live.poll.failed","level":"error"}');
    tally.add('{"event":"retention.raw_purge.overdue","level":"warn"}');
    tally.add('plain text that is not JSON');
    tally.add('{"level":"error"}');
    expect(tally.summary()).toEqual({
      byEvent: { 'api.listening': 1, 'live.poll.failed': 2, 'retention.raw_purge.overdue': 1, unknown: 1 },
      errorLines: 3,
      warnLines: 1,
    });
  });

  it('bounds the number of distinct events it remembers', () => {
    const tally = new ServerLogTally();
    for (let index = 0; index < 500; index += 1) {
      tally.add(`{"event":"e${index}","level":"info"}`);
    }
    expect(Object.keys(tally.summary().byEvent).length).toBeLessThanOrEqual(65);
  });
});

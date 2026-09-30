import { describe, expect, it } from 'vitest';

import { assertConnectedIdentity, loadTargetVariables, parseLoadTarget } from './load-target.js';

const secret = 'sup3r-s3cret-pw';

function urlFor(user: string, database: string, host = '127.0.0.1', port = '5433'): string {
  return `postgresql://${user}:${secret}@${host}:${port}/${database}`;
}

function environment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    LOAD_DATABASE_URL: urlFor('running_tracker_owner', 'running_tracker_load_test'),
    LOAD_MAINTENANCE_DATABASE_URL: urlFor('running_tracker_maintenance', 'running_tracker_load_test'),
    LOAD_RUNTIME_DATABASE_URL: urlFor('running_tracker_runtime', 'running_tracker_load_test'),
    ...overrides,
  };
}

const allowed = ['_load_test'] as const;

describe('parseLoadTarget', () => {
  it('accepts three role URLs for one dedicated loopback load database', () => {
    const target = parseLoadTarget(environment(), allowed);
    expect(target.database).toBe('running_tracker_load_test');
    expect(target.host).toBe('127.0.0.1');
    expect(target.port).toBe('5433');
    expect(target.owner.user).toBe('running_tracker_owner');
    expect(target.runtime.user).toBe('running_tracker_runtime');
    expect(target.maintenance.user).toBe('running_tracker_maintenance');
  });

  it('accepts localhost and ::1 as loopback hosts', () => {
    for (const host of ['localhost', '[::1]']) {
      const target = parseLoadTarget(
        environment({
          LOAD_DATABASE_URL: urlFor('running_tracker_owner', 'x_load_test', host),
          LOAD_MAINTENANCE_DATABASE_URL: urlFor('running_tracker_maintenance', 'x_load_test', host),
          LOAD_RUNTIME_DATABASE_URL: urlFor('running_tracker_runtime', 'x_load_test', host),
        }),
        allowed,
      );
      expect(target.database).toBe('x_load_test');
    }
  });

  it('names every variable that is missing', () => {
    for (const variable of loadTargetVariables) {
      expect(() => parseLoadTarget(environment({ [variable]: undefined }), allowed)).toThrow(variable);
    }
  });

  it('refuses the development, test, and production-shaped databases', () => {
    for (const database of ['running_tracker', 'running_tracker_test', 'prod', 'running_tracker_load_test_backup']) {
      expect(() =>
        parseLoadTarget(
          environment({
            LOAD_DATABASE_URL: urlFor('running_tracker_owner', database),
            LOAD_MAINTENANCE_DATABASE_URL: urlFor('running_tracker_maintenance', database),
            LOAD_RUNTIME_DATABASE_URL: urlFor('running_tracker_runtime', database),
          }),
          allowed,
        ),
        database,
      ).toThrow(/_load_test/u);
    }
  });

  it('lets a caller widen the allowed suffix only explicitly', () => {
    const custom = environment({
      LOAD_DATABASE_URL: urlFor('running_tracker_owner', 'running_tracker_test'),
      LOAD_MAINTENANCE_DATABASE_URL: urlFor('running_tracker_maintenance', 'running_tracker_test'),
      LOAD_RUNTIME_DATABASE_URL: urlFor('running_tracker_runtime', 'running_tracker_test'),
    });
    expect(() => parseLoadTarget(custom, allowed)).toThrow();
    expect(parseLoadTarget(custom, ['_test']).database).toBe('running_tracker_test');
  });

  it('refuses a non-loopback host', () => {
    for (const host of ['db.example.com', '10.1.2.3', '192.168.0.9', '0.0.0.0']) {
      expect(() =>
        parseLoadTarget(
          environment({ LOAD_DATABASE_URL: urlFor('running_tracker_owner', 'running_tracker_load_test', host) }),
          allowed,
        ),
        host,
      ).toThrow(/loopback/u);
    }
  });

  it('refuses URLs that disagree about host, port, or database', () => {
    expect(() =>
      parseLoadTarget(
        environment({ LOAD_RUNTIME_DATABASE_URL: urlFor('running_tracker_runtime', 'other_load_test') }),
        allowed,
      ),
    ).toThrow(/same/u);
    expect(() =>
      parseLoadTarget(
        environment({
          LOAD_MAINTENANCE_DATABASE_URL: urlFor('running_tracker_maintenance', 'running_tracker_load_test', '127.0.0.1', '5544'),
        }),
        allowed,
      ),
    ).toThrow(/same/u);
  });

  it('refuses the wrong role, identity overrides in the query string, and non-PostgreSQL URLs', () => {
    expect(() =>
      parseLoadTarget(
        environment({ LOAD_RUNTIME_DATABASE_URL: urlFor('running_tracker_owner', 'running_tracker_load_test') }),
        allowed,
      ),
    ).toThrow(/running_tracker_runtime/u);
    expect(() =>
      parseLoadTarget(
        environment({
          LOAD_DATABASE_URL: `${urlFor('running_tracker_owner', 'running_tracker_load_test')}?dbname=running_tracker`,
        }),
        allowed,
      ),
    ).toThrow(/override/u);
    expect(() => parseLoadTarget(environment({ LOAD_DATABASE_URL: 'mysql://x:y@127.0.0.1/z_load_test' }), allowed)).toThrow();
    expect(() => parseLoadTarget(environment({ LOAD_DATABASE_URL: 'not a url' }), allowed)).toThrow();
  });

  it('never puts a password in an error message', () => {
    const attempts = [
      environment({ LOAD_DATABASE_URL: urlFor('running_tracker_owner', 'running_tracker') }),
      environment({ LOAD_RUNTIME_DATABASE_URL: urlFor('running_tracker_owner', 'running_tracker_load_test') }),
      environment({ LOAD_DATABASE_URL: urlFor('running_tracker_owner', 'running_tracker_load_test', 'db.example.com') }),
    ];
    for (const attempt of attempts) {
      try {
        parseLoadTarget(attempt, allowed);
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as Error).message).not.toContain(secret);
      }
    }
  });
});

describe('assertConnectedIdentity', () => {
  function client(row: { current_database: string; current_user: string }) {
    return { query: () => Promise.resolve({ rows: [row] }) };
  }

  it('passes when the live session matches the expected database and role', async () => {
    await expect(
      assertConnectedIdentity(
        client({ current_database: 'running_tracker_load_test', current_user: 'running_tracker_owner' }),
        { database: 'running_tracker_load_test', user: 'running_tracker_owner' },
        allowed,
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses a session that landed somewhere else, whatever the URL said', async () => {
    await expect(
      assertConnectedIdentity(
        client({ current_database: 'running_tracker', current_user: 'running_tracker_owner' }),
        { database: 'running_tracker_load_test', user: 'running_tracker_owner' },
        allowed,
      ),
    ).rejects.toThrow(/database/u);
    await expect(
      assertConnectedIdentity(
        client({ current_database: 'running_tracker_load_test', current_user: 'postgres' }),
        { database: 'running_tracker_load_test', user: 'running_tracker_owner' },
        allowed,
      ),
    ).rejects.toThrow(/role/u);
    await expect(
      assertConnectedIdentity(
        client({ current_database: 'running_tracker', current_user: 'running_tracker_owner' }),
        { database: 'running_tracker', user: 'running_tracker_owner' },
        allowed,
      ),
    ).rejects.toThrow(/_load_test/u);
  });
});

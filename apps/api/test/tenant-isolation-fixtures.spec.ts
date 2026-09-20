import type { Pool, PoolClient, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { prepareTenantIsolationFixtures } from './tenant-isolation-fixtures.js';

function queryResult<Row extends Record<string, unknown>>(
  command: string,
  rows: Row[],
): QueryResult<Row> {
  return { command, fields: [], oid: 0, rowCount: rows.length, rows };
}

describe('prepareTenantIsolationFixtures', () => {
  it.each([
    {
      actual: { database_name: 'running_tracker', role_name: 'running_tracker_owner' },
      field: 'database',
    },
    {
      actual: { database_name: 'running_tracker_test', role_name: 'running_tracker_runtime' },
      field: 'role',
    },
  ])('performs no fixture mutations when the actual $field differs', async ({ actual }) => {
    const query = vi.fn(() => Promise.resolve(queryResult('SELECT', [actual])));
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = {
      connect: vi.fn(() => Promise.resolve(client)),
    } as Pick<Pool, 'connect'>;

    await expect(
      prepareTenantIsolationFixtures(pool, {
        connectionString: 'not-used-by-the-connected-client',
        database: 'running_tracker_test',
        user: 'running_tracker_owner',
      }),
    ).rejects.toThrow(
      'Tenant fixture owner connection does not match the validated database and role',
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      'SELECT current_database() AS database_name, current_user AS role_name',
    );
    expect(query.mock.calls.some(([text]) => /\b(?:DELETE|INSERT)\b/u.test(String(text)))).toBe(
      false,
    );
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });
});

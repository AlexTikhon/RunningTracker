import type { Pool, PoolClient, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  TenantTransactionCommitError,
  TenantTransactionRolledBackError,
  withTenantTransaction,
} from './tenant-transaction.js';

const context = {
  orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userId: '11111111-1111-4111-8111-111111111111',
};

function queryResult(command: string): QueryResult<Record<string, never>> {
  return { command, fields: [], oid: 0, rowCount: 0, rows: [] };
}

function defaultQueryResult(text: string): QueryResult<Record<string, never>> {
  if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
    return queryResult(text);
  }
  return queryResult('SELECT');
}

function createHarness(
  queryImplementation?: (text: string) => Promise<QueryResult<Record<string, never>>>,
) {
  const release = vi.fn();
  const query = vi.fn((text: string) =>
    queryImplementation?.(text) ?? Promise.resolve(defaultQueryResult(text)),
  );
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn(() => Promise.resolve(client));
  const pool = { connect } as Pick<Pool, 'connect'>;
  return { client, connect, pool, query, release };
}

describe('withTenantTransaction', () => {
  it('sets transaction-local context and commits using one client', async () => {
    const harness = createHarness();
    const callback = vi.fn(() => Promise.resolve('result'));

    await expect(withTenantTransaction(harness.pool, context, callback)).resolves.toBe('result');

    expect(callback).toHaveBeenCalledWith(harness.client);
    expect(harness.query.mock.calls).toEqual([
      ['BEGIN'],
      ["SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)", [context.userId, context.orgId]],
      ['COMMIT'],
    ]);
    expect(harness.release).toHaveBeenCalledWith(undefined);
  });

  it('rolls back and preserves the callback error', async () => {
    const harness = createHarness();
    const callbackError = new Error('callback failed');

    await expect(
      withTenantTransaction(harness.pool, context, () => Promise.reject(callbackError)),
    ).rejects.toBe(callbackError);

    expect(harness.query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    expect(harness.release).toHaveBeenCalledWith(undefined);
  });

  it('destroys the client when rollback fails without replacing the callback error', async () => {
    const rollbackError = new Error('rollback failed');
    const harness = createHarness((text) =>
      text === 'ROLLBACK'
        ? Promise.reject(rollbackError)
        : Promise.resolve(defaultQueryResult(text)),
    );
    const callbackError = new Error('callback failed');

    await expect(
      withTenantTransaction(harness.pool, context, () => Promise.reject(callbackError)),
    ).rejects.toBe(callbackError);

    expect(harness.release).toHaveBeenCalledWith(rollbackError);
    expect(Reflect.get(callbackError, 'rollbackError')).toBe(rollbackError);
  });

  it('reports an unknown commit outcome and destroys the client', async () => {
    const commitError = new Error('connection lost');
    const harness = createHarness((text) =>
      text === 'COMMIT'
        ? Promise.reject(commitError)
        : Promise.resolve(defaultQueryResult(text)),
    );

    await expect(
      withTenantTransaction(harness.pool, context, () => Promise.resolve()),
    ).rejects.toMatchObject({
      cause: commitError,
      name: TenantTransactionCommitError.name,
    });
    expect(harness.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(harness.release).toHaveBeenCalledWith(commitError);
  });

  it('rejects a callback result when PostgreSQL confirms COMMIT as ROLLBACK', async () => {
    const harness = createHarness((text) =>
      Promise.resolve(queryResult(text === 'COMMIT' ? 'ROLLBACK' : defaultQueryResult(text).command)),
    );

    await expect(
      withTenantTransaction(harness.pool, context, () => Promise.resolve('not committed')),
    ).rejects.toBeInstanceOf(TenantTransactionRolledBackError);

    expect(harness.query.mock.calls.at(-1)).toEqual(['COMMIT']);
    expect(harness.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(harness.release).toHaveBeenCalledWith(undefined);
  });

  it('treats an unexpected COMMIT command as an unknown outcome and destroys the client', async () => {
    const harness = createHarness((text) =>
      Promise.resolve(queryResult(text === 'COMMIT' ? 'UPDATE' : defaultQueryResult(text).command)),
    );

    await expect(
      withTenantTransaction(harness.pool, context, () => Promise.resolve()),
    ).rejects.toBeInstanceOf(TenantTransactionCommitError);

    expect(harness.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(harness.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it('rejects invalid context before acquiring a connection', async () => {
    const harness = createHarness();

    await expect(
      withTenantTransaction(harness.pool, { ...context, userId: 'not-a-uuid' }, () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow('userId must be a canonical UUID');
    expect(harness.connect).not.toHaveBeenCalled();
  });
});

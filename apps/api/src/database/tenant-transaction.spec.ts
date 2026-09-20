import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  TenantTransactionCommitError,
  withTenantTransaction,
} from './tenant-transaction.js';

const context = {
  orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userId: '11111111-1111-4111-8111-111111111111',
};

function createHarness(queryImplementation?: (text: string) => Promise<unknown>) {
  const release = vi.fn();
  const query = vi.fn((text: string) => queryImplementation?.(text) ?? Promise.resolve({ rows: [] }));
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
      text === 'ROLLBACK' ? Promise.reject(rollbackError) : Promise.resolve({ rows: [] }),
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
      text === 'COMMIT' ? Promise.reject(commitError) : Promise.resolve({ rows: [] }),
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

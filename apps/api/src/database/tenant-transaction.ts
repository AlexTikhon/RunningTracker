import type { Pool, PoolClient } from 'pg';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface TenantContext {
  orgId: string;
  userId: string;
}

export class TenantTransactionCommitError extends Error {
  public constructor(cause: unknown) {
    super('Tenant transaction commit failed; the database outcome is unknown', { cause });
    this.name = 'TenantTransactionCommitError';
  }
}

function validatedUuid(name: keyof TenantContext, value: string): string {
  if (!uuidPattern.test(value)) {
    throw new TypeError(`${name} must be a canonical UUID`);
  }
  return value.toLowerCase();
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback, { cause: error });
}

function recordRollbackFailure(originalError: unknown, rollbackError: unknown): void {
  if (originalError instanceof Error) {
    try {
      Object.defineProperty(originalError, 'rollbackError', {
        configurable: true,
        enumerable: false,
        value: rollbackError,
      });
    } catch {
      // A frozen callback error still takes precedence over the rollback failure.
    }
  }
}

export async function withTenantTransaction<Result>(
  pool: Pick<Pool, 'connect'>,
  context: TenantContext,
  callback: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const userId = validatedUuid('userId', context.userId);
  const orgId = validatedUuid('orgId', context.orgId);
  const client = await pool.connect();
  let phase: 'connected' | 'begun' | 'committing' | 'complete' = 'connected';
  let destroyReason: Error | undefined;

  try {
    await client.query('BEGIN');
    phase = 'begun';
    await client.query(
      "SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)",
      [userId, orgId],
    );

    const result = await callback(client);
    phase = 'committing';
    try {
      await client.query('COMMIT');
    } catch (error) {
      destroyReason = asError(error, 'Tenant transaction commit failed');
      throw new TenantTransactionCommitError(error);
    }
    phase = 'complete';
    return result;
  } catch (error) {
    if (phase === 'begun') {
      try {
        await client.query('ROLLBACK');
        phase = 'complete';
      } catch (rollbackError) {
        destroyReason = asError(rollbackError, 'Tenant transaction rollback failed');
        recordRollbackFailure(error, rollbackError);
      }
    } else if (phase === 'connected') {
      destroyReason = asError(error, 'Tenant transaction setup failed');
    }
    throw error;
  } finally {
    client.release(destroyReason);
  }
}

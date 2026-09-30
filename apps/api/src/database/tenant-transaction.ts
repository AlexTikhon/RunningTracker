import type { Pool, PoolClient } from 'pg';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface TenantContext {
  orgId: string;
  userId: string;
  /**
   * Narrows what the run visibility policies return for the whole transaction. `live` limits reads of
   * runs and points to recording or paused runs; it can only remove rows, never add one (migration 0019),
   * so it is safe to omit and is used only by callers that read a handful of live rows.
   */
  visibilityScope?: 'live';
}

export class TenantTransactionCommitError extends Error {
  public constructor(cause: unknown) {
    super('Tenant transaction commit failed; the database outcome is unknown', { cause });
    this.name = 'TenantTransactionCommitError';
  }
}

export class TenantTransactionRolledBackError extends Error {
  public constructor() {
    super('Tenant transaction was rolled back by PostgreSQL; the callback result was not committed');
    this.name = 'TenantTransactionRolledBackError';
  }
}

function validatedUuid(name: keyof TenantContext, value: string): string {
  if (!uuidPattern.test(value)) {
    throw new TypeError(`${name} must be a canonical UUID`);
  }
  return value.toLowerCase();
}

function validatedVisibilityScope(value: unknown): 'live' | undefined {
  if (value === undefined || value === 'live') {
    return value;
  }
  throw new TypeError("visibilityScope must be omitted or 'live'");
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

/**
 * Owns client checkout/release and the outer BEGIN/COMMIT/ROLLBACK boundary.
 * The callback may issue application SQL (including savepoints), but must not
 * finish the outer transaction or release the provided client.
 */
export async function withTenantTransaction<Result>(
  pool: Pick<Pool, 'connect'>,
  context: TenantContext,
  callback: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const userId = validatedUuid('userId', context.userId);
  const orgId = validatedUuid('orgId', context.orgId);
  const visibilityScope = validatedVisibilityScope(context.visibilityScope);
  const client = await pool.connect();
  let phase: 'connected' | 'begun' | 'committing' | 'complete' = 'connected';
  let destroyReason: Error | undefined;

  try {
    await client.query('BEGIN');
    phase = 'begun';
    await (visibilityScope
      ? client.query(
          "SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true), set_config('app.visibility_scope', $3, true)",
          [userId, orgId, visibilityScope],
        )
      : client.query(
          "SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)",
          [userId, orgId],
        ));

    const result = await callback(client);
    phase = 'committing';
    let commitCommand: string | undefined;
    try {
      const commitResult = await client.query('COMMIT');
      commitCommand = commitResult.command;
    } catch (error) {
      destroyReason = asError(error, 'Tenant transaction commit failed');
      throw new TenantTransactionCommitError(error);
    }

    if (commitCommand === 'ROLLBACK') {
      phase = 'complete';
      throw new TenantTransactionRolledBackError();
    }
    if (commitCommand !== 'COMMIT') {
      const error = new Error(
        `Unexpected PostgreSQL COMMIT result: ${commitCommand ?? 'missing command'}`,
      );
      destroyReason = error;
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

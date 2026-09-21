import type { Pool, PoolClient } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import { ApiError } from '../http/errors.js';
import { withTenantTransaction } from './tenant-transaction.js';

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export async function withAuthenticatedTenantTransaction<Result>(
  pool: Pick<Pool, 'connect'>,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  callback: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  if (!canonicalUuidPattern.test(orgId)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'orgId must be a canonical UUID');
  }
  return withTenantTransaction(pool, { orgId, userId: session.userId }, async (client) => {
    const membership = await client.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM memberships
         WHERE org_id = $1 AND user_id = $2 AND active
       ) AS allowed`,
      [orgId, session.userId],
    );

    if (membership.rows[0]?.allowed !== true) {
      throw new ApiError(403, 'ORG_ACCESS_DENIED', 'The current identity cannot access this organization');
    }

    return callback(client);
  });
}

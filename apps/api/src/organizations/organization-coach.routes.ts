import {
  organizationCoachListResponseSchema,
  organizationPathSchema,
  type OrganizationCoachListResponse,
} from '@running-tracker/contracts';
import type { Router } from 'express';
import { Router as createRouter } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { createSessionAuthentication, getAuthenticatedSession } from '../auth/session-http.js';
import type { SessionManager } from '../auth/session-manager.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { ApiError } from '../http/errors.js';

interface OrganizationCoachRouterDependencies {
  pool: Pick<Pool, 'connect'>;
  sessionManager: SessionManager;
}

// A query string of any kind is refused rather than ignored, so nothing here can be read as a filter by role,
// organization or person.
const noQuerySchema = z.strictObject({});

// The database function answers for the organization and identity the transaction was opened for (migration 0024):
// active coaches only, never the caller.
export async function listOrganizationCoaches(client: PoolClient): Promise<OrganizationCoachListResponse> {
  const result = await client.query<{ user_id: string }>(
    'SELECT app_private.list_current_org_coaches() AS user_id',
  );
  return organizationCoachListResponseSchema.parse({
    items: result.rows.map((row) => ({ userId: row.user_id })),
  });
}

export function createOrganizationCoachRouter({ pool, sessionManager }: OrganizationCoachRouterDependencies): Router {
  const router = createRouter({ mergeParams: true });
  const authenticate = createSessionAuthentication(sessionManager);

  router.get('/', authenticate, async (request, response, next) => {
    try {
      const path = organizationPathSchema.safeParse(request.params);
      const query = noQuerySchema.safeParse(request.query);
      if (!path.success || !query.success) {
        throw new ApiError(400, 'INVALID_REQUEST', 'The coach list takes an organization id and no parameters', {
          fields: [...(path.error?.issues ?? []), ...(query.error?.issues ?? [])].map(({ message, path: field }) => ({
            message,
            path: field,
          })),
        });
      }
      const session = getAuthenticatedSession(request);
      // The membership is checked inside the transaction: a non-member is refused before the function is asked.
      const result = await withAuthenticatedTenantTransaction(
        pool,
        session,
        path.data.orgId.toLowerCase(),
        listOrganizationCoaches,
      );
      // Per-identity data: never stored by a cache that does not know the session.
      response.setHeader('Cache-Control', 'no-store');
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

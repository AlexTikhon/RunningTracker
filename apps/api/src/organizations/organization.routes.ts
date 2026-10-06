import { organizationListResponseSchema, type OrganizationListResponse } from '@running-tracker/contracts';
import type { Router } from 'express';
import { Router as createRouter } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { createSessionAuthentication, getAuthenticatedSession } from '../auth/session-http.js';
import type { SessionManager } from '../auth/session-manager.js';
import { withUserTransaction } from '../database/tenant-transaction.js';
import { ApiError } from '../http/errors.js';

interface OrganizationRouterDependencies {
  pool: Pick<Pool, 'connect'>;
  sessionManager: SessionManager;
}

// The identity is the session's. A query string of any kind is refused rather than ignored, so nothing here can
// be mistaken for a way to ask about another user.
const noQuerySchema = z.strictObject({});

// The database function answers for the identity the transaction was opened for and nobody else (migration 0022).
export async function listMemberOrganizations(client: PoolClient): Promise<OrganizationListResponse> {
  const result = await client.query<{ organization_id: string }>(
    'SELECT app_private.list_current_user_organizations() AS organization_id',
  );
  return organizationListResponseSchema.parse({
    items: result.rows.map((row) => ({ organizationId: row.organization_id })),
  });
}

export function createOrganizationRouter({ pool, sessionManager }: OrganizationRouterDependencies): Router {
  const router = createRouter();
  const authenticate = createSessionAuthentication(sessionManager);

  router.get('/', authenticate, async (request, response, next) => {
    try {
      const query = noQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw new ApiError(400, 'INVALID_REQUEST', 'The organization list takes no parameters', {
          fields: query.error.issues.map(({ message, path }) => ({ message, path })),
        });
      }
      const session = getAuthenticatedSession(request);
      const result = await withUserTransaction(pool, { userId: session.userId }, listMemberOrganizations);
      // Per-identity data: never stored by a cache that does not know the session.
      response.setHeader('Cache-Control', 'no-store');
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

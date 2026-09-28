import { organizationPathSchema } from '@running-tracker/contracts';
import type { Router } from 'express';
import { Router as createRouter } from 'express';

import {
  createSessionAuthentication,
  getAuthenticatedSession,
} from '../auth/session-http.js';
import type { SessionManager } from '../auth/session-manager.js';
import { ApiError } from '../http/errors.js';
import type { LiveConnectionManager } from './live-sse.js';

export function createLiveRouter(
  sessionManager: SessionManager,
  liveConnections: LiveConnectionManager,
): Router {
  const router = createRouter({ mergeParams: true });
  const authenticate = createSessionAuthentication(sessionManager);

  router.get('/', authenticate, async (request, response, next) => {
    try {
      const acceptsEventStream = request
        .header('accept')
        ?.split(',')
        .some((candidate) => candidate.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream');
      if (!acceptsEventStream) {
        throw new ApiError(406, 'SSE_ACCEPT_REQUIRED', 'Accept must allow text/event-stream');
      }
      const path = organizationPathSchema.safeParse(request.params);
      if (!path.success) {
        throw new ApiError(400, 'INVALID_REQUEST', 'The organization path is invalid', {
          fields: path.error.issues.map(({ message, path: issuePath }) => ({
            message,
            path: issuePath,
          })),
        });
      }
      await liveConnections.connect(
        {
          orgId: path.data.orgId.toLowerCase(),
          session: getAuthenticatedSession(request),
        },
        request,
        response,
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}

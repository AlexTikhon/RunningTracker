import type { Request, RequestHandler, Router } from 'express';
import { Router as createRouter } from 'express';
import { z } from 'zod';

import type { Environment } from '../config/environment.js';
import { ApiError } from '../http/errors.js';
import type { SessionManager } from './session-manager.js';
import { SessionStoreCapacityError, type StoredSession } from './session-store.js';

export const sessionCookieName = 'running_tracker_session';
export const csrfHeaderName = 'x-csrf-token';

const localSessionRequestSchema = z.strictObject({ userId: z.uuid() });
const authenticatedSessionKey = Symbol('authenticatedSession');
const sessionTokenKey = Symbol('sessionToken');

type AuthenticatedRequest = Request & {
  [authenticatedSessionKey]?: StoredSession;
  [sessionTokenKey]?: string;
};

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 ? values[0] : undefined;
}

function sessionCookie(token: string, config: Environment): string {
  const maxAgeSeconds = Math.max(1, Math.floor(config.SESSION_TTL_MS / 1_000));
  return [
    `${sessionCookieName}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    ...(config.SESSION_COOKIE_SECURE ? ['Secure'] : []),
  ].join('; ');
}

function clearedSessionCookie(config: Environment): string {
  return [
    `${sessionCookieName}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(config.SESSION_COOKIE_SECURE ? ['Secure'] : []),
  ].join('; ');
}

function requireAllowedOrigin(config: Environment): RequestHandler {
  return (request, _response, next) => {
    const origin = request.header('origin');
    if (!origin || origin === 'null' || !config.ALLOWED_ORIGINS.includes(origin)) {
      next(new ApiError(403, 'ORIGIN_DENIED', 'The request origin is not allowed'));
      return;
    }
    next();
  };
}

const requireJson: RequestHandler = (request, _response, next) => {
  if (!request.is('application/json')) {
    next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
    return;
  }
  next();
};

export function createSessionAuthentication(sessionManager: SessionManager): RequestHandler {
  return (request, _response, next) => {
    const token = parseCookie(request.header('cookie'), sessionCookieName);
    const session = token ? sessionManager.resolve(token) : undefined;
    if (!token || !session) {
      next(new ApiError(401, 'AUTH_REQUIRED', 'A valid session is required'));
      return;
    }
    const authenticatedRequest = request as AuthenticatedRequest;
    authenticatedRequest[authenticatedSessionKey] = session;
    authenticatedRequest[sessionTokenKey] = token;
    next();
  };
}

export function getAuthenticatedSession(request: Request): StoredSession {
  const session = (request as AuthenticatedRequest)[authenticatedSessionKey];
  if (!session) {
    throw new ApiError(401, 'AUTH_REQUIRED', 'A valid session is required');
  }
  return session;
}

function getSessionToken(request: Request): string {
  const token = (request as AuthenticatedRequest)[sessionTokenKey];
  if (!token) {
    throw new ApiError(401, 'AUTH_REQUIRED', 'A valid session is required');
  }
  return token;
}

export function createAuthenticatedMutationProtection(
  config: Environment,
  sessionManager: SessionManager,
): readonly RequestHandler[] {
  return [
    createSessionAuthentication(sessionManager),
    requireAllowedOrigin(config),
    (request, _response, next) => {
      const candidate = request.header(csrfHeaderName);
      if (!candidate || !sessionManager.verifyCsrf(getAuthenticatedSession(request), candidate)) {
        next(new ApiError(403, 'CSRF_DENIED', 'The CSRF token is missing or invalid'));
        return;
      }
      next();
    },
  ];
}

export function createSessionRouter(config: Environment, sessionManager: SessionManager): Router {
  const router = createRouter();
  const authenticate = createSessionAuthentication(sessionManager);

  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  if (config.LOCAL_AUTH_ENABLED) {
    router.post('/', requireAllowedOrigin(config), requireJson, (request, response, next) => {
      const parsed = localSessionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        next(
          new ApiError(400, 'INVALID_REQUEST', 'The local session request is invalid', {
            fields: parsed.error.issues.map(({ message, path }) => ({ message, path })),
          }),
        );
        return;
      }
      if (!config.LOCAL_AUTH_USER_IDS.includes(parsed.data.userId)) {
        next(new ApiError(403, 'LOCAL_IDENTITY_DENIED', 'The local identity is not allowed'));
        return;
      }

      try {
        const created = sessionManager.create(parsed.data.userId);
        response.setHeader('Set-Cookie', sessionCookie(created.sessionToken, config));
        response.status(201).json({
          csrf: { headerName: csrfHeaderName, token: created.record.csrfToken },
          expiresAt: created.record.expiresAt.toISOString(),
          identity: { userId: created.record.userId },
        });
      } catch (error) {
        next(
          error instanceof SessionStoreCapacityError
            ? new ApiError(503, 'SESSION_STORE_UNAVAILABLE', 'The local session store is full')
            : error,
        );
      }
    });
  }

  router.get('/', authenticate, (request, response) => {
    const session = getAuthenticatedSession(request);
    response.status(200).json({
      csrf: { headerName: csrfHeaderName, token: session.csrfToken },
      expiresAt: session.expiresAt.toISOString(),
      identity: { userId: session.userId },
    });
  });

  router.delete(
    '/',
    ...createAuthenticatedMutationProtection(config, sessionManager),
    (request, response) => {
      sessionManager.revoke(getSessionToken(request));
      response.setHeader('Set-Cookie', clearedSessionCookie(config));
      response.status(204).end();
    },
  );

  return router;
}

import type { ErrorRequestHandler, RequestHandler } from 'express';

import { SessionStoreUnavailableError } from '../auth/session-store.js';
import { classifyDatabaseTimeout } from '../database/database-errors.js';
import { describeError } from '../observability/logger.js';
import { getRequestId } from './request-id.js';

export class ApiError extends Error {
  public readonly details: Record<string, unknown> | undefined;

  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.details = details;
  }
}

function isInvalidJson(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    'type' in error &&
    (error as { type?: unknown }).type === 'entity.parse.failed'
  );
}

function isPayloadTooLarge(error: unknown): boolean {
  return (
    error instanceof Error &&
    'type' in error &&
    (error as { type?: unknown }).type === 'entity.too.large'
  );
}

export const unknownApiRoute: RequestHandler = (_request, _response, next) => {
  next(new ApiError(404, 'ROUTE_NOT_FOUND', 'The requested API route does not exist'));
};

/** The configured runtime SQL budgets, reported with a timeout so an operator sees which limit was hit. */
export interface DatabaseBudgetsMs {
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

const databaseTimeoutErrors = {
  lock: new ApiError(
    503,
    'DB_LOCK_TIMEOUT',
    'The requested data is busy; retry the request shortly',
  ),
  statement: new ApiError(
    503,
    'DB_STATEMENT_TIMEOUT',
    'The database did not finish the request within its time limit',
  ),
} as const;

/** Seconds a client should wait before asking again after the session store could not answer. */
export const SESSION_STORE_RETRY_AFTER_SECONDS = 5;

/**
 * The session store could not say whether a session is valid (ADR-0080). Access is refused, but this is not a 401:
 * the browser keeps its cookie and its last confirmed session, and asks again (ADR-0054).
 */
export function sessionStoreUnavailable(): ApiError {
  return new ApiError(
    503,
    'SESSION_STORE_UNAVAILABLE',
    'Sessions cannot be checked right now; retry shortly',
  );
}

export function apiErrorHandler(budgets: DatabaseBudgetsMs = {}): ErrorRequestHandler {
  return (error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const requestId = getRequestId(request);
    const databaseTimeout = classifyDatabaseTimeout(error);
    const normalized = isInvalidJson(error)
      ? new ApiError(400, 'INVALID_REQUEST', 'The request body is not valid JSON')
      : isPayloadTooLarge(error)
        ? new ApiError(413, 'BATCH_TOO_LARGE', 'The request body exceeds 64 KiB')
        : error instanceof ApiError
          ? error
          : error instanceof SessionStoreUnavailableError
            ? sessionStoreUnavailable()
            : databaseTimeout !== undefined
              ? databaseTimeoutErrors[databaseTimeout]
              : new ApiError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred');

    if (normalized.code === 'SESSION_STORE_UNAVAILABLE' && normalized.statusCode === 503) {
      response.setHeader('Retry-After', String(SESSION_STORE_RETRY_AFTER_SECONDS));
    }
    if (normalized.statusCode >= 500) {
      // The HTTP metrics middleware emits the single failure log line and adds this.
      const timeoutMs =
        databaseTimeout === 'lock' ? budgets.lockTimeoutMs : budgets.statementTimeoutMs;
      response.locals.errorDescription =
        databaseTimeout !== undefined && normalized === databaseTimeoutErrors[databaseTimeout]
          ? {
              ...describeError(normalized),
              reason: databaseTimeout,
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }
          : describeError(error);
    }

    response.status(normalized.statusCode).json({
      error: {
        code: normalized.code,
        ...(normalized.details ? { details: normalized.details } : {}),
        message: normalized.message,
        requestId,
      },
    });
  };
}

import type { ErrorRequestHandler, RequestHandler } from 'express';

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

export function apiErrorHandler(): ErrorRequestHandler {
  return (error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const requestId = getRequestId(request);
    const normalized = isInvalidJson(error)
      ? new ApiError(400, 'INVALID_REQUEST', 'The request body is not valid JSON')
      : isPayloadTooLarge(error)
        ? new ApiError(413, 'BATCH_TOO_LARGE', 'The request body exceeds 64 KiB')
        : error instanceof ApiError
          ? error
          : new ApiError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred');

    if (normalized.statusCode >= 500) {
      // The HTTP metrics middleware emits the single failure log line and adds this.
      response.locals.errorDescription = describeError(error);
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

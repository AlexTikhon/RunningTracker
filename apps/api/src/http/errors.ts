import type { ErrorRequestHandler, RequestHandler } from 'express';

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

export const unknownApiRoute: RequestHandler = (_request, _response, next) => {
  next(new ApiError(404, 'ROUTE_NOT_FOUND', 'The requested API route does not exist'));
};

export const apiErrorHandler: ErrorRequestHandler = (error, request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  const requestId = getRequestId(request);
  const normalized = isInvalidJson(error)
    ? new ApiError(400, 'INVALID_REQUEST', 'The request body is not valid JSON')
    : error instanceof ApiError
      ? error
      : new ApiError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred');

  if (!(error instanceof ApiError) && !isInvalidJson(error)) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    console.error(`Unhandled HTTP error [${requestId}] (${errorName})`);
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

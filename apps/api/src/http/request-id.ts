import { randomUUID } from 'node:crypto';

import type { Request, RequestHandler } from 'express';

const requestIdKey = Symbol('requestId');

type RequestWithId = Request & { [requestIdKey]?: string };

export const requestIdMiddleware: RequestHandler = (request, response, next) => {
  const requestId = randomUUID();
  (request as RequestWithId)[requestIdKey] = requestId;
  response.setHeader('X-Request-Id', requestId);
  next();
};

export function getRequestId(request: Request): string {
  const requestId = (request as RequestWithId)[requestIdKey];
  if (!requestId) {
    throw new Error('requestId middleware must run before request handlers');
  }
  return requestId;
}

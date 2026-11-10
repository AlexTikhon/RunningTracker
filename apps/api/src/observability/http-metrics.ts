import type { Request, RequestHandler, Response } from 'express';

import type { Clock } from '../clock.js';
import { getRequestId } from '../http/request-id.js';
import type { ApiMetrics } from './api-metrics.js';
import type { Logger } from './logger.js';

const routePrefixLocal = 'routeTemplatePrefix';

/**
 * Wraps a router mounted at `prefix` and records that mount path, as written in code (`/api/orgs/:orgId/meals`), as the
 * prefix of the route label. `request.baseUrl` is no substitute: it holds the concrete text that matched
 * (`/api/orgs/<whatever was sent>`), and Express resets it when an error leaves the router.
 *
 * The prefix stays while a route of this router has matched, including when that route passes an error on (a refused
 * session answers 401 or 503 from the shared error handler). If nothing in the router matched, the previous prefix is
 * put back before the request goes on, so a later route never inherits it.
 */
export function routePrefix(prefix: string, router: RequestHandler): RequestHandler {
  return (request, response, next) => {
    const outerPrefix = response.locals[routePrefixLocal] as unknown;
    const routeBefore = request.route as unknown;
    response.locals[routePrefixLocal] = prefix;
    void router(request, response, (error?: unknown) => {
      if (request.route === routeBefore) {
        response.locals[routePrefixLocal] = outerPrefix;
      }
      next(error);
    });
  };
}

/**
 * The metrics and log label of a request: the code-defined template of the route that matched (mount prefix plus the
 * route's own path, for example `/api/orgs/:orgId/daily-metrics/:localDate`), or `unmatched`. Nothing of the incoming
 * URL is used, so identifiers, dates and malformed values in a path never become a label, whatever the route answers
 * (401 and 503 included).
 */
export function routeLabel(request: Request, response: Response): string {
  const route = request.route as { path?: unknown } | undefined;
  if (route === undefined) {
    return 'unmatched';
  }
  const prefix = response.locals[routePrefixLocal] as unknown;
  const base = typeof prefix === 'string' ? prefix : '';
  const path = typeof route.path === 'string' ? route.path : '/(pattern)';
  if (path === '/') {
    return base === '' ? '/' : base;
  }
  return `${base}${path}`;
}

export function createHttpMetricsMiddleware(options: {
  clock: Pick<Clock, 'monotonicNow'>;
  logger: Logger;
  metrics: ApiMetrics['http'];
}): RequestHandler {
  const { clock, logger, metrics } = options;

  return (request, response, next) => {
    const startedAt = clock.monotonicNow();
    let finished = false;
    metrics.inFlight.inc();

    response.once('close', () => {
      if (finished) {
        return;
      }
      finished = true;
      metrics.inFlight.dec();

      const durationSeconds = Math.max(0, (clock.monotonicNow() - startedAt) / 1_000);
      const route = routeLabel(request, response);
      const status = response.statusCode;
      const eventStream = String(response.getHeader('Content-Type') ?? '').startsWith(
        'text/event-stream',
      );

      metrics.requests.inc({ method: request.method, route, status: String(status) });
      if (!eventStream) {
        metrics.durationSeconds.observe({ method: request.method, route }, durationSeconds);
      }
      if (status >= 500) {
        logger.error('http.request.failed', {
          durationMs: Math.round(durationSeconds * 1_000),
          method: request.method,
          requestId: getRequestId(request),
          route,
          status,
          ...(response.locals.errorDescription as Record<string, unknown> | undefined),
        });
      }
    });

    next();
  };
}

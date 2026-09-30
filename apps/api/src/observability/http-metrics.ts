import type { RequestHandler } from 'express';

import type { Clock } from '../clock.js';
import { getRequestId } from '../http/request-id.js';
import type { ApiMetrics } from './api-metrics.js';
import type { Logger } from './logger.js';

const uuidSegment = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const numericSegment = /^\d+$/u;
const numericExtensionSegment = /^(\d+)(\.[a-z0-9]+)$/iu;

/**
 * Turns a concrete URL path into a low-cardinality template. Only used for
 * requests that matched a route, so remaining literal segments come from code.
 */
export function normalizeRoutePath(originalUrl: string): string {
  const path = originalUrl.split('?', 1)[0] ?? '';
  const segments = path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (uuidSegment.test(segment)) {
        return ':uuid';
      }
      if (numericSegment.test(segment)) {
        return ':n';
      }
      const extension = numericExtensionSegment.exec(segment);
      return extension ? `:n${extension[2]}` : segment;
    });
  return `/${segments.join('/')}`;
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
      const route =
        request.route === undefined ? 'unmatched' : normalizeRoutePath(request.originalUrl);
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

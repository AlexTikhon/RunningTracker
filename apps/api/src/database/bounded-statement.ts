import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type { Clock } from '../clock.js';

export interface BoundedStatementOptions {
  clock: Pick<Clock, 'clearTimeout' | 'setTimeout'>;
  /** The message a destroyed connection is released with; it never reaches a log line or a response. */
  discardedConnectionMessage: string;
  pool: Pick<Pool, 'connect'>;
  /** Upper bound of the whole call, connection checkout included. */
  timeoutMs: number;
  /** Builds the one error every failure to get an answer becomes (ADR-0080, ADR-0081). */
  unavailable: (reason: string, options?: { cause?: unknown }) => Error;
}

/**
 * One autocommit statement on a pooled connection, bounded as a whole. On the deadline the call fails at once and the
 * connection is destroyed rather than returned (its statement may still be running, so whether it committed is
 * unknown to the caller); a checkout that finishes after the deadline is returned unused. Every failure, the deadline
 * included, becomes `unavailable(...)`.
 */
export function runBoundedStatement<Row extends QueryResultRow>(
  options: BoundedStatementOptions,
  text: string,
  values: unknown[],
): Promise<Row[]> {
  const { clock, discardedConnectionMessage, pool, timeoutMs, unavailable } = options;
  return new Promise<Row[]>((resolve, reject) => {
    let settled = false;
    let client: PoolClient | undefined;
    let released = false;
    const release = (destroy: boolean): void => {
      if (client === undefined || released) return;
      released = true;
      client.release(destroy ? new Error(discardedConnectionMessage) : undefined);
    };
    const timer = clock.setTimeout(() => {
      if (settled) return;
      settled = true;
      release(true);
      reject(unavailable(`no answer within ${timeoutMs} ms`));
    }, timeoutMs);
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      outcome();
    };

    pool.connect().then(
      (acquired) => {
        client = acquired;
        if (settled) {
          release(false);
          return;
        }
        acquired.query<Row>(text, values).then(
          (result) => {
            if (settled) return;
            release(false);
            settle(() => resolve(result.rows));
          },
          (error: unknown) => {
            if (settled) return;
            release(true);
            settle(() => reject(unavailable('query failed', { cause: error })));
          },
        );
      },
      (error: unknown) => {
        settle(() => reject(unavailable('no connection', { cause: error })));
      },
    );
  });
}

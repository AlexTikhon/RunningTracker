import type { Pool, PoolClient } from 'pg';

import { defaultLogger, describeError, type Logger } from '../observability/logger.js';

/**
 * Keeps a checked-out client's connection failure from ending the process.
 *
 * pg-pool listens for client 'error' events only while a client is idle: it removes that listener when it lends the
 * client and puts it back on release. If the server ends a borrowed connection (pg_terminate_backend, a restart, a TCP
 * reset), the client emits 'error' with no listener and Node exits, taking every other request and job with it. That
 * includes the gaps between statements, for example while the journal exporter waits for its file write.
 *
 * The guard adds one listener for exactly the time a client is borrowed: on 'acquire', which pg-pool emits before it
 * removes its idle listener and before the borrower receives the client, and off again on 'release', which it emits
 * after the idle listener is back. Every checkout of the pool is covered, `connect()` and `query()` alike.
 *
 * The listener only records the failure. pg has already rejected the statement in flight and rejects every later
 * statement on that client at once, so the borrower's own error path runs unchanged: a tenant transaction still tells
 * a rolled-back transaction from a COMMIT whose outcome is unknown, and the client goes back with an error (or, where a
 * borrower releases it plainly, as no longer queryable), so pg-pool destroys it instead of lending it again.
 * There is deliberately no process-wide uncaughtException handler.
 */
export function guardBorrowedClients<P extends Pick<Pool, 'on'>>(pool: P, poolName: string, logger: Logger = defaultLogger): P {
  const onClientError = (error: Error): void => {
    logger.error('database.client.error', { ...describeError(error), reason: poolName });
  };
  pool.on('acquire', (client: PoolClient) => {
    client.on('error', onClientError);
  });
  pool.on('release', (_error: Error | undefined, client: PoolClient) => {
    client.removeListener('error', onClientError);
  });
  return pool;
}

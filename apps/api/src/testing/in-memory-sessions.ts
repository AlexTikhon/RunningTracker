import { SessionManager } from '../auth/session-manager.js';
import { InMemorySessionStore } from '../auth/session-store.js';
import type { Clock } from '../clock.js';
import type { Environment } from '../config/environment.js';

/**
 * A session manager over the process-local test store. For tests that do not exercise session storage: the API
 * process always uses PostgreSQL (ADR-0080), and createApp has no implicit default, so a test states this choice.
 */
export function inMemorySessionManager(
  clock: Clock,
  config: Pick<Environment, 'SESSION_STORE_MAX_ENTRIES' | 'SESSION_TTL_MS'>,
): SessionManager {
  return new SessionManager({
    clock,
    store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
    ttlMs: config.SESSION_TTL_MS,
  });
}

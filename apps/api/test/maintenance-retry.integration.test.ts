import { performance } from 'node:perf_hooks';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Clock } from '../src/clock.js';
import { loadIntegrationTestConfiguration, validateEnvironment } from '../src/config/environment.js';
import { classifyDatabaseTimeout } from '../src/database/database-errors.js';
import { createMaintenanceDatabasePool } from '../src/database/database.js';
import { PeriodicRunner } from '../src/maintenance/periodic-runner.js';
import { runDeletionJournalExportOnce } from '../src/maintenance/run-deletion-journal-export.js';
import { createApiMetrics } from '../src/observability/api-metrics.js';
import { createLogger } from '../src/observability/logger.js';
import { prepareTenantIsolationFixtures, tenantIsolationIds as ids } from './tenant-isolation-fixtures.js';

// Scheduler time is controlled; PostgreSQL queries, cancellation, claims and rollback are real.
function controlledClock(): Clock & { advanceBy(ms: number): void; timerCount(): number } {
  let elapsed = 0;
  let nextId = 1;
  const timers = new Map<ReturnType<typeof setTimeout>, { due: number; callback: () => void }>();
  return {
    advanceBy(ms) {
      elapsed += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.due <= elapsed) {
          timers.delete(handle);
          timer.callback();
        }
      }
    },
    clearTimeout: (handle) => void timers.delete(handle),
    monotonicNow: () => elapsed,
    setTimeout(callback, delayMs) {
      const handle = nextId++ as unknown as ReturnType<typeof setTimeout>;
      timers.set(handle, { callback, due: elapsed + delayMs });
      return handle;
    },
    timerCount: () => timers.size,
    utcNow: () => new Date(Date.parse('2033-01-10T00:00:00Z') + elapsed),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Maintenance integration condition was not reached');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe('maintenance retries over real role-separated transactions', () => {
  let owner: Pool;
  let maintenance: Pool;
  let configuration: ReturnType<typeof loadIntegrationTestConfiguration>;

  beforeAll(async () => {
    configuration = loadIntegrationTestConfiguration();
    // Prove live identities before the fixture helper performs any writes.
    for (const connection of [configuration.migration, configuration.runtime, configuration.maintenance]) {
      const probe = new Pool({ connectionString: connection.connectionString, max: 1 });
      try {
        const result = await probe.query<{ database: string; role: string }>(
          'SELECT current_database() AS database, current_user AS role',
        );
        expect(result.rows).toEqual([{ database: connection.database, role: connection.user }]);
      } finally { await probe.end(); }
    }
    owner = new Pool({ connectionString: configuration.migration.connectionString, max: 1 });
    maintenance = createMaintenanceDatabasePool(validateEnvironment({
      APP_ENV: 'test',
      DATABASE_URL: configuration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: configuration.maintenance.connectionString,
      MAINTENANCE_DB_STATEMENT_TIMEOUT_MS: 150,
      MAINTENANCE_DB_LOCK_TIMEOUT_MS: 100,
    }));
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(owner, configuration.migration);
  });

  afterAll(async () => {
    await Promise.all([maintenance?.end(), owner?.end()]);
  });

  it('backs off two actual SQL timeouts while another task progresses, then resets on recovery', async () => {
    const clock = controlledClock();
    const metrics = createApiMetrics();
    const logger = createLogger({ clock, write: () => undefined });
    const errors: unknown[] = [];
    let attempts = 0;
    let active = 0;
    let maxActive = 0;
    let healthyActive = 0;
    let healthyCycles = 0;
    const hasGauge = (metric: string, value: number) =>
      metrics.registry.render().includes(`${metric}{task="sql_retry_probe"} ${value}\n`);
    const failing = new PeriodicRunner({
      clock, intervalMs: 1_000, random: () => 1, logger, metrics: metrics.maintenance,
      onError: (error) => { errors.push(error); }, taskName: 'SQL retry probe',
      runOnce: async () => {
        attempts += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try { await maintenance.query(attempts <= 2 ? 'SELECT pg_sleep(5)' : 'SELECT 1'); }
        finally { active -= 1; }
      },
    });
    const healthy = new PeriodicRunner({
      clock, intervalMs: 1_000, logger, taskName: 'Healthy task probe',
      runOnce: async () => {
        healthyActive += 1;
        try {
          await maintenance.query('SELECT current_user');
          healthyCycles += 1;
        } finally { healthyActive -= 1; }
      },
    });
    failing.start();
    healthy.start();
    try {
      clock.advanceBy(1_000);
      await waitUntil(() => hasGauge('maintenance_retry_delay_seconds', 2) && healthyCycles === 1);
      expect(maintenance.totalCount).toBe(maintenance.idleCount);
      clock.advanceBy(2_000);
      await waitUntil(() => hasGauge('maintenance_retry_delay_seconds', 4) && healthyCycles === 2);
      expect(errors.map(classifyDatabaseTimeout)).toEqual(['statement', 'statement']);
      expect(hasGauge('maintenance_consecutive_failures', 2)).toBe(true);
      clock.advanceBy(1_000);
      await waitUntil(() => healthyCycles === 3);
      expect(attempts).toBe(2);
      clock.advanceBy(2_999);
      await waitUntil(() => healthyCycles === 4);
      expect(attempts).toBe(2);
      clock.advanceBy(1);
      await waitUntil(() => attempts === 3 && hasGauge('maintenance_consecutive_failures', 0));
      expect(hasGauge('maintenance_retry_delay_seconds', 0)).toBe(true);
      clock.advanceBy(999);
      expect(attempts).toBe(3);
      clock.advanceBy(1);
      await waitUntil(() => attempts === 4 && active === 0 && healthyActive === 0);
      expect(maxActive).toBe(1);
    } finally {
      failing.stop();
      healthy.stop();
      await waitUntil(() => active === 0 && healthyActive === 0);
    }
    expect(clock.timerCount()).toBe(0);
    expect(maintenance.waitingCount).toBe(0);
    expect(maintenance.totalCount).toBe(maintenance.idleCount);
  });

  it('retains a journal batch through unsettled and failed sink writes, then acknowledges after recovery', async () => {
    await owner.query(
      `INSERT INTO run_deletion_journal (org_id, run_id, owner_user_id, deleted_at)
       VALUES ($1, $2, $3, '2033-01-01T00:00:00Z')`,
      [ids.orgA, ids.runRecording, ids.userDual],
    );
    const clock = controlledClock();
    const metrics = createApiMetrics();
    const logger = createLogger({ clock, write: () => undefined });
    const sinkFailure = Object.assign(new Error('injected storage failure'), { code: 'EIO' });
    let rejectWrite: ((error: Error) => void) | undefined;
    let writes = 0;
    let active = 0;
    let completed = false;
    const errors: unknown[] = [];
    const runner = new PeriodicRunner({
      clock, intervalMs: 1_000, random: () => 1, logger, metrics: metrics.maintenance,
      taskName: 'Journal retry probe', onError: (error) => { errors.push(error); },
      runOnce: async () => {
        active += 1;
        try {
          const result = await runDeletionJournalExportOnce(maintenance, {
            write: () => {
              writes += 1;
              if (writes === 1) return new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
              if (writes === 2) return Promise.reject(sinkFailure);
              return Promise.resolve();
            },
          }, clock);
          completed = result.status === 'exported';
        } finally { active -= 1; }
      },
    });
    const hasRetry = (delay: number) => metrics.registry.render().includes(
      `maintenance_retry_delay_seconds{task="journal_retry_probe"} ${delay}\n`,
    );
    const rowCount = async () => (await owner.query<{ count: string }>(
      'SELECT count(*) FROM run_deletion_journal',
    )).rows[0]?.count;
    runner.start();
    try {
      clock.advanceBy(1_000);
      await waitUntil(() => rejectWrite !== undefined);
      clock.advanceBy(1_000_000);
      expect(writes).toBe(1);
      expect(clock.timerCount()).toBe(0);
      expect(hasRetry(0)).toBe(true);
      expect(await rowCount()).toBe('1');
      // One held exporter transaction does not consume the entire maintenance pool.
      await expect(maintenance.query('SELECT 1 AS healthy')).resolves.toMatchObject({ rows: [{ healthy: 1 }] });
      rejectWrite!(sinkFailure);
      await waitUntil(() => hasRetry(2));
      expect(await rowCount()).toBe('1');
      expect(maintenance.totalCount).toBe(maintenance.idleCount);
      clock.advanceBy(2_000);
      await waitUntil(() => hasRetry(4));
      expect(errors).toEqual([sinkFailure, sinkFailure]);
      expect(await rowCount()).toBe('1');
      clock.advanceBy(3_999);
      expect(writes).toBe(2);
      clock.advanceBy(1);
      await waitUntil(() => completed && active === 0 && hasRetry(0));
      expect(writes).toBe(3);
      expect(await rowCount()).toBe('0');
      expect(metrics.registry.render()).toContain('maintenance_consecutive_failures{task="journal_retry_probe"} 0\n');
    } finally {
      runner.stop();
      rejectWrite?.(sinkFailure);
      await waitUntil(() => active === 0);
    }
    expect(clock.timerCount()).toBe(0);
    expect(maintenance.totalCount).toBe(maintenance.idleCount);
  });
});

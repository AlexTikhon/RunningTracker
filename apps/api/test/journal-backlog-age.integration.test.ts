import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { systemClock } from '../src/clock.js';
import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { createMaintenanceDatabasePool } from '../src/database/database.js';
import { createBacklogMeasuredExport, readOldestUnexportedAgeSeconds } from '../src/maintenance/journal-backlog.js';
import { runDeletionJournalExportOnce } from '../src/maintenance/run-deletion-journal-export.js';
import { ERASURE_LEDGER_EXPORT_BATCH_LIMIT, runErasureLedgerExportOnce } from '../src/maintenance/run-erasure-ledger-export.js';
import { createApiMetrics } from '../src/observability/api-metrics.js';

// ADR-0037 / ADR-0073 (F04): a cycle exports at most one batch, so a successful cycle does not mean the outbox is
// drained. journal_export_oldest_unexported_age_seconds is the signal: it stays above zero after every partial export
// and returns to 0 only when the last row has left. The age is a sample, so every valid read is stamped in
// journal_export_backlog_age_measured_timestamp_seconds (injected clock; 0 before the first). Runs against the guarded
// test database with the maintenance role.
describe('journal export backlog age', () => {
  let integration: ReturnType<typeof loadIntegrationTestConfiguration>;
  let owner: Pool;
  let maintenance: Pool;
  const written: string[] = [];
  const sink = { write: (name: string) => Promise.resolve(void written.push(name)) };
  const MEASURE_START_SECONDS = 1_988_928_000;
  let measureNowMs = MEASURE_START_SECONDS * 1_000;
  const measureClock = { utcNow: () => new Date(measureNowMs) };

  beforeAll(async () => {
    integration = loadIntegrationTestConfiguration();
    // Prove the live database and role of every connection this file uses before anything is deleted or inserted.
    for (const connection of [integration.migration, integration.runtime, integration.maintenance]) {
      expect(connection.database.endsWith('_test')).toBe(true);
      const probe = new Pool({ connectionString: connection.connectionString, max: 1 });
      try {
        const result = await probe.query<{ database: string; role: string }>(
          'SELECT current_database() AS database, current_user AS role',
        );
        expect(result.rows).toEqual([{ database: connection.database, role: connection.user }]);
      } finally {
        await probe.end();
      }
    }
    owner = new Pool({ application_name: 'rt-backlog-age-owner', connectionString: integration.migration.connectionString, max: 1 });
    maintenance = createMaintenanceDatabasePool(integration.environment);
  });

  beforeEach(async () => {
    written.length = 0;
    await owner.query('DELETE FROM erasure_ledger');
    await owner.query('DELETE FROM run_deletion_journal');
  });

  afterAll(async () => {
    await owner?.query('DELETE FROM erasure_ledger');
    await owner?.query('DELETE FROM run_deletion_journal');
    await Promise.allSettled([owner?.end(), maintenance?.end()]);
  });

  function sample(metrics: ReturnType<typeof createApiMetrics>, name: string, journal: string): number | undefined {
    const match = new RegExp(`^${name}\\{journal="${journal}"\\} (\\S+)$`, 'mu').exec(metrics.registry.render());
    return match === null ? undefined : Number(match[1]);
  }
  const gauge = (metrics: ReturnType<typeof createApiMetrics>, journal: string) =>
    sample(metrics, 'journal_export_oldest_unexported_age_seconds', journal);
  const measuredAt = (metrics: ReturnType<typeof createApiMetrics>, journal: string) =>
    sample(metrics, 'journal_export_backlog_age_measured_timestamp_seconds', journal);
  const advanceMeasureClock = (seconds: number) => {
    measureNowMs += seconds * 1_000;
    return Math.floor(measureNowMs / 1_000);
  };

  const pending = async (table: string) => Number((await owner.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`)).rows[0]!.count);

  it('stays non-zero after each successful partial erasure export and clears only when the ledger is drained', async () => {
    const rows = 2 * ERASURE_LEDGER_EXPORT_BATCH_LIMIT + 50;
    await owner.query(
      `INSERT INTO erasure_ledger (entity_type, org_id, record_id, owner_user_id, record_created_at, erased_at)
       SELECT 'activity', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
              now() - interval '1 hour', now() - interval '10 minutes' + make_interval(secs => n * 0.01)
       FROM generate_series(1, $1) AS n`,
      [rows],
    );
    const metrics = createApiMetrics();
    const cycle = createBacklogMeasuredExport({
      clock: measureClock,
      exportOnce: () => runErasureLedgerExportOnce(maintenance, sink, systemClock),
      journal: 'erasure',
      metrics: metrics.maintenance,
      pool: maintenance,
    });

    expect(gauge(metrics, 'erasure')).toBeUndefined();
    expect(measuredAt(metrics, 'erasure')).toBe(0);
    const ages: number[] = [];
    const results: unknown[] = [];
    for (let index = 0; index < 4; index += 1) {
      const expectedStamp = advanceMeasureClock(30);
      results.push(await cycle());
      ages.push(gauge(metrics, 'erasure')!);
      // Every valid read is stamped, the partial-backlog ones and the fresh zeros alike.
      expect(measuredAt(metrics, 'erasure')).toBe(expectedStamp);
    }

    expect(results).toEqual([
      expect.objectContaining({ exportedCount: 500, status: 'exported' }),
      expect.objectContaining({ exportedCount: 500, status: 'exported' }),
      expect.objectContaining({ exportedCount: 50, status: 'exported' }),
      { status: 'idle' },
    ]);
    // Oldest first: the rows still waiting after each partial batch are about ten minutes old.
    expect(ages[0]).toBeGreaterThan(590);
    expect(ages[1]).toBeGreaterThan(590);
    expect(ages[2]).toBe(0);
    expect(ages[3]).toBe(0);
    expect(written).toHaveLength(3);
    expect(await pending('erasure_ledger')).toBe(0);
  }, 60_000);

  it('is measured after a failed export too, and the failure is not swallowed', async () => {
    await owner.query(
      `INSERT INTO erasure_ledger (entity_type, org_id, record_id, owner_user_id, record_created_at, erased_at)
       VALUES ('activity', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), now() - interval '2 hours', now() - interval '5 minutes')`,
    );
    const metrics = createApiMetrics();
    const storageDown = new Error('journal storage unavailable');
    const expectedStamp = advanceMeasureClock(30);

    await expect(
      createBacklogMeasuredExport({
        clock: measureClock,
        exportOnce: () => runErasureLedgerExportOnce(maintenance, { write: () => Promise.reject(storageDown) }, systemClock),
        journal: 'erasure',
        metrics: metrics.maintenance,
        pool: maintenance,
      })(),
    ).rejects.toBe(storageDown);
    expect(gauge(metrics, 'erasure')).toBeGreaterThan(290);
    // The export failed but the read was valid, so the age is fresh.
    expect(measuredAt(metrics, 'erasure')).toBe(expectedStamp);
    expect(await pending('erasure_ledger')).toBe(1);
  });

  it('keeps the last stamp and age when a real read is refused, while the export result is unchanged', async () => {
    await owner.query(
      `INSERT INTO erasure_ledger (entity_type, org_id, record_id, owner_user_id, record_created_at, erased_at)
       VALUES ('activity', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), now() - interval '2 hours', now() - interval '4 minutes')`,
    );
    const runtime = new Pool({ application_name: 'rt-backlog-age-runtime-read', connectionString: integration.runtime.connectionString, max: 1 });
    // The measurement reads through `reader`; switching it to the runtime role makes the read fail with 42501.
    let reader: Pick<Pool, 'query'> = maintenance;
    const metrics = createApiMetrics();
    const cycle = createBacklogMeasuredExport({
      clock: measureClock,
      exportOnce: () => Promise.resolve({ status: 'idle' as const }),
      journal: 'erasure',
      logger: { error: () => undefined, info: () => undefined, warn: () => undefined },
      metrics: metrics.maintenance,
      pool: { query: ((...args: Parameters<Pool['query']>) => reader.query(...args)) as Pool['query'] },
    });
    try {
      const firstStamp = advanceMeasureClock(30);
      await cycle();
      const firstAge = gauge(metrics, 'erasure')!;
      expect(firstAge).toBeGreaterThan(230);
      expect(measuredAt(metrics, 'erasure')).toBe(firstStamp);

      reader = runtime;
      advanceMeasureClock(600);
      await expect(cycle()).resolves.toEqual({ status: 'idle' });

      expect(measuredAt(metrics, 'erasure')).toBe(firstStamp);
      expect(gauge(metrics, 'erasure')).toBe(firstAge);
    } finally {
      await runtime.end();
    }
  });

  it('reports the run deletion journal backlog the same way', async () => {
    await owner.query(
      `INSERT INTO run_deletion_journal (org_id, run_id, owner_user_id, deleted_at)
       SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), now() - interval '3 minutes'
       FROM generate_series(1, 3)`,
    );
    expect(await readOldestUnexportedAgeSeconds(maintenance, 'deletion')).toBeGreaterThan(170);
    const metrics = createApiMetrics();
    const expectedStamp = advanceMeasureClock(30);

    const result = await createBacklogMeasuredExport({
      clock: measureClock,
      exportOnce: () => runDeletionJournalExportOnce(maintenance, sink, systemClock),
      journal: 'deletion',
      metrics: metrics.maintenance,
      pool: maintenance,
    })();

    expect(result).toMatchObject({ exportedCount: 3, status: 'exported' });
    expect(gauge(metrics, 'deletion')).toBe(0);
    expect(measuredAt(metrics, 'deletion')).toBe(expectedStamp);
    // Only the deletion journal was wired here; the erasure label is not touched.
    expect(measuredAt(metrics, 'erasure')).toBeUndefined();
  });

  it('is a maintenance capability only', async () => {
    const runtime = new Pool({ application_name: 'rt-backlog-age-runtime', connectionString: integration.runtime.connectionString, max: 1 });
    try {
      for (const fn of ['erasure_ledger_oldest_unexported_age_seconds', 'run_deletion_journal_oldest_unexported_age_seconds']) {
        await expect(runtime.query(`SELECT app_private.${fn}()`)).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await runtime.end();
    }
  });
});

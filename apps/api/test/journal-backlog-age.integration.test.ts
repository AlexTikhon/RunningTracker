import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { systemClock } from '../src/clock.js';
import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { createMaintenanceDatabasePool } from '../src/database/database.js';
import { exportAndMeasureBacklog, readOldestUnexportedAgeSeconds } from '../src/maintenance/journal-backlog.js';
import { runDeletionJournalExportOnce } from '../src/maintenance/run-deletion-journal-export.js';
import { ERASURE_LEDGER_EXPORT_BATCH_LIMIT, runErasureLedgerExportOnce } from '../src/maintenance/run-erasure-ledger-export.js';
import { createApiMetrics } from '../src/observability/api-metrics.js';

// ADR-0037 / ADR-0073 (F04): a cycle exports at most one batch, so a successful cycle does not mean the outbox is
// drained. journal_export_oldest_unexported_age_seconds is the signal: it stays above zero after every partial export
// and returns to 0 only when the last row has left. Runs against the guarded test database with the maintenance role.
describe('journal export backlog age', () => {
  let integration: ReturnType<typeof loadIntegrationTestConfiguration>;
  let owner: Pool;
  let maintenance: Pool;
  const written: string[] = [];
  const sink = { write: (name: string) => Promise.resolve(void written.push(name)) };

  beforeAll(() => {
    integration = loadIntegrationTestConfiguration();
    expect(new URL(integration.migration.connectionString).pathname.endsWith('_test')).toBe(true);
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

  function gauge(metrics: ReturnType<typeof createApiMetrics>, journal: string): number | undefined {
    const match = new RegExp(`^journal_export_oldest_unexported_age_seconds\\{journal="${journal}"\\} (\\S+)$`, 'mu').exec(
      metrics.registry.render(),
    );
    return match === null ? undefined : Number(match[1]);
  }

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
    const cycle = () =>
      exportAndMeasureBacklog({
        exportOnce: () => runErasureLedgerExportOnce(maintenance, sink, systemClock),
        journal: 'erasure',
        metrics: metrics.maintenance,
        pool: maintenance,
      });

    expect(gauge(metrics, 'erasure')).toBeUndefined();
    const ages: number[] = [];
    const results: unknown[] = [];
    for (let index = 0; index < 4; index += 1) {
      results.push(await cycle());
      ages.push(gauge(metrics, 'erasure')!);
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

    await expect(
      exportAndMeasureBacklog({
        exportOnce: () => runErasureLedgerExportOnce(maintenance, { write: () => Promise.reject(storageDown) }, systemClock),
        journal: 'erasure',
        metrics: metrics.maintenance,
        pool: maintenance,
      }),
    ).rejects.toBe(storageDown);
    expect(gauge(metrics, 'erasure')).toBeGreaterThan(290);
    expect(await pending('erasure_ledger')).toBe(1);
  });

  it('reports the run deletion journal backlog the same way', async () => {
    await owner.query(
      `INSERT INTO run_deletion_journal (org_id, run_id, owner_user_id, deleted_at)
       SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), now() - interval '3 minutes'
       FROM generate_series(1, 3)`,
    );
    expect(await readOldestUnexportedAgeSeconds(maintenance, 'deletion')).toBeGreaterThan(170);
    const metrics = createApiMetrics();

    const result = await exportAndMeasureBacklog({
      exportOnce: () => runDeletionJournalExportOnce(maintenance, sink, systemClock),
      journal: 'deletion',
      metrics: metrics.maintenance,
      pool: maintenance,
    });

    expect(result).toMatchObject({ exportedCount: 3, status: 'exported' });
    expect(gauge(metrics, 'deletion')).toBe(0);
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

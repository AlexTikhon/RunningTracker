import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apiErrorResponseSchema } from '@running-tracker/contracts';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { csrfHeaderName } from '../src/auth/session-http.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import type { Clock } from '../src/clock.js';
import {
  loadIntegrationTestConfiguration,
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import {
  parseDeletionJournalFile,
  type DeletionJournalEntry,
} from '../src/maintenance/deletion-journal-format.js';
import {
  createFileDeletionJournalSink,
  type DeletionJournalSink,
} from '../src/maintenance/deletion-journal-sink.js';
import { runDeletionJournalExportOnce } from '../src/maintenance/run-deletion-journal-export.js';
import { runRetentionDeleteOnce } from '../src/maintenance/run-retention-delete.js';
import { loadDeletionJournal, reapplyDeletions } from '../src/restore/reapply-deletions.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const allowedOrigin = 'http://127.0.0.1:5173';

const runIds = {
  a: 'a7500000-0000-4000-8000-000000000001',
  b: 'a7500000-0000-4000-8000-000000000002',
  c: 'a7500000-0000-4000-8000-000000000003',
  retention: 'a7500000-0000-4000-8000-000000000004',
  rollback: 'a7500000-0000-4000-8000-000000000005',
  unknown: 'a7500000-0000-4000-8000-000000000006',
} as const;

const deletedAt = '2032-01-10T00:00:00.000Z';
const restoreNow = '2032-03-01T00:00:00.000Z';

class FixedClock implements Clock {
  public constructor(private readonly instant: string = deletedAt) {}

  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return Date.parse(this.instant);
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date(this.instant);
  }
}

function at(instant: string): Pick<Clock, 'utcNow'> {
  return { utcNow: () => new Date(instant) };
}

interface JournalRow {
  deleted_at: Date;
  journal_seq: string;
  org_id: string;
  owner_user_id: string;
  run_id: string;
}

function objectBody(response: request.Response): Record<string, unknown> {
  const body = response.body as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Expected an object response body');
  }
  return body as Record<string, unknown>;
}

function cookiePair(response: request.Response): string {
  const header: unknown = response.headers['set-cookie'];
  const value: unknown =
    typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
  if (typeof value !== 'string') throw new Error('Expected a session cookie');
  return value.split(';', 1)[0]!;
}

describe('P10.5 durable deletion journal and restore reapplication', () => {
  let app: ReturnType<typeof createApp>;
  let config: Environment;
  let directory: string;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    expectedOwner = integration.migration;
    config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: `${ids.userDual}`,
      SESSION_COOKIE_SECURE: 'false',
    });
    ownerPool = new Pool({
      application_name: 'running-tracker-p105-owner',
      connectionString: integration.migration.connectionString,
      max: 4,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-p105-maintenance',
      connectionString: integration.maintenance.connectionString,
      max: 6,
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 4 });
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    const clock = new FixedClock();
    app = createApp({
      clock,
      config,
      pool: runtimePool,
      sessionManager: new SessionManager({
        clock,
        store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
        ttlMs: config.SESSION_TTL_MS,
      }),
    });
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    // Start from a database with no fixture runs so retention and journal counts are exact.
    await ownerPool.query('DELETE FROM runs');
    await ownerPool.query('UPDATE organizations SET archive_revision = 0 WHERE id = $1', [ids.orgA]);
    directory = await mkdtemp(join(tmpdir(), 'rt-p105-'));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  afterAll(async () => {
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  async function seedRun(
    runId: string,
    options: { createdAt?: string; finishedAt?: string; ownerId?: string; startedAt?: string } = {},
  ): Promise<void> {
    const createdAt = options.createdAt ?? '2020-01-01T00:00:00.000Z';
    await ownerPool.query(
      `INSERT INTO runs (
         org_id, id, user_id, status, started_at, created_at, finished_at,
         data_revision, control_revision, raw_state
       ) VALUES ($1, $2, $3, 'finished', $4, $5, $6, 1, 0, 'available')`,
      [
        ids.orgA,
        runId,
        options.ownerId ?? ids.userDual,
        options.startedAt ?? createdAt,
        createdAt,
        options.finishedAt ?? '2031-01-02T00:00:00.000Z',
      ],
    );
  }

  async function deleteAsOwner(runId: string, instant = deletedAt): Promise<string | undefined> {
    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)",
        [ids.userDual, ids.orgA],
      );
      const result = await client.query<{ outcome: string }>(
        'SELECT outcome FROM app_private.delete_run_as_owner($1, $2, $3, $4)',
        [ids.orgA, runId, ids.userDual, instant],
      );
      await client.query('COMMIT');
      return result.rows[0]?.outcome;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function journalRows(): Promise<JournalRow[]> {
    const result = await ownerPool.query<JournalRow>(
      `SELECT journal_seq::text AS journal_seq, org_id, run_id, owner_user_id, deleted_at
       FROM run_deletion_journal ORDER BY journal_seq`,
    );
    return result.rows;
  }

  async function exportOnce(sink: Pick<DeletionJournalSink, 'write'>) {
    return runDeletionJournalExportOnce(maintenancePool, sink, at(deletedAt));
  }

  async function exportedEntries(): Promise<DeletionJournalEntry[]> {
    const names = (await readdir(directory)).filter((name) => name.endsWith('.ndjson')).sort();
    const entries: DeletionJournalEntry[] = [];
    for (const name of names) {
      entries.push(...parseDeletionJournalFile(name, await readFile(join(directory, name), 'utf8')));
    }
    return entries;
  }

  async function tombstone(runId: string) {
    const result = await ownerPool.query<{ deleted_at: Date; expires_at: Date; owner_user_id: string }>(
      'SELECT owner_user_id, deleted_at, expires_at FROM run_tombstones WHERE org_id = $1 AND run_id = $2',
      [ids.orgA, runId],
    );
    return result.rows[0];
  }

  async function runExists(runId: string): Promise<boolean> {
    const result = await ownerPool.query('SELECT 1 FROM runs WHERE org_id = $1 AND id = $2', [
      ids.orgA,
      runId,
    ]);
    return result.rowCount === 1;
  }

  async function archiveRevision(): Promise<string> {
    const result = await ownerPool.query<{ archive_revision: string }>(
      'SELECT archive_revision::text AS archive_revision FROM organizations WHERE id = $1',
      [ids.orgA],
    );
    return result.rows[0]!.archive_revision;
  }

  async function privilege(role: string, signature: string): Promise<boolean> {
    const result = await ownerPool.query<{ allowed: boolean }>(
      'SELECT has_function_privilege($1, $2, $3) AS allowed',
      [role, signature, 'EXECUTE'],
    );
    return result.rows[0]!.allowed;
  }

  describe('capability boundary', () => {
    it('gives the runtime and maintenance roles no table access and only the export functions', async () => {
      for (const role of ['running_tracker_runtime', 'running_tracker_maintenance']) {
        const result = await ownerPool.query<{ any_privilege: boolean }>(
          `SELECT (
             has_table_privilege($1, 'public.run_deletion_journal', 'SELECT')
             OR has_table_privilege($1, 'public.run_deletion_journal', 'INSERT')
             OR has_table_privilege($1, 'public.run_deletion_journal', 'UPDATE')
             OR has_table_privilege($1, 'public.run_deletion_journal', 'DELETE')
             OR has_table_privilege($1, 'public.run_deletion_journal', 'TRUNCATE')
           ) AS any_privilege`,
          [role],
        );
        expect(result.rows[0]!.any_privilege).toBe(false);
      }

      const claim = 'app_private.claim_deletion_journal_batch(integer)';
      const ack = 'app_private.ack_deletion_journal_batch(bigint[])';
      const reapply =
        'app_private.reapply_journaled_deletion(uuid, uuid, uuid, timestamptz, timestamptz)';
      const primitive = 'app_private.execute_run_deletion(uuid, uuid, uuid, timestamptz)';
      expect(await privilege('running_tracker_maintenance', claim)).toBe(true);
      expect(await privilege('running_tracker_maintenance', ack)).toBe(true);
      expect(await privilege('running_tracker_runtime', claim)).toBe(false);
      expect(await privilege('running_tracker_runtime', ack)).toBe(false);
      for (const signature of [reapply, primitive]) {
        expect(await privilege('running_tracker_maintenance', signature)).toBe(false);
        expect(await privilege('running_tracker_runtime', signature)).toBe(false);
      }
    });

    it('denies the runtime the journal, the export functions, and reapplication', async () => {
      await expect(runtimePool.query('SELECT * FROM run_deletion_journal')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        runtimePool.query('SELECT * FROM app_private.claim_deletion_journal_batch(10)'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        runtimePool.query(
          'SELECT app_private.reapply_journaled_deletion($1, $2, $3, $4, $5)',
          [ids.orgA, runIds.a, ids.userDual, deletedAt, restoreNow],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('denies maintenance direct table access and reapplication', async () => {
      await expect(maintenancePool.query('SELECT * FROM run_deletion_journal')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(maintenancePool.query('DELETE FROM run_deletion_journal')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        maintenancePool.query(
          'SELECT app_private.reapply_journaled_deletion($1, $2, $3, $4, $5)',
          [ids.orgA, runIds.a, ids.userDual, deletedAt, restoreNow],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('bounds the export functions', async () => {
      await expect(
        maintenancePool.query('SELECT * FROM app_private.claim_deletion_journal_batch(0)'),
      ).rejects.toMatchObject({ code: '22023' });
      await expect(
        maintenancePool.query('SELECT * FROM app_private.claim_deletion_journal_batch(1001)'),
      ).rejects.toMatchObject({ code: '22023' });
      await expect(
        maintenancePool.query('SELECT app_private.ack_deletion_journal_batch($1::bigint[])', [
          Array.from({ length: 1001 }, (_, index) => String(index + 1)),
        ]),
      ).rejects.toMatchObject({ code: '22023' });
    });
  });

  describe('journaling is atomic with deletion', () => {
    it('writes exactly one identifier-only row per owner deletion and none for a repeat', async () => {
      await seedRun(runIds.a);

      expect(await deleteAsOwner(runIds.a)).toBe('deleted');
      expect(await deleteAsOwner(runIds.a)).toBe('already_deleted');

      const rows = await journalRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        org_id: ids.orgA,
        owner_user_id: ids.userDual,
        run_id: runIds.a,
      });
      expect(rows[0]!.deleted_at.toISOString()).toBe(deletedAt);
      expect(Object.keys(rows[0]!).sort()).toEqual([
        'deleted_at',
        'journal_seq',
        'org_id',
        'owner_user_id',
        'run_id',
      ]);
    });

    it('writes no row when the deletion transaction rolls back', async () => {
      await seedRun(runIds.rollback);
      const client = await runtimePool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          "SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)",
          [ids.userDual, ids.orgA],
        );
        await client.query('SELECT * FROM app_private.delete_run_as_owner($1, $2, $3, $4)', [
          ids.orgA,
          runIds.rollback,
          ids.userDual,
          deletedAt,
        ]);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      expect(await journalRows()).toHaveLength(0);
      expect(await runExists(runIds.rollback)).toBe(true);
      expect(await tombstone(runIds.rollback)).toBeUndefined();
    });

    it('also journals annual retention deletions', async () => {
      await seedRun(runIds.retention, { finishedAt: '2030-01-01T00:00:00.000Z' });

      const result = await runRetentionDeleteOnce(maintenancePool, at('2032-01-10T00:00:00.000Z'));

      expect(result.status).toBe('deleted');
      const rows = await journalRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ owner_user_id: ids.userDual, run_id: runIds.retention });
    });
  });

  describe('durable export', () => {
    it('exports pending rows to a file and only then removes them from the database', async () => {
      await seedRun(runIds.a);
      await seedRun(runIds.b);
      await deleteAsOwner(runIds.a);
      await deleteAsOwner(runIds.b);
      const sink = createFileDeletionJournalSink(directory);

      const result = await exportOnce(sink);

      expect(result).toMatchObject({ exportedCount: 2, status: 'exported' });
      expect(await journalRows()).toHaveLength(0);
      const entries = await exportedEntries();
      expect(entries.map((entry) => entry.runId).sort()).toEqual([runIds.a, runIds.b]);
      expect(entries.every((entry) => entry.deletedAt === deletedAt && entry.ownerUserId === ids.userDual)).toBe(true);
      expect(await exportOnce(sink)).toEqual({ status: 'idle' });
    });

    it('keeps every row and writes nothing when the sink fails, then succeeds on retry', async () => {
      await seedRun(runIds.a);
      await deleteAsOwner(runIds.a);

      await expect(
        exportOnce({ write: () => Promise.reject(new Error('mount unavailable')) }),
      ).rejects.toThrow('mount unavailable');
      expect(await journalRows()).toHaveLength(1);

      await exportOnce(createFileDeletionJournalSink(directory));
      expect(await journalRows()).toHaveLength(0);
      expect((await exportedEntries()).map((entry) => entry.runId)).toEqual([runIds.a]);
    });

    it('re-exports a batch whose commit never happened (at-least-once), and reapplication tolerates the duplicate', async () => {
      await seedRun(runIds.a);
      await deleteAsOwner(runIds.a);
      const sink = createFileDeletionJournalSink(directory);

      // Simulate a crash between the durable write and COMMIT: the file exists but the row was kept.
      const client = await maintenancePool.connect();
      try {
        await client.query('BEGIN');
        const claimed = await client.query('SELECT * FROM app_private.claim_deletion_journal_batch(10)');
        expect(claimed.rowCount).toBe(1);
        await sink.write('deletion-journal-crashed-1-1-aaaaaaaa.ndjson', `${JSON.stringify({
          deletedAt,
          orgId: ids.orgA,
          ownerUserId: ids.userDual,
          runId: runIds.a,
          seq: '1',
          v: 1,
        })}\n`);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      expect(await journalRows()).toHaveLength(1);

      await exportOnce(sink);
      const entries = await exportedEntries();
      expect(entries.filter((entry) => entry.runId === runIds.a)).toHaveLength(2);

      await ownerPool.query('DELETE FROM run_tombstones');
      const report = await reapplyDeletions(ownerPool, at(restoreNow), await loadDeletionJournal(directory));
      expect(report.outcomes.marker_restored).toBe(1);
      expect(report.outcomes.marker_present).toBe(1);
    });

    it('lets two concurrent exporters take disjoint batches and drains a backlog in order', async () => {
      await ownerPool.query(
        `INSERT INTO run_deletion_journal (org_id, run_id, owner_user_id, deleted_at)
         SELECT $1, gen_random_uuid(), $2, $3::timestamptz FROM generate_series(1, 1200)`,
        [ids.orgA, ids.userDual, deletedAt],
      );
      const sink = createFileDeletionJournalSink(directory);

      const settled = await Promise.all([exportOnce(sink), exportOnce(sink)]);
      for (const result of settled) {
        expect(result.status).toBe('exported');
      }
      const remaining = await journalRows();
      expect(remaining.length).toBeLessThanOrEqual(200);

      while ((await exportOnce(sink)).status === 'exported') {
        // drain
      }
      expect(await journalRows()).toHaveLength(0);

      const entries = await exportedEntries();
      expect(entries).toHaveLength(1200);
      expect(new Set(entries.map((entry) => entry.seq)).size).toBe(1200);
      expect(new Set(entries.map((entry) => entry.runId)).size).toBe(1200);
    });
  });

  describe('restore-time reapplication', () => {
    function journalFrom(entries: DeletionJournalEntry[]) {
      return { entries, files: 1 };
    }

    function entryFor(runId: string, overrides: Partial<DeletionJournalEntry> = {}): DeletionJournalEntry {
      return {
        deletedAt,
        orgId: ids.orgA,
        ownerUserId: ids.userDual,
        runId,
        seq: '1',
        v: 1,
        ...overrides,
      };
    }

    it('re-deletes a run that a backup resurrected, keeps a one-year marker, and answers 410', async () => {
      await seedRun(runIds.a);
      await deleteAsOwner(runIds.a);
      await exportOnce(createFileDeletionJournalSink(directory));

      // The "restored backup": the run is back, the marker and the newer journal are gone.
      await ownerPool.query('DELETE FROM run_tombstones');
      await seedRun(runIds.a);
      const revisionBefore = await archiveRevision();

      const report = await reapplyDeletions(ownerPool, at(restoreNow), await loadDeletionJournal(directory));

      expect(report.outcomes.deleted).toBe(1);
      expect(await runExists(runIds.a)).toBe(false);
      const marker = await tombstone(runIds.a);
      expect(marker?.owner_user_id).toBe(ids.userDual);
      expect(marker?.deleted_at.toISOString()).toBe(deletedAt);
      expect(marker?.expires_at.toISOString()).toBe('2033-01-10T00:00:00.000Z');
      expect(BigInt(await archiveRevision())).toBe(BigInt(revisionBefore) + 1n);
      // The reapplied deletion is journaled again so the new node keeps exporting it.
      expect((await journalRows()).map((row) => row.run_id)).toEqual([runIds.a]);

      const login = await request(app)
        .post('/api/session')
        .set('Origin', allowedOrigin)
        .type('application/json')
        .send({ userId: ids.userDual })
        .expect(201);
      const csrf = (objectBody(login).csrf as Record<string, unknown>).token as string;
      const put = await request(app)
        .put(`/api/orgs/${ids.orgA}/runs/${runIds.a}`)
        .set('Cookie', cookiePair(login))
        .set('Origin', allowedOrigin)
        .set(csrfHeaderName, csrf)
        .type('application/json')
        .send({ startedAt: '2032-03-01T00:00:00.000Z' })
        .expect(410);
      expect(apiErrorResponseSchema.parse(objectBody(put)).error.code).toBe('RUN_DELETED');
    });

    it('is idempotent: a second application changes nothing further', async () => {
      await seedRun(runIds.a);
      const entries = [entryFor(runIds.a)];

      const first = await reapplyDeletions(ownerPool, at(restoreNow), journalFrom(entries));
      const revisionAfterFirst = await archiveRevision();
      const second = await reapplyDeletions(ownerPool, at(restoreNow), journalFrom(entries));

      expect(first.outcomes.deleted).toBe(1);
      expect(second.outcomes.marker_present).toBe(1);
      expect(second.outcomes.deleted).toBe(0);
      expect(await archiveRevision()).toBe(revisionAfterFirst);
    });

    it('restores a missing marker and lengthens a shorter one without shortening a longer one', async () => {
      const restored = await reapplyDeletions(
        ownerPool,
        at(restoreNow),
        journalFrom([entryFor(runIds.b)]),
      );
      expect(restored.outcomes.marker_restored).toBe(1);
      expect((await tombstone(runIds.b))?.expires_at.toISOString()).toBe('2033-01-10T00:00:00.000Z');

      await ownerPool.query(
        'UPDATE run_tombstones SET expires_at = $3 WHERE org_id = $1 AND run_id = $2',
        [ids.orgA, runIds.b, '2032-06-01T00:00:00.000Z'],
      );
      await reapplyDeletions(ownerPool, at(restoreNow), journalFrom([entryFor(runIds.b)]));
      expect((await tombstone(runIds.b))?.expires_at.toISOString()).toBe('2033-01-10T00:00:00.000Z');

      await ownerPool.query(
        'UPDATE run_tombstones SET expires_at = $3 WHERE org_id = $1 AND run_id = $2',
        [ids.orgA, runIds.b, '2040-01-01T00:00:00.000Z'],
      );
      await reapplyDeletions(ownerPool, at(restoreNow), journalFrom([entryFor(runIds.b)]));
      expect((await tombstone(runIds.b))?.expires_at.toISOString()).toBe('2040-01-01T00:00:00.000Z');
    });

    it('does not create a marker for a deletion whose one-year window has passed', async () => {
      const report = await reapplyDeletions(
        ownerPool,
        at('2034-01-01T00:00:00.000Z'),
        journalFrom([entryFor(runIds.c)]),
      );

      expect(report.outcomes.expired).toBe(1);
      expect(await tombstone(runIds.c)).toBeUndefined();
    });

    it('never deletes a run created after the journaled deletion (ID reuse)', async () => {
      await seedRun(runIds.a, {
        createdAt: '2032-02-01T00:00:00.000Z',
        finishedAt: '2032-02-02T00:00:00.000Z',
      });

      const report = await reapplyDeletions(
        ownerPool,
        at(restoreNow),
        journalFrom([entryFor(runIds.a)]),
      );

      expect(report.outcomes.skipped_newer_run).toBe(1);
      expect(await runExists(runIds.a)).toBe(true);
      expect(await tombstone(runIds.a)).toBeUndefined();
    });

    it('skips entries for organizations and members that do not exist in the restored data', async () => {
      const report = await reapplyDeletions(
        ownerPool,
        at(restoreNow),
        journalFrom([
          entryFor(runIds.unknown, { orgId: 'a7500000-0000-4000-8000-0000000000ff' }),
          entryFor(runIds.b, { ownerUserId: 'a7500000-0000-4000-8000-0000000000fe' }),
        ]),
      );

      expect(report.outcomes.skipped_unknown_organization).toBe(1);
      expect(report.outcomes.skipped_unknown_membership).toBe(1);
      expect(await tombstone(runIds.b)).toBeUndefined();
    });

    it('fails a whole restore step atomically per entry and can be re-run', async () => {
      await seedRun(runIds.a);
      const entries = [
        entryFor(runIds.a),
        entryFor(runIds.b, { deletedAt: 'not-an-instant' }),
      ];

      await expect(reapplyDeletions(ownerPool, at(restoreNow), journalFrom(entries))).rejects.toThrow();
      // The first entry committed in its own transaction; rerunning with a good journal finishes the job.
      expect(await runExists(runIds.a)).toBe(false);
      const rerun = await reapplyDeletions(
        ownerPool,
        at(restoreNow),
        journalFrom([entryFor(runIds.a), entryFor(runIds.b)]),
      );
      expect(rerun.outcomes.marker_present).toBe(1);
      expect(rerun.outcomes.marker_restored).toBe(1);
    });
  });
});

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { pendingLoginDigest } from '../src/auth/pending-login-store.js';
import { PostgresPendingLoginStore } from '../src/auth/postgres-pending-login-store.js';
import { PostgresSessionStore } from '../src/auth/postgres-session-store.js';
import { sessionCookieName } from '../src/auth/session-http.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { createBackup } from '../src/backup/backup-create.js';
import { createBackupDecryptor, verifyBackupFile } from '../src/backup/backup-envelope.js';
import { loadBackupKey } from '../src/backup/backup-key.js';
import { operatorEnvironment } from '../src/backup/operator-environment.js';
import { runRestoreDrill, type DrillOperations } from '../src/backup/restore-drill.js';
import { createRestoreDrillOperations } from '../src/backup/restore-drill-operations.js';
import { renderDrillReportMarkdown } from '../src/backup/restore-drill-report.js';
import { createPgToolRunner, parsePgConnection } from '../src/backup/pg-tools.js';
import { parseDrillConfiguration } from '../src/backup/restore-safety.js';
import { systemClock } from '../src/clock.js';
import { validateEnvironment } from '../src/config/environment.js';
import { withAuthenticatedTenantTransaction } from '../src/database/authenticated-tenant-transaction.js';
import { createMeal, deleteMeal } from '../src/meals/meal-service.js';
import { deleteActivity } from '../src/activities/activity-service.js';
import { readTcxActivity } from '../src/activities/tcx-activity.js';
import { confirmTcxImport } from '../src/activities/tcx-import-service.js';
import { startTestProvider } from './oidc-test-provider.js';

// These tests create, restore into, and drop throwaway *_restore_drill_* databases on the local
// server and run pg_dump/pg_restore, so they run only where the drill is configured (see .env.example).
const environment = operatorEnvironment();
const configured = Boolean(environment.RESTORE_DRILL_ADMIN_URL);
const drillTimeout = 180_000;

const options = { commands: [] as string[], commit: 'integration-test', keep: false };

// The drill makes its recovery journal copy read-only (0555 directory, 0444 files) on POSIX hosts, so a plain recursive
// rm of the work directory fails with EACCES there. Give every directory its write bit back first.
async function makeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o755).catch(() => undefined);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) await makeWritable(join(directory, entry.name));
  }
}

describe.skipIf(!configured)('P12.3/P12.4 backup, restore, deletion and access reapplication against real PostgreSQL', () => {
  const cleanups: (() => Promise<void>)[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
    for (const directory of directories.splice(0)) {
      await makeWritable(directory);
      await rm(directory, { force: true, recursive: true });
    }
  });

  async function harness(sourceSchema: 'current' | 'previous' = 'previous') {
    const commands: string[] = [];
    const configuration = parseDrillConfiguration(environment);
    const suffix = `it${randomBytes(4).toString('hex')}`;
    const workDirectory = await mkdtemp(join(tmpdir(), 'rt-drill-it-'));
    directories.push(workDirectory);
    // The drill requires a fresh work directory, so use a child that does not exist yet.
    const drillDirectory = join(workDirectory, 'run');
    const { databases, operations } = createRestoreDrillOperations({
      configuration,
      onCommand: (command) => commands.push(command),
      sourceSchema,
      suffix,
      workDirectory: drillDirectory,
    });
    cleanups.push(() => operations.cleanup());
    return { commands, configuration, databases, drillDirectory, operations };
  }

  async function databaseExists(adminMaintenanceUrl: string, name: string): Promise<boolean> {
    return withAdmin(adminMaintenanceUrl, async (client) => {
      const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      return result.rowCount === 1;
    });
  }

  async function withAdmin<T>(url: string, work: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  async function onlyBackupPath(drillDirectory: string): Promise<string> {
    const names = (await readdir(join(drillDirectory, 'backups'))).filter((name) => name.endsWith('.rtbak'));
    expect(names).toHaveLength(1);
    return join(drillDirectory, 'backups', names[0]!);
  }

  function wrap(
    operations: DrillOperations,
    overrides: Partial<DrillOperations>,
    calls: string[],
  ): DrillOperations {
    const wrapped: DrillOperations = { ...operations, ...overrides };
    const recorded = {} as Record<string, unknown>;
    for (const name of Object.keys(wrapped) as (keyof DrillOperations)[]) {
      const operation = Reflect.get(wrapped, name) as (...args: never[]) => unknown;
      recorded[name] = (...args: never[]) => {
        calls.push(name);
        return operation(...args);
      };
    }
    return recorded as unknown as DrillOperations;
  }

  it(
    'backs up, simulates loss, restores an older backup into a fresh database, migrates, and reapplies deletions and access restrictions twice without resurrecting or re-granting anything',
    async () => {
      const { databases, operations } = await harness('previous');

      const { exitCode, report } = await runRestoreDrill({ clock: systemClock, operations, options });

      expect(report.failure).toBeUndefined();
      expect(exitCode).toBe(0);
      expect(report.status).toBe('passed');
      expect(report.checks.length).toBeGreaterThan(15);
      expect(report.checks.filter((check) => !check.passed)).toEqual([]);
      expect(report.migration.backupBehindBy).toBe(1);
      expect(report.migration.firstRun).toMatchObject({ applied: 1 });
      expect(report.migration.secondRun?.applied).toBe(0);
      expect(report.journal.exported?.entries).toBe(3);
      expect(report.journal.firstPass?.outcomes).toMatchObject({ deleted: 2, marker_restored: 1 });
      expect(report.journal.secondPass?.outcomes).toMatchObject({ deleted: 0, marker_present: 3 });
      expect(report.access.exportedEntries).toBe(5);
      expect(report.access.firstPass?.outcomes).toEqual({
        already_applied: 2,
        applied: 3,
        skipped_unknown_organization: 0,
      });
      expect(report.access.secondPass?.outcomes).toEqual({
        already_applied: 5,
        applied: 0,
        skipped_unknown_organization: 0,
      });
      // ADR-0073: activity E was created before the backup and deleted after it. ADR-0074: so was check-in day G.
      // ADR-0078: and movement day M (the backup is one migration behind, at 0039, which has daily_movement). The
      // restored backup brought all three back, the ledger replay removed them again, and a second replay changed nothing.
      // ADR-0080 / ADR-0081: the older schema has the session and pending-login tables, so the source held one of each
      // at backup time and the backup carried neither. The one migration applied after the restore is 0040 (the
      // journal backlog-age capabilities, ADR-0037/ADR-0073), which adds two read-only functions. Meals (0039) are in
      // the older schema now but the drill creates none; they are proven by their own current-schema restore test.
      expect(report.sessions).toEqual({ cleared: 0, remaining: 0, restoredRows: 0, sourceRowsAtBackup: 1 });
      expect(report.pendingLogins).toEqual({ cleared: 0, remaining: 0, restoredRows: 0, sourceRowsAtBackup: 1 });
      expect(report.erasures.exportedEntries).toBe(3);
      expect(report.erasures.firstPass?.outcomes).toEqual({ absent: 0, erased: 3, skipped_different_record: 0 });
      expect(report.erasures.secondPass?.outcomes).toEqual({ absent: 3, erased: 0, skipped_different_record: 0 });
      const erasureCheckIds = [
        'erased-activity-existed-in-backup',
        'erased-daily-metric-existed-in-backup',
        'erased-daily-movement-existed-in-backup',
        'erasure-first-pass-outcomes',
        'erased-activity-absent',
        'erased-daily-metric-absent',
        'erased-daily-movement-absent',
        'surviving-activity-untouched',
        'surviving-daily-metric-untouched',
        'surviving-daily-movement-untouched',
        'derived-insights-existed-in-backup',
        'derived-insights-erased',
        'surviving-insight-untouched',
        'erasure-journaled-again',
        'erasure-second-pass-idempotent',
        'erasure-second-pass-changes-nothing',
        'erasure-ledger-denied-to-application',
      ];
      expect(
        erasureCheckIds.map((id) => [id, report.checks.find((check) => check.id === id)?.passed]),
      ).toEqual(erasureCheckIds.map((id) => [id, true]));
      // Stale access really was in the backup, and recovery removed it again as the runtime role sees it.
      expect(report.access.effectiveAccess).toEqual({
        recovered: { grantee: false, granteeTwo: false, keeper: true, leaver: false, owner: true },
        restored: { grantee: true, granteeTwo: true, keeper: true, leaver: true, owner: true },
        source: { grantee: false, granteeTwo: false, keeper: true, leaver: false, owner: true },
      });
      expect(report.recovery.pendingSteps).toEqual([]);
      expect(report.recovery.completedSteps.at(-1)).toBe('current_permissions_restored');
      // Complete recovery still does not reopen the database to the application.
      expect(report.recovery.applicationAccess).toBe('closed');
      expect(report.rpo.withinTarget).toBe(true);
      expect(report.rto.withinTarget).toBe(true);
      expect(report.cleanup).toBe('dropped');

      const text = JSON.stringify(report) + renderDrillReportMarkdown(report);
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/u);
      expect(text).not.toMatch(/_local_only|running_tracker_local/u);
      expect(text).not.toMatch(/postgres(ql)?:\/\//u);

      // The drill dropped only its own databases and left the development and test ones alone.
      expect(await databaseExists(databases.adminMaintenanceUrl, databases.source.database)).toBe(false);
      expect(await databaseExists(databases.adminMaintenanceUrl, databases.target.database)).toBe(false);
      expect(await databaseExists(databases.adminMaintenanceUrl, 'running_tracker_test')).toBe(true);
    },
    drillTimeout,
  );

  it(
    'restores a backup taken at the current schema, where the migration runner has nothing to apply',
    async () => {
      const { operations } = await harness('current');
      const { exitCode, report } = await runRestoreDrill({ clock: systemClock, operations, options });
      expect(report.failure).toBeUndefined();
      expect(exitCode).toBe(0);
      expect(report.migration.firstRun?.applied).toBe(0);
      // ADR-0080, ADR-0081: the source held one session and one pending login at backup time; the backup carried neither.
      expect(report.sessions).toEqual({ cleared: 0, remaining: 0, restoredRows: 0, sourceRowsAtBackup: 1 });
      expect(report.pendingLogins).toEqual({ cleared: 0, remaining: 0, restoredRows: 0, sourceRowsAtBackup: 1 });
      expect(
        report.checks
          .filter((check) => check.id.startsWith('session') || check.id.startsWith('pending-login'))
          .map((check) => [check.id, check.passed]),
      ).toEqual([
        ['sessions-not-in-backup', true],
        ['sessions-cleared-before-reopening', true],
        ['pending-logins-not-in-backup', true],
        ['pending-logins-cleared-before-reopening', true],
        ['session-store-denied-to-application', true],
        ['pending-login-store-denied-to-application', true],
      ]);
    },
    drillTimeout,
  );

  it(
    'rejects a real backup that was damaged in the ciphertext, in the tag, truncated, or opened with another key, and restores nothing',
    async () => {
      const { commands, configuration, databases, drillDirectory, operations } = await harness('current');
      await operations.prepare();
      await operations.createSourceDatabase();
      await operations.seedScenario();
      await operations.takeBackup();
      await operations.simulateSourceLoss();
      const path = await onlyBackupPath(drillDirectory);
      const original = await readFile(path);

      // The untouched artifact authenticates with the right key.
      await operations.verifyBackupArtifact();

      const wrongKey = randomBytes(32);
      await expect(verifyBackupFile(path, wrongKey)).rejects.toThrow('authentication failed');
      const rightKey = await loadBackupKey(configuration.keyFile);
      expect((await verifyBackupFile(path, rightKey)).plaintextBytes).toBeGreaterThan(1000);

      const damaged = Buffer.from(original);
      damaged[Math.floor(damaged.length / 2)] = damaged[Math.floor(damaged.length / 2)]! ^ 0x01;
      await writeFile(path, damaged);
      await expect(operations.verifyBackupArtifact()).rejects.toThrow('authentication failed');

      await writeFile(path, original.subarray(0, original.length - 200));
      await expect(operations.verifyBackupArtifact()).rejects.toThrow(/authentication failed|truncated/u);

      // Damage only the authentication tag: every byte of the dump is intact, so a streaming restore
      // would succeed before authentication could fail. The restore must therefore never start.
      const tagDamaged = Buffer.from(original);
      tagDamaged[tagDamaged.length - 1] = tagDamaged[tagDamaged.length - 1]! ^ 0x80;
      await writeFile(path, tagDamaged);
      await operations.createTargetDatabase();
      await operations.bootstrapTarget();
      await expect(operations.restoreBackup()).rejects.toThrow('authentication failed');
      expect(commands.filter((command) => command.includes('pg_restore --format'))).toEqual([]);
      const restored = await withAdmin(databases.target.adminUrl, (client) =>
        client.query<{ runs: string | null }>("SELECT to_regclass('public.runs')::text AS runs"),
      );
      expect(restored.rows[0]!.runs).toBeNull();
    },
    drillTimeout,
  );

  it(
    'aborts at a migration checksum mismatch in the restored database, never reapplies deletions, and keeps the databases',
    async () => {
      const { databases, operations } = await harness('current');
      const calls: string[] = [];
      const tampering = wrap(
        operations,
        {
          async restoreBackup() {
            await operations.restoreBackup();
            await withAdmin(databases.target.adminUrl, (client) =>
              client.query(
                "UPDATE schema_migrations SET checksum = 'tampered' WHERE id = (SELECT min(id) FROM schema_migrations)",
              ),
            );
          },
        },
        calls,
      );

      const { exitCode, report } = await runRestoreDrill({ clock: systemClock, operations: tampering, options });

      expect(exitCode).toBe(1);
      expect(report.status).toBe('failed');
      expect(report.failure?.step).toBe('migrate');
      expect(report.failure?.message).toContain('has changed');
      expect(report.failure?.message).not.toMatch(/_local_only|running_tracker_local/u);
      expect(calls).not.toContain('reapplyDeletions');
      expect(calls).not.toContain('cleanup');
      expect(report.recovery.completedSteps).not.toContain('migrations_applied');
      expect(await databaseExists(databases.adminMaintenanceUrl, databases.target.database)).toBe(true);
    },
    drillTimeout,
  );

  it(
    'refuses a malformed journal file before any restore starts',
    async () => {
      const { databases, drillDirectory, operations } = await harness('current');
      const calls: string[] = [];
      const poisoned = wrap(
        operations,
        {
          async copyJournalReadOnly() {
            await writeFile(
              join(drillDirectory, 'journal', 'deletion-journal-20300101T000000000Z-1-1-deadbeef.ndjson'),
              '{"v":1,"runId":"not-a-uuid"}\n',
            );
            return operations.copyJournalReadOnly();
          },
        },
        calls,
      );

      const { exitCode, report } = await runRestoreDrill({ clock: systemClock, operations: poisoned, options });

      expect(exitCode).toBe(1);
      expect(report.failure?.step).toBe('copy-journal');
      expect(calls).not.toContain('createTargetDatabase');
      expect(calls).not.toContain('restoreBackup');
      expect(await databaseExists(databases.adminMaintenanceUrl, databases.target.database)).toBe(false);
    },
    drillTimeout,
  );

  it(
    'refuses an access journal file that tries to grant access before any restore starts',
    async () => {
      const { databases, drillDirectory, operations } = await harness('current');
      const calls: string[] = [];
      const forged = wrap(
        operations,
        {
          async copyJournalReadOnly() {
            await writeFile(
              join(drillDirectory, 'journal', 'access-journal-20300101T000000000Z-1-1-deadbeef.ndjson'),
              `${JSON.stringify({
                canReadHistory: true,
                canReadLive: true,
                changedAt: '2030-01-01T00:00:00.000Z',
                kind: 'share_granted',
                orgId: 'd1200000-0000-4000-8000-0000000000a0',
                runId: 'd1200000-0000-4000-8000-0000000000c3',
                seq: '1',
                userId: 'd1200000-0000-4000-8000-0000000000b2',
                v: 1,
              })}\n`,
            );
            return operations.copyJournalReadOnly();
          },
        },
        calls,
      );

      const { exitCode, report } = await runRestoreDrill({ clock: systemClock, operations: forged, options });

      expect(exitCode).toBe(1);
      expect(report.failure?.step).toBe('copy-journal');
      expect(calls).not.toContain('createTargetDatabase');
      expect(calls).not.toContain('reapplyAccess');
      expect(await databaseExists(databases.adminMaintenanceUrl, databases.target.database)).toBe(false);
    },
    drillTimeout,
  );

  it(
    'an extra replay of the access journal by an impatient operator changes nothing',
    async () => {
      const { operations } = await harness('previous');
      const calls: string[] = [];
      let secondRunOutcomes: unknown;
      const replaying = wrap(
        operations,
        {
          async reapplyAccess() {
            const first = await operations.reapplyAccess();
            // Every further replay must be a no-op.
            secondRunOutcomes = (await operations.reapplyAccess()).outcomes;
            return first;
          },
        },
        calls,
      );

      const { report } = await runRestoreDrill({ clock: systemClock, operations: replaying, options });

      expect(secondRunOutcomes).toEqual({ already_applied: 5, applied: 0, skipped_unknown_organization: 0 });
      expect(report.checks.filter((check) => !check.passed)).toEqual([]);
    },
    drillTimeout,
  );

  it(
    'refuses to proceed while an application login still has a session on a drill database',
    async () => {
      const { databases, operations } = await harness('current');
      await operations.prepare();
      await operations.createSourceDatabase();

      const runtime = new Client({ connectionString: databases.source.runtimeUrl });
      await runtime.connect();
      try {
        await expect(operations.assertApplicationOffline()).rejects.toThrow('must be offline');
      } finally {
        await runtime.end();
      }
      await operations.assertApplicationOffline();
    },
    drillTimeout,
  );

  it(
    'keeps the application logins unable to connect to the restored database',
    async () => {
      const { databases, operations } = await harness('current');
      const calls: string[] = [];
      let connectError: unknown;
      const probing = wrap(
        operations,
        {
          async verifyReadiness() {
            const client = new Client({ connectionString: databases.target.runtimeUrl });
            connectError = await client.connect().then(
              () => client.end().then(() => undefined),
              (error: unknown) => error,
            );
            return operations.verifyReadiness();
          },
        },
        calls,
      );

      const { exitCode } = await runRestoreDrill({ clock: systemClock, operations: probing, options });

      expect(exitCode).toBe(0);
      expect(connectError).toBeInstanceOf(Error);
      expect((connectError as Error).message).toMatch(/permission denied for database|not currently accepting|does not exist/u);
    },
    drillTimeout,
  );

  // ADR-0080: an ordinary restart keeps sessions; a restore never brings one back. Current schema on purpose: the
  // previous-schema drill predates the session table, and no artificial migration is added to change that.
  it(
    'refuses every pre-restore session cookie, valid or revoked, even from a dump that carried session rows, keeps health data, and lets people sign in again',
    async () => {
      const { configuration, databases, drillDirectory, operations } = await harness('current');
      const key = await loadBackupKey(configuration.keyFile);
      const docker = configuration.dockerContainer ? { dockerContainer: configuration.dockerContainer } : {};
      const runner = createPgToolRunner(docker);
      await operations.prepare();
      await operations.createSourceDatabase();
      await operations.seedScenario();

      const pools: Pool[] = [];
      const managerFor = (runtimeUrl: string): SessionManager => {
        const pool = new Pool({ connectionString: runtimeUrl, max: 2 });
        pool.on('error', () => undefined);
        pools.push(pool);
        return new SessionManager({
          clock: systemClock,
          store: new PostgresSessionStore({ capacity: 100, clock: systemClock, operationTimeoutMs: 5_000, pool }),
          ttlMs: 8 * 60 * 60 * 1_000,
        });
      };
      cleanups.push(async () => {
        await Promise.allSettled(pools.map((pool) => pool.end()));
      });
      const healthCounts = (url: string) =>
        withAdmin(url, async (client) => {
          const result = await client.query<Record<string, string>>(
            `SELECT (SELECT count(*) FROM runs)::text AS runs, (SELECT count(*) FROM activities)::text AS activities,
                    (SELECT count(*) FROM daily_metrics)::text AS daily_metrics,
                    (SELECT count(*) FROM daily_movement)::text AS daily_movement`,
          );
          return result.rows[0];
        });
      const digestStored = (url: string, token: string) =>
        withAdmin(url, async (client) => {
          const digest = createHash('sha256').update(token, 'utf8').digest('base64url');
          const result = await client.query('SELECT 1 FROM app_private.auth_sessions WHERE token_digest = $1', [digest]);
          return result.rowCount === 1;
        });

      // Two people's browsers are signed in on the source, through the runtime role's own functions.
      const userId = await withAdmin(databases.source.ownerUrl, async (client) => {
        const result = await client.query<{ id: string }>('SELECT id FROM users ORDER BY id LIMIT 1');
        return result.rows[0]!.id;
      });
      const source = managerFor(databases.source.runtimeUrl);
      const valid = await source.create(userId);
      const revoked = await source.create(userId);

      // A hand-made dump that kept the session rows (pg_dump without the exclusion), then a sign-out after it.
      const carryingRunner = createPgToolRunner({
        ...docker,
        spawn: (command, args, spawnOptions) =>
          spawn(command, args.filter((arg) => !arg.startsWith('--exclude-table-data=')), spawnOptions),
      });
      const carrying = await createBackup({
        clock: systemClock,
        connection: parsePgConnection(databases.source.adminUrl),
        directory: join(drillDirectory, 'carrying'),
        key,
        runner: carryingRunner,
      });
      expect(await source.revoke(revoked.sessionToken)).toBe(true);
      // And an application backup, which excludes the rows.
      await operations.takeBackup();
      const atBackup = await healthCounts(databases.source.ownerUrl);
      expect(Number(atBackup!.activities) + Number(atBackup!.daily_metrics) + Number(atBackup!.daily_movement)).toBeGreaterThan(0);

      const config = (side: typeof databases.target) =>
        validateEnvironment({
          ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
          APP_ENV: 'test',
          DATABASE_URL: side.runtimeUrl,
          LOCAL_AUTH_ENABLED: 'true',
          LOCAL_AUTH_USER_IDS: userId,
          MAINTENANCE_DATABASE_URL: side.maintenanceUrl,
          SESSION_COOKIE_SECURE: 'false',
        });
      const openAndProve = async (): Promise<void> => {
        await withAdmin(databases.target.adminUrl, (client) =>
          client.query(`GRANT CONNECT ON DATABASE ${databases.target.database} TO running_tracker_runtime`),
        );
        const target = managerFor(databases.target.runtimeUrl);
        const appPool = pools.at(-1)!;
        const app = createApp({ clock: systemClock, config: config(databases.target), pool: appPool, sessionManager: target });
        for (const token of [valid.sessionToken, revoked.sessionToken]) {
          await request(app).get('/api/session').set('Cookie', `${sessionCookieName}=${token}`).expect(401);
          expect(await target.resolve(token)).toBeUndefined();
        }
        // A new sign-in works on the recovered database.
        const signIn = await request(app)
          .post('/api/session')
          .set('Origin', 'http://127.0.0.1:5173')
          .type('application/json')
          .send({ userId })
          .expect(201);
        const cookie = String((signIn.headers['set-cookie'] as unknown as string[])[0]).split(';', 1)[0]!;
        await request(app).get('/api/session').set('Cookie', cookie).expect(200);
        // Health data survived as the recovery rules say (nothing was deleted after this backup).
        expect(await healthCounts(databases.target.ownerUrl)).toEqual(atBackup);
        await Promise.allSettled(pools.splice(-1).map((pool) => pool.end()));
      };

      // 1. The application backup: the restored table is empty before anything clears it.
      await operations.createTargetDatabase();
      await operations.bootstrapTarget();
      await operations.restoreBackup();
      await operations.migrate();
      const fromApplicationBackup = await operations.clearSessions();
      expect(fromApplicationBackup).toEqual({
        pendingLogins: { cleared: 0, remaining: 0, restoredRows: 0, sourceRowsAtBackup: 1 },
        sessions: { cleared: 0, remaining: 0, restoredRows: 0, sourceRowsAtBackup: 2 },
      });
      await openAndProve();

      // 2. The dump that carried session rows: the revoked session's row is back until restore:clear-sessions runs.
      await withAdmin(databases.adminMaintenanceUrl, (client) =>
        client.query(`DROP DATABASE ${databases.target.database} WITH (FORCE)`),
      );
      await operations.createTargetDatabase();
      await operations.bootstrapTarget();
      await verifyBackupFile(carrying.path, key);
      const { stream } = await createBackupDecryptor(carrying.path, key);
      await runner.restore(parsePgConnection(databases.target.adminUrl), stream);
      await operations.migrate();
      expect(await digestStored(databases.target.ownerUrl, revoked.sessionToken)).toBe(true);
      expect(await digestStored(databases.target.ownerUrl, valid.sessionToken)).toBe(true);
      const fromCarryingDump = await operations.clearSessions();
      expect(fromCarryingDump).toMatchObject({
        pendingLogins: { cleared: 1, remaining: 0, restoredRows: 1 },
        sessions: { cleared: 3, remaining: 0, restoredRows: 3 },
      });
      expect(await digestStored(databases.target.ownerUrl, revoked.sessionToken)).toBe(false);
      await openAndProve();
    },
    drillTimeout,
  );

  // ADR-0081: an ordinary restart keeps pending OIDC logins; a restore never does. A sign-in that was between the
  // redirect to the provider and its callback when the backup was taken cannot complete on the recovered database, even
  // from a dump that carried its row, and a new sign-in through the same identity provider works. A real oidc-provider on
  // loopback runs the protocol; the external callback origin is fixed, as a deployment's would be.
  it(
    'refuses a pre-restore OIDC sign-in after recovery, even from a dump that carried it, and completes a new one',
    async () => {
      const { configuration, databases, drillDirectory, operations } = await harness('current');
      const key = await loadBackupKey(configuration.keyFile);
      const docker = configuration.dockerContainer ? { dockerContainer: configuration.dockerContainer } : {};
      const runner = createPgToolRunner(docker);
      const externalOrigin = 'http://127.0.0.1:5173';
      const oidcClient = { clientId: 'restore-test', clientSecret: 'restore-test-secret' };
      const provider = await startTestProvider({ ...oidcClient, redirectUri: `${externalOrigin}/api/auth/callback` });
      cleanups.push(() => provider.close());
      await operations.prepare();
      await operations.createSourceDatabase();
      await operations.seedScenario();

      const pools: Pool[] = [];
      cleanups.push(async () => {
        await Promise.allSettled(pools.map((pool) => pool.end()));
      });
      // One API instance over one side's database, with the stores main.ts wires.
      const appOn = (side: typeof databases.source) => {
        const config = validateEnvironment({
          ALLOWED_ORIGINS: externalOrigin,
          APP_ENV: 'test',
          DATABASE_URL: side.runtimeUrl,
          MAINTENANCE_DATABASE_URL: side.maintenanceUrl,
          OIDC_CLIENT_ID: oidcClient.clientId,
          OIDC_CLIENT_SECRET: oidcClient.clientSecret,
          OIDC_ISSUER_URL: provider.issuer,
          OIDC_REDIRECT_URI: `${externalOrigin}/api/auth/callback`,
          SESSION_COOKIE_SECURE: 'false',
        });
        const pool = new Pool({ connectionString: side.runtimeUrl, max: 3 });
        pool.on('error', () => undefined);
        pools.push(pool);
        const sessionManager = new SessionManager({
          clock: systemClock,
          store: new PostgresSessionStore({ capacity: 100, clock: systemClock, operationTimeoutMs: 5_000, pool }),
          ttlMs: config.SESSION_TTL_MS,
        });
        const oidcLoginStore = new PostgresPendingLoginStore({
          capacity: 100,
          clock: systemClock,
          operationTimeoutMs: 5_000,
          pool,
          ttlMs: config.OIDC!.loginTtlMs,
        });
        return createApp({ clock: systemClock, config, oidcLoginStore, pool, sessionManager });
      };
      const setCookies = (response: request.Response): string[] =>
        (response.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
      const beginSignIn = async (app: ReturnType<typeof appOn>) => {
        const started = await request(app).get('/api/auth/login').expect(302);
        const loginCookie = setCookies(started)[0]!.split(';', 1)[0]!;
        const returned = await provider.signIn(new URL(started.headers.location as string), 'alice');
        return { callbackPath: `${returned.pathname}${returned.search}`, loginCookie };
      };
      const loginStored = (url: string, loginCookie: string) =>
        withAdmin(url, async (client) => {
          const digest = pendingLoginDigest(loginCookie.slice('running_tracker_login='.length));
          const result = await client.query('SELECT 1 FROM app_private.oidc_pending_logins WHERE login_digest = $1', [digest]);
          return result.rowCount === 1;
        });

      // The identity is provisioned on the source, so every backup carries it.
      const userId = await withAdmin(databases.source.ownerUrl, async (client) => {
        const result = await client.query<{ id: string }>('SELECT id FROM users ORDER BY id LIMIT 1');
        await client.query('UPDATE users SET external_identity = $1 WHERE id = $2', [
          `${provider.issuer}|alice`,
          result.rows[0]!.id,
        ]);
        return result.rows[0]!.id;
      });

      // A browser is at the provider, its login stored on the source, when the backups are taken.
      const pending = await beginSignIn(appOn(databases.source));
      expect(await loginStored(databases.source.ownerUrl, pending.loginCookie)).toBe(true);
      const carryingRunner = createPgToolRunner({
        ...docker,
        spawn: (command, args, spawnOptions) =>
          spawn(command, args.filter((arg) => !arg.startsWith('--exclude-table-data=')), spawnOptions),
      });
      const carrying = await createBackup({
        clock: systemClock,
        connection: parsePgConnection(databases.source.adminUrl),
        directory: join(drillDirectory, 'carrying-logins'),
        key,
        runner: carryingRunner,
      });
      await operations.takeBackup();

      // The dump that carried the rows: the pending login is back until restore:clear-sessions removes it, with the
      // drill's own seeded one.
      await operations.createTargetDatabase();
      await operations.bootstrapTarget();
      await verifyBackupFile(carrying.path, key);
      const { stream } = await createBackupDecryptor(carrying.path, key);
      await runner.restore(parsePgConnection(databases.target.adminUrl), stream);
      await operations.migrate();
      expect(await loginStored(databases.target.ownerUrl, pending.loginCookie)).toBe(true);
      const cleared = await operations.clearSessions();
      expect(cleared.pendingLogins).toEqual({ cleared: 2, remaining: 0, restoredRows: 2, sourceRowsAtBackup: 2 });
      expect(await loginStored(databases.target.ownerUrl, pending.loginCookie)).toBe(false);

      // Reopened: the pre-restore sign-in cannot complete and reaches no provider; a new sign-in does.
      await withAdmin(databases.target.adminUrl, (client) =>
        client.query(`GRANT CONNECT ON DATABASE ${databases.target.database} TO running_tracker_runtime`),
      );
      const recovered = appOn(databases.target);
      const exchangesBefore = provider.tokenRequestCount();
      const stale = await request(recovered).get(pending.callbackPath).set('Cookie', pending.loginCookie).expect(302);
      expect(stale.headers.location).toBe('/?sign_in_error=login_expired');
      expect(setCookies(stale).some((line) => line.startsWith(`${sessionCookieName}=`))).toBe(false);
      expect(provider.tokenRequestCount()).toBe(exchangesBefore);

      const fresh = await beginSignIn(recovered);
      const completed = await request(recovered).get(fresh.callbackPath).set('Cookie', fresh.loginCookie).expect(200);
      const sessionCookie = setCookies(completed)
        .find((line) => line.startsWith(`${sessionCookieName}=`))!
        .split(';', 1)[0]!;
      const session = await request(recovered).get('/api/session').set('Cookie', sessionCookie).expect(200);
      expect(session.body).toMatchObject({ identity: { userId } });
      expect(provider.tokenRequestCount()).toBe(exchangesBefore + 1);
    },
    drillTimeout,
  );

  // ADR-0083: a meal deletion stays deleted through a real pg_dump/pg_restore. Current schema on purpose: the
  // previous-schema drill predates the meals table (it is the newest migration), and no artificial migration is added to
  // change that. The drill's own operations run every step; the meal entries are written and deleted by the application's
  // service as the runtime role.
  it(
    'reapplies an exported meal deletion after a real backup and restore, twice without change, keeping a recreated and a surviving entry',
    async () => {
      const { databases, operations } = await harness('current');
      await operations.prepare();
      await operations.createSourceDatabase();
      await operations.seedScenario();

      const owner = await withAdmin(databases.source.ownerUrl, async (client) => {
        const result = await client.query<{ org_id: string; user_id: string }>(
          `SELECT org_id, user_id FROM memberships WHERE role = 'runner' AND active ORDER BY user_id LIMIT 1`,
        );
        return result.rows[0]!;
      });
      const runtime = new Pool({ connectionString: databases.source.runtimeUrl, max: 1 });
      runtime.on('error', () => undefined);
      cleanups.push(() => runtime.end());
      const session = { userId: owner.user_id };
      const asOwner = <Result>(work: Parameters<typeof withAuthenticatedTenantTransaction<Result>>[3]) =>
        withAuthenticatedTenantTransaction(runtime, session, owner.org_id, work);
      const entry = (idempotencyKey: string, title: string) => ({
        energyKcal: 410.5,
        idempotencyKey,
        localDate: '2020-01-20',
        mealType: 'dinner' as const,
        proteinG: 0,
        timeZone: 'Europe/Warsaw',
        title,
      });
      const keys = {
        deleted: 'e1000000-0000-4000-8000-000000000001',
        recreated: 'e1000000-0000-4000-8000-000000000002',
        survivor: 'e1000000-0000-4000-8000-000000000003',
      };

      // Before the backup: K (deleted after it), L (survives), and R deleted and logged again from the same form session,
      // so the backup holds R's new version and the ledger holds the erasure of its old one.
      const deletedAfterBackup = await asOwner((client) => createMeal(client, session, owner.org_id, entry(keys.deleted, 'Deleted after backup'), systemClock));
      await asOwner((client) => createMeal(client, session, owner.org_id, entry(keys.survivor, 'Survivor'), systemClock));
      const replaced = await asOwner((client) => createMeal(client, session, owner.org_id, entry(keys.recreated, 'Recreated'), systemClock));
      await asOwner((client) => deleteMeal(client, session, owner.org_id, replaced.view.mealId));
      const recreated = await asOwner((client) => createMeal(client, session, owner.org_id, entry(keys.recreated, 'Recreated'), systemClock));
      expect(recreated.created).toBe(true);
      expect(recreated.view.mealId).not.toBe(replaced.view.mealId);

      const meals = (url: string) =>
        withAdmin(url, async (client) => {
          const result = await client.query<{ digest: string; id: string; title: string }>(
            'SELECT id, title, md5(meal::text) AS digest FROM meals AS meal ORDER BY title',
          );
          return result.rows;
        });
      const atBackup = await meals(databases.source.ownerUrl);
      expect(atBackup.map((row) => row.title)).toEqual(['Deleted after backup', 'Recreated', 'Survivor']);
      await operations.takeBackup();

      // After the backup: the drill's own deletions (they open the maintenance connection the export uses), then K.
      await operations.deleteAfterBackup();
      await asOwner((client) => deleteMeal(client, session, owner.org_id, deletedAfterBackup.view.mealId));
      const exported = await operations.exportJournal();
      // The drill's activity, check-in and movement erasures, R's older version and K.
      expect(exported.erasureEntries).toBe(5);
      await operations.copyJournalReadOnly();
      await runtime.end();
      cleanups.pop();

      await operations.createTargetDatabase();
      await operations.bootstrapTarget();
      await operations.restoreBackup();
      expect((await operations.migrate()).applied).toBe(0);
      // The restored backup brought K back, exactly as it was.
      expect(await meals(databases.target.ownerUrl)).toEqual(atBackup);

      const first = await operations.reapplyErasures();
      // Erased: the drill's three and K. Absent: R's older version (its id is not in the backup), so R stays.
      expect(first.outcomes).toEqual({ absent: 1, erased: 4, skipped_different_record: 0 });
      const afterFirst = await meals(databases.target.ownerUrl);
      expect(afterFirst).toEqual(atBackup.filter((row) => row.title !== 'Deleted after backup'));
      // The replayed deletion was journaled again on the recovered node, identifiers only.
      const journaledAgain = await withAdmin(databases.target.ownerUrl, async (client) => {
        const result = await client.query<{ record_id: string }>(`SELECT record_id FROM erasure_ledger WHERE entity_type = 'meal' AND record_id = $1`, [
          deletedAfterBackup.view.mealId,
        ]);
        return result.rowCount;
      });
      expect(journaledAgain).toBeGreaterThanOrEqual(1);

      const second = await operations.reapplyErasures();
      expect(second.outcomes).toEqual({ absent: 5, erased: 0, skipped_different_record: 0 });
      expect(await meals(databases.target.ownerUrl)).toEqual(afterFirst);
    },
    drillTimeout,
  );

  // ADR-0091: a deleted TCX import stays deleted through a real pg_dump/pg_restore of an older backup and the erasure
  // replay, through the same activity erasure-ledger path as every activity. The imports are written and deleted by the
  // application's TCX import service as the runtime role, from synthetic files.
  it(
    'keeps a TCX import deleted after a real backup and restore, sparing a re-imported version and a surviving import',
    async () => {
      const { databases, operations } = await harness('current');
      await operations.prepare();
      await operations.createSourceDatabase();
      await operations.seedScenario();

      const owner = await withAdmin(databases.source.ownerUrl, async (client) => {
        const result = await client.query<{ org_id: string; user_id: string }>(
          `SELECT org_id, user_id FROM memberships WHERE role = 'runner' AND active ORDER BY user_id LIMIT 1`,
        );
        return result.rows[0]!;
      });
      const runtime = new Pool({ connectionString: databases.source.runtimeUrl, max: 1 });
      runtime.on('error', () => undefined);
      cleanups.push(() => runtime.end());
      const session = { userId: owner.user_id };
      const asOwner = <Result>(work: Parameters<typeof withAuthenticatedTenantTransaction<Result>>[3]) =>
        withAuthenticatedTenantTransaction(runtime, session, owner.org_id, work);
      const tcx = (start: string) =>
        readTcxActivity(
          Buffer.from(
            `<?xml version="1.0" encoding="UTF-8"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Other"><Id>${start}</Id><Lap StartTime="${start}"><TotalTimeSeconds>1800.5</TotalTimeSeconds><DistanceMeters>1500</DistanceMeters></Lap></Activity></Activities></TrainingCenterDatabase>`,
          ),
          Date.now(),
        );
      const ids = {
        deleted: 'e2000000-0000-4000-8000-000000000001',
        reimported: 'e2000000-0000-4000-8000-000000000002',
        survivor: 'e2000000-0000-4000-8000-000000000003',
      };
      const save = (id: string, start: string, key: string) =>
        asOwner((client) => confirmTcxImport(client, session, owner.org_id, id, { idempotencyKey: key, type: 'swim' }, tcx(start)));

      // Before the backup: K (deleted after it), L (survives), and R imported, deleted and imported again under the same
      // id, so the backup holds R's newer version and the ledger the erasure of its older one.
      expect((await save(ids.deleted, '2020-01-20T06:00:00Z', 'f2000000-0000-4000-8000-000000000001')).created).toBe(true);
      expect((await save(ids.survivor, '2020-01-21T06:00:00Z', 'f2000000-0000-4000-8000-000000000002')).created).toBe(true);
      await save(ids.reimported, '2020-01-22T06:00:00Z', 'f2000000-0000-4000-8000-000000000003');
      await asOwner((client) => deleteActivity(client, session, owner.org_id, ids.reimported));
      expect((await save(ids.reimported, '2020-01-22T06:00:00Z', 'f2000000-0000-4000-8000-000000000004')).created).toBe(true);

      const imports = (url: string) =>
        withAdmin(url, async (client) => {
          const result = await client.query<{ digest: string; duration_s: number; id: string; source: string }>(
            `SELECT id, source, duration_s, md5(activity::text) AS digest FROM activities AS activity WHERE source = 'tcx' ORDER BY id`,
          );
          return result.rows;
        });
      const atBackup = await imports(databases.source.ownerUrl);
      expect(atBackup.map((row) => [row.id, row.source, row.duration_s])).toEqual([
        [ids.deleted, 'tcx', 1801],
        [ids.reimported, 'tcx', 1801],
        [ids.survivor, 'tcx', 1801],
      ]);
      await operations.takeBackup();

      // After the backup: the drill's own deletions, then K through the service.
      await operations.deleteAfterBackup();
      await asOwner((client) => deleteActivity(client, session, owner.org_id, ids.deleted));
      const exported = await operations.exportJournal();
      // The drill's activity, check-in and movement erasures, R's older version and K.
      expect(exported.erasureEntries).toBe(5);
      await operations.copyJournalReadOnly();
      await runtime.end();
      cleanups.pop();

      await operations.createTargetDatabase();
      await operations.bootstrapTarget();
      await operations.restoreBackup();
      expect((await operations.migrate()).applied).toBe(0);
      // The restored older backup brought K back, exactly as it was.
      expect(await imports(databases.target.ownerUrl)).toEqual(atBackup);

      const first = await operations.reapplyErasures();
      // Erased: the drill's three and K. Skipped: R's older version, whose id now holds the newer version (other creation instant).
      expect(first.outcomes).toEqual({ absent: 0, erased: 4, skipped_different_record: 1 });
      const afterFirst = await imports(databases.target.ownerUrl);
      expect(afterFirst).toEqual(atBackup.filter((row) => row.id !== ids.deleted));

      const second = await operations.reapplyErasures();
      expect(second.outcomes).toEqual({ absent: 4, erased: 0, skipped_different_record: 1 });
      expect(await imports(databases.target.ownerUrl)).toEqual(afterFirst);
    },
    drillTimeout,
  );
});

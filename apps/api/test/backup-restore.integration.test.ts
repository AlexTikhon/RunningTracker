import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { verifyBackupFile } from '../src/backup/backup-envelope.js';
import { loadBackupKey } from '../src/backup/backup-key.js';
import { operatorEnvironment } from '../src/backup/operator-environment.js';
import { runRestoreDrill, type DrillOperations } from '../src/backup/restore-drill.js';
import { createRestoreDrillOperations } from '../src/backup/restore-drill-operations.js';
import { renderDrillReportMarkdown } from '../src/backup/restore-drill-report.js';
import { parseDrillConfiguration } from '../src/backup/restore-safety.js';
import { systemClock } from '../src/clock.js';

// These tests create, restore into, and drop throwaway *_restore_drill_* databases on the local
// server and run pg_dump/pg_restore, so they run only where the drill is configured (see .env.example).
const environment = operatorEnvironment();
const configured = Boolean(environment.RESTORE_DRILL_ADMIN_URL);
const drillTimeout = 180_000;

const options = { commands: [] as string[], commit: 'integration-test', keep: false };

describe.skipIf(!configured)('P12.3/P12.4 backup, restore, deletion and access reapplication against real PostgreSQL', () => {
  const cleanups: (() => Promise<void>)[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
    for (const directory of directories.splice(0)) await rm(directory, { force: true, recursive: true });
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
});

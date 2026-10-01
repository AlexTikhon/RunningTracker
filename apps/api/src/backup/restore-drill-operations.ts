import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { Client, Pool } from 'pg';

import { systemClock, type Clock } from '../clock.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { createFileDeletionJournalSink } from '../maintenance/deletion-journal-sink.js';
import { runDeletionJournalExportOnce } from '../maintenance/run-deletion-journal-export.js';
import { runRetentionDeleteOnce } from '../maintenance/run-retention-delete.js';
import { runReapplyCli } from '../restore/reapply-deletions-cli.js';
import { loadDeletionJournal, reapplyOutcomes, type ReapplyOutcome } from '../restore/reapply-deletions.js';
import { deleteRun } from '../runs/run-service.js';
import { createBackup, readSourceFacts } from './backup-create.js';
import { createBackupDecryptor, verifyBackupFile } from './backup-envelope.js';
import { loadBackupKey } from './backup-key.js';
import { createPgToolRunner, parsePgConnection, type PgToolRunner } from './pg-tools.js';
import {
  countedTables,
  type Check,
  type DatabaseState,
  type DrillOperations,
  type JournalFacts,
  type MigrationRun,
  type ReapplyRun,
  type RoleFacts,
  type RunLabel,
  type RunLabelState,
} from './restore-drill.js';
import {
  assertDatabaseMayBeDropped,
  assertDrillDatabaseName,
  deriveDrillDatabases,
  drillDatabasePrefix,
  type DrillConfiguration,
  type DrillDatabases,
  type DrillSide,
} from './restore-safety.js';

const execFileAsync = promisify(execFile);

export const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..', '..');

/** Fixed identifiers of the deterministic scenario. They exist only inside throwaway drill databases. */
const ids = {
  org: 'd1200000-0000-4000-8000-0000000000a0',
  ownerUser: 'd1200000-0000-4000-8000-0000000000b1',
  granteeUser: 'd1200000-0000-4000-8000-0000000000b2',
  runs: {
    A: 'd1200000-0000-4000-8000-0000000000c1',
    B: 'd1200000-0000-4000-8000-0000000000c2',
    C: 'd1200000-0000-4000-8000-0000000000c3',
    D: 'd1200000-0000-4000-8000-0000000000c4',
  } satisfies Record<RunLabel, string>,
};

const labels = ['A', 'B', 'C', 'D'] as const;
const dayMs = 24 * 60 * 60 * 1000;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function withClient<T>(url: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ application_name: 'running-tracker-restore-drill', connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function manifestOf(directory: string): Promise<{ digest: string; files: number }> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.ndjson')).sort();
  const lines: string[] = [];
  for (const name of names) {
    const hash = createHash('sha256').update(await readFile(join(directory, name))).digest('hex');
    lines.push(`${name} ${hash}`);
  }
  return { digest: createHash('sha256').update(lines.join('\n')).digest('hex'), files: names.length };
}

function scrubSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join('[redacted]');
  }
  return result.slice(-2000);
}

export interface DrillOperationsOptions {
  clock?: Clock;
  configuration: DrillConfiguration;
  /** Records each external command line, without secrets, for the report. */
  onCommand: (command: string) => void;
  runner?: PgToolRunner;
  /** `previous` (default): the source is migrated one migration short, so restoring it needs a catch-up. */
  sourceSchema?: 'current' | 'previous';
  suffix: string;
  workDirectory: string;
}

export interface DrillOperationsHandle {
  databases: DrillDatabases;
  operations: DrillOperations;
}

export function createRestoreDrillOperations(options: DrillOperationsOptions): DrillOperationsHandle {
  const { configuration, onCommand, workDirectory } = options;
  const clock = options.clock ?? systemClock;
  const databases = deriveDrillDatabases(configuration, options.suffix);
  const { source, target } = databases;
  const runner =
    options.runner ??
    createPgToolRunner({
      ...(configuration.dockerContainer ? { dockerContainer: configuration.dockerContainer } : {}),
      onCommand: (argv) => onCommand(argv.join(' ')),
    });
  const backupDirectory = join(workDirectory, 'backups');
  const journalDirectory = join(workDirectory, 'journal');
  const recoveryJournalDirectory = join(workDirectory, 'journal-recovery');
  const secrets = [
    configuration.admin.password,
    configuration.owner.password,
    configuration.runtime.password,
    configuration.maintenance.password,
  ];

  let key: Buffer | undefined;
  let backupPath = '';
  let backupCreatedAt = '';
  let exportedDigest = '';
  let sourcePools: Pool[] = [];
  let sourceMaintenancePool: Pool | undefined;

  function requireKey(): Buffer {
    if (!key) throw new Error('The backup encryption key is not loaded');
    return key;
  }

  async function runScript(script: string, side: DrillSide, cwd: string = repositoryRoot): Promise<string> {
    const env = {
      ...process.env,
      BOOTSTRAP_DATABASE_URL: side.adminUrl,
      DATABASE_URL: side.runtimeUrl,
      MAINTENANCE_DATABASE_URL: side.maintenanceUrl,
      MIGRATION_DATABASE_URL: side.ownerUrl,
    };
    onCommand(
      `node scripts/${script}  (BOOTSTRAP_DATABASE_URL, MIGRATION_DATABASE_URL, DATABASE_URL and MAINTENANCE_DATABASE_URL set to ${side.database})`,
    );
    try {
      const { stdout } = await execFileAsync(process.execPath, [join(repositoryRoot, 'scripts', script)], {
        cwd,
        env,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const failure = error as { stderr?: string; stdout?: string };
      const detail = scrubSecrets(`${failure.stderr ?? ''}${failure.stdout ?? ''}`, secrets).trim();
      throw new Error(`scripts/${script} failed${detail ? `: ${detail}` : ''}`, { cause: error });
    }
  }

  async function createDatabase(side: DrillSide): Promise<void> {
    assertDrillDatabaseName(side.database);
    await withClient(databases.adminMaintenanceUrl, async (client) => {
      const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [side.database]);
      if (existing.rowCount !== 0) {
        throw new Error('A drill database with this name already exists; use a new suffix or run the cleanup command');
      }
      await client.query(`CREATE DATABASE ${quoteIdentifier(side.database)}`);
    });
  }

  async function dropDatabase(name: string): Promise<void> {
    assertDatabaseMayBeDropped(name);
    await withClient(databases.adminMaintenanceUrl, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
    });
  }

  async function inspect(side: DrillSide): Promise<{ databaseBytes: number; state: DatabaseState }> {
    return withClient(side.ownerUrl, async (client) => {
      const counts = {} as DatabaseState['counts'];
      for (const table of countedTables) {
        const result = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
        counts[table] = Number(result.rows[0]!.count);
      }
      const revision = await client.query<{ archive_revision: string }>(
        'SELECT archive_revision::text AS archive_revision FROM organizations WHERE id = $1',
        [ids.org],
      );
      const runs = {} as Record<RunLabel, RunLabelState>;
      for (const label of labels) {
        const runId = ids.runs[label];
        const row = await client.query<{
          deleted_at: Date | null;
          expires_at: Date | null;
          points: string;
          run: boolean;
          shares: string;
          summaries: string;
        }>(
          `SELECT EXISTS (SELECT 1 FROM runs WHERE org_id = $1 AND id = $2) AS run,
                  (SELECT count(*) FROM run_points WHERE org_id = $1 AND run_id = $2)::text AS points,
                  (SELECT count(*) FROM run_summaries WHERE org_id = $1 AND run_id = $2)::text AS summaries,
                  (SELECT count(*) FROM run_shares WHERE org_id = $1 AND run_id = $2)::text AS shares,
                  (SELECT deleted_at FROM run_tombstones WHERE org_id = $1 AND run_id = $2) AS deleted_at,
                  (SELECT expires_at FROM run_tombstones WHERE org_id = $1 AND run_id = $2) AS expires_at`,
          [ids.org, runId],
        );
        const value = row.rows[0]!;
        runs[label] = {
          points: Number(value.points),
          run: value.run,
          shares: Number(value.shares),
          summaries: Number(value.summaries),
          tombstone:
            value.deleted_at && value.expires_at
              ? { deletedAt: value.deleted_at.toISOString(), expiresAt: value.expires_at.toISOString() }
              : null,
        };
      }
      const digest = await client.query<{ digest: string }>(
        `SELECT md5(coalesce(string_agg(
                  seq::text || ':' || ST_AsEWKT(geom) || ':' || recorded_at::text || ':' || accuracy_m::text,
                  ',' ORDER BY seq), '')) AS digest
         FROM run_points WHERE org_id = $1 AND run_id = $2`,
        [ids.org, ids.runs.C],
      );
      const size = await client.query<{ bytes: string }>('SELECT pg_database_size(current_database())::text AS bytes');
      return {
        databaseBytes: Number(size.rows[0]!.bytes),
        state: {
          archiveRevision: revision.rows[0]?.archive_revision ?? 'missing',
          counts,
          runs,
          survivorDigest: digest.rows[0]!.digest,
        },
      };
    });
  }

  async function closeSourcePools(): Promise<void> {
    const pools = sourcePools;
    sourcePools = [];
    await Promise.all(pools.map((pool) => pool.end()));
  }

  async function terminateSessions(name: string): Promise<void> {
    await withClient(databases.adminMaintenanceUrl, async (client) => {
      await client.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [name],
      );
    });
  }

  async function seedRun(
    client: Client,
    label: RunLabel,
    timing: { createdAt: Date; finishedAt: Date; startedAt: Date },
    withChildren: boolean,
  ): Promise<void> {
    const runId = ids.runs[label];
    await client.query(
      `INSERT INTO runs (org_id, id, user_id, status, started_at, created_at, finished_at,
                         data_revision, control_revision, raw_state)
       VALUES ($1, $2, $3, 'finished', $4, $5, $6, 1, 0, 'available')`,
      [ids.org, runId, ids.ownerUser, timing.startedAt, timing.createdAt, timing.finishedAt],
    );
    if (!withChildren) return;
    const offset = labels.indexOf(label);
    for (let seq = 1; seq <= 3; seq += 1) {
      await client.query(
        `INSERT INTO run_points (org_id, run_id, seq, segment_id, recorded_at, received_at, geom, accuracy_m, ingested_revision)
         VALUES ($1, $2, $3, 0, $4, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326), 5.0, 1)`,
        [
          ids.org,
          runId,
          seq,
          new Date(timing.startedAt.getTime() + seq * 1000),
          21.0 + offset / 100 + seq / 10_000,
          52.0 + offset / 100 + seq / 10_000,
        ],
      );
    }
    await client.query(
      `INSERT INTO run_summaries (org_id, run_id, source_revision, algorithm_version, display_geom,
                                  distance_m, observed_duration_s, quality_stats, computed_at)
       VALUES ($1, $2, 1, 'drill-fixture-v1',
               ST_GeomFromText('MULTILINESTRING((21.0 52.0, 21.001 52.001))', 4326),
               130.5, 60.25,
               jsonb_build_object('rawPointCount', 3, 'acceptedPointCount', 3, 'acceptedEdgeCount', 2,
                 'poorAccuracyPointCount', 0, 'seqGapCount', 0, 'segmentBreakCount', 0,
                 'nonpositiveTimeDeltaCount', 0, 'excessiveTimeGapCount', 0, 'excessiveSpeedCount', 0,
                 'insufficientData', false),
               $3)`,
      [ids.org, runId, timing.finishedAt],
    );
    await client.query(
      `INSERT INTO run_shares (org_id, run_id, grantee_user_id, can_read_live, can_read_history)
       VALUES ($1, $2, $3, false, true)`,
      [ids.org, runId, ids.granteeUser],
    );
  }

  const operations: DrillOperations = {
    async assertApplicationOffline() {
      await withClient(databases.adminMaintenanceUrl, async (client) => {
        const sessions = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM pg_stat_activity
           WHERE datname LIKE $1
             AND usename IN ('running_tracker_runtime', 'running_tracker_maintenance')`,
          [`${drillDatabasePrefix}%`],
        );
        if (sessions.rows[0]!.count !== '0') {
          throw new Error('An application login still has a session on a drill database; the application must be offline');
        }
      });
    },

    async bootstrapTarget() {
      await runScript('bootstrap-database.mjs', target);
      // Quarantine: the application logins cannot even connect until a later stage opens the database.
      await withClient(target.adminUrl, async (client) => {
        await client.query(
          `REVOKE CONNECT ON DATABASE ${quoteIdentifier(target.database)} FROM running_tracker_runtime, running_tracker_maintenance`,
        );
      });
    },

    async cleanup() {
      await closeSourcePools();
      await dropDatabase(source.database);
      await dropDatabase(target.database);
    },

    async copyJournalReadOnly() {
      await rm(recoveryJournalDirectory, { force: true, recursive: true });
      await cp(journalDirectory, recoveryJournalDirectory, { recursive: true });
      const names = (await readdir(recoveryJournalDirectory)).filter((name) => name.endsWith('.ndjson'));
      for (const name of names) {
        await chmod(join(recoveryJournalDirectory, name), 0o444);
      }
      if (process.platform !== 'win32') {
        await chmod(recoveryJournalDirectory, 0o555);
      }
      let readOnlyEnforced = true;
      const probe = names[0];
      if (probe) {
        try {
          const handle = await open(join(recoveryJournalDirectory, probe), 'r+');
          await handle.close();
          readOnlyEnforced = false;
        } catch {
          readOnlyEnforced = true;
        }
      }
      const journal = await loadDeletionJournal(recoveryJournalDirectory);
      const manifest = await manifestOf(recoveryJournalDirectory);
      return {
        entries: journal.entries.length,
        files: manifest.files,
        manifestDigest: manifest.digest,
        readOnlyEnforced,
      };
    },

    async createSourceDatabase() {
      await createDatabase(source);
      await runScript('bootstrap-database.mjs', source);
      if ((options.sourceSchema ?? 'previous') === 'current') {
        await runScript('migrate.mjs', source);
        return { migrationsBehind: 0 };
      }
      // The unchanged runner reads db/migrations from its working directory: give it every file except
      // the newest, so the backup is genuinely older than the repository without a restore-only code path.
      const migrationFiles = (await readdir(join(repositoryRoot, 'db', 'migrations'))).filter((name) => name.endsWith('.sql')).sort();
      const olderRoot = join(workDirectory, 'older-schema');
      await mkdir(join(olderRoot, 'db', 'migrations'), { recursive: true });
      for (const name of migrationFiles.slice(0, -1)) {
        await cp(join(repositoryRoot, 'db', 'migrations', name), join(olderRoot, 'db', 'migrations', name));
      }
      await runScript('migrate.mjs', source, olderRoot);
      return { migrationsBehind: 1 };
    },

    async createTargetDatabase() {
      await createDatabase(target);
    },

    async deleteAfterBackup() {
      const runtimePool = new Pool({ application_name: 'running-tracker-restore-drill-runtime', connectionString: source.runtimeUrl, max: 2 });
      const maintenancePool = new Pool({ application_name: 'running-tracker-restore-drill-maintenance', connectionString: source.maintenanceUrl, max: 2 });
      sourcePools.push(runtimePool, maintenancePool);
      sourceMaintenancePool = maintenancePool;
      // Separate the backup instant from every deletion instant, whatever the clock resolution.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));

      await withClient(source.ownerUrl, async (client) => {
        const created = clock.utcNow();
        await seedRun(
          client,
          'D',
          {
            createdAt: created,
            finishedAt: created,
            startedAt: new Date(created.getTime() - 60_000),
          },
          false,
        );
      });

      const session = { userId: ids.ownerUser };
      for (const label of ['A', 'D'] as const) {
        await withAuthenticatedTenantTransaction(runtimePool, session, ids.org, (client) =>
          deleteRun(client, session, ids.org, ids.runs[label], systemClock),
        );
      }
      const retention = await runRetentionDeleteOnce(maintenancePool, clock);
      if (retention.status !== 'deleted' || retention.runId !== ids.runs.B) {
        throw new Error('Annual retention did not delete the expected run');
      }

      const journal = await withClient(source.ownerUrl, (client) =>
        client.query<{ deleted_at: Date }>('SELECT deleted_at FROM run_deletion_journal ORDER BY journal_seq'),
      );
      return { deletedAt: journal.rows.map((row) => row.deleted_at.toISOString()) };
    },

    async exportJournal() {
      await rm(journalDirectory, { force: true, recursive: true });
      await mkdir(journalDirectory, { recursive: true });
      const maintenancePool = sourceMaintenancePool;
      if (!maintenancePool) throw new Error('The maintenance connection of the source is not open');
      const sink = createFileDeletionJournalSink(journalDirectory);
      await sink.verify();
      let exportedBatches = 0;
      for (;;) {
        const result = await runDeletionJournalExportOnce(maintenancePool, sink, clock);
        if (result.status === 'idle') break;
        exportedBatches += 1;
      }
      if (exportedBatches === 0) {
        throw new Error('The deletion journal exporter exported nothing');
      }
      const pending = await withClient(source.ownerUrl, (client) =>
        client.query<{ count: string }>('SELECT count(*)::text AS count FROM run_deletion_journal'),
      );
      if (pending.rows[0]!.count !== '0') {
        throw new Error('The deletion journal outbox still holds rows after export');
      }
      const journal = await loadDeletionJournal(journalDirectory);
      const manifest = await manifestOf(journalDirectory);
      exportedDigest = manifest.digest;
      return { entries: journal.entries.length, files: manifest.files, manifestDigest: manifest.digest } satisfies JournalFacts;
    },

    async inspectSource() {
      return inspect(source);
    },

    async inspectTarget() {
      return (await inspect(target)).state;
    },

    async migrate() {
      const output = await runScript('migrate.mjs', target);
      const lines = output.split(/\r?\n/u);
      return {
        applied: lines.filter((line) => line.startsWith('apply ')).length,
        skipped: lines.filter((line) => line.startsWith('skip ')).length,
      } satisfies MigrationRun;
    },

    async prepare() {
      key = await loadBackupKey(configuration.keyFile);
      const pgDump = await runner.version('pg_dump');
      const pgRestore = await runner.version('pg_restore');
      const server = await withClient(databases.adminMaintenanceUrl, async (client) => {
        const role = await client.query<{ rolsuper: boolean }>(
          'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
        );
        if (role.rows[0]?.rolsuper !== true) {
          throw new Error('The administrator login must be a PostgreSQL superuser: it must read every row and restore the extension');
        }
        const version = await client.query<{ server_version: string }>('SHOW server_version');
        const postgis = await client.query<{ default_version: string | null }>(
          "SELECT default_version FROM pg_available_extensions WHERE name = 'postgis'",
        );
        const existing = await client.query<{ datname: string }>(
          'SELECT datname FROM pg_database WHERE datname = ANY($1::text[])',
          [[source.database, target.database]],
        );
        if (existing.rowCount !== 0) {
          throw new Error('A drill database with this suffix already exists; the drill needs a fresh start');
        }
        return { postgis: postgis.rows[0]?.default_version ?? 'unavailable', postgres: version.rows[0]!.server_version };
      });
      await stat(workDirectory).then(
        () => {
          throw new Error('The drill work directory already exists; the drill needs a fresh start');
        },
        () => undefined,
      );
      await mkdir(workDirectory, { recursive: true });
      return {
        node: process.version,
        pgDump,
        pgRestore,
        postgis: server.postgis,
        postgres: server.postgres,
        runnerMode: configuration.dockerContainer ? ('docker-exec' as const) : ('local' as const),
      };
    },

    async reapplyDeletions() {
      onCommand(`restore:reapply-deletions --journal-dir <recovery copy>  (RESTORE_DATABASE_URL = owner of ${target.database})`);
      const lines: string[] = [];
      await runReapplyCli({
        argv: ['--journal-dir', recoveryJournalDirectory],
        env: { RESTORE_DATABASE_URL: target.ownerUrl },
        log: (line) => lines.push(line),
      });
      const value = (name: string): number => {
        const line = lines.find((entry) => entry.startsWith(`${name}: `));
        if (!line) throw new Error('The reapplication report is incomplete');
        return Number(line.slice(name.length + 2));
      };
      const outcomes = Object.fromEntries(reapplyOutcomes.map((name) => [name, value(name)])) as Record<
        ReapplyOutcome,
        number
      >;
      return { entries: value('journal entries'), files: value('journal files'), outcomes } satisfies ReapplyRun;
    },

    async restoreBackup() {
      // GCM authenticates only at the end of the stream, after pg_restore could already have committed.
      // Authenticate the whole file first so that no byte of an unverified dump ever reaches pg_restore.
      await verifyBackupFile(backupPath, requireKey());
      const { stream } = await createBackupDecryptor(backupPath, requireKey());
      await runner.restore(parsePgConnection(target.adminUrl), stream);
    },

    async seedScenario() {
      await withClient(source.ownerUrl, async (client) => {
        await client.query(
          `INSERT INTO users (id, external_identity) VALUES ($1, 'drill-owner'), ($2, 'drill-grantee')`,
          [ids.ownerUser, ids.granteeUser],
        );
        await client.query('INSERT INTO organizations (id) VALUES ($1)', [ids.org]);
        await client.query(
          `INSERT INTO memberships (org_id, user_id, role, active)
           VALUES ($1, $2, 'runner', true), ($1, $3, 'coach', true)`,
          [ids.org, ids.ownerUser, ids.granteeUser],
        );
        const now = clock.utcNow().getTime();
        const timing = (finishedDaysAgo: number) => {
          const finishedAt = new Date(now - finishedDaysAgo * dayMs);
          const startedAt = new Date(finishedAt.getTime() - 3_600_000);
          return { createdAt: startedAt, finishedAt, startedAt };
        };
        await seedRun(client, 'A', timing(2), true);
        await seedRun(client, 'B', timing(400), true);
        await seedRun(client, 'C', timing(1), true);
      });
    },

    async simulateSourceLoss() {
      await closeSourcePools();
      await withClient(databases.adminMaintenanceUrl, async (client) => {
        await client.query(`ALTER DATABASE ${quoteIdentifier(source.database)} WITH ALLOW_CONNECTIONS false`);
      });
      await terminateSessions(source.database);
      const reachable = await withClient(source.ownerUrl, () => Promise.resolve(true)).catch(() => false);
      if (reachable) {
        throw new Error('The source database still accepts connections after the simulated loss');
      }
    },

    async takeBackup() {
      const created = await createBackup({
        clock,
        connection: parsePgConnection(source.adminUrl),
        directory: backupDirectory,
        key: requireKey(),
        readSourceFacts: () => readSourceFacts(source.adminUrl),
        runner,
      });
      backupPath = created.path;
      backupCreatedAt = created.createdAt;
      return {
        artifactBytes: created.sizeBytes,
        createdAt: created.createdAt,
        durationMs: created.durationMs,
        plaintextBytes: created.plaintextBytes,
      };
    },

    async verifyBackupArtifact() {
      const { metadata } = await verifyBackupFile(backupPath, requireKey());
      if (metadata.source.database !== source.database || metadata.createdAt !== backupCreatedAt) {
        throw new Error('The backup header does not describe the drill source database');
      }
    },

    async verifyJournalCopy() {
      return { manifestDigest: (await manifestOf(recoveryJournalDirectory)).digest };
    },

    async verifyReadiness() {
      const checks: Check[] = [];
      const add = (id: string, description: string, passed: boolean): void => {
        checks.push({ description, id, passed });
      };
      const roles = await withClient(target.adminUrl, async (client) => {
        const result = await client.query<{
          rolbypassrls: boolean;
          rolcanlogin: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
          rolname: string;
          rolreplication: boolean;
          rolsuper: boolean;
        }>(
          `SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
           FROM pg_roles
           WHERE rolname IN ('running_tracker_owner', 'running_tracker_runtime', 'running_tracker_maintenance')
           ORDER BY rolname`,
        );
        const facts: RoleFacts[] = result.rows.map((row) => ({
          bypassRls: row.rolbypassrls,
          canCreateDatabase: row.rolcreatedb,
          canCreateRole: row.rolcreaterole,
          name: row.rolname,
          superuser: row.rolsuper,
        }));
        add('roles-present', 'The owner, runtime and maintenance roles exist and can log in', result.rowCount === 3 && result.rows.every((row) => row.rolcanlogin));
        add(
          'roles-unprivileged',
          'The three application roles are not superuser, have no BYPASSRLS, CREATEDB, CREATEROLE or REPLICATION',
          result.rows.every((row) => !row.rolsuper && !row.rolbypassrls && !row.rolcreatedb && !row.rolcreaterole && !row.rolreplication),
        );
        const privileges = await client.query<{ journal: boolean; reapply: boolean; connect: boolean }>(
          `SELECT bool_or(has_table_privilege(role, 'public.run_deletion_journal', 'SELECT')
                          OR has_table_privilege(role, 'public.run_deletion_journal', 'INSERT')
                          OR has_table_privilege(role, 'public.run_deletion_journal', 'DELETE')) AS journal,
                  bool_or(has_function_privilege(role,
                    'app_private.reapply_journaled_deletion(uuid, uuid, uuid, timestamptz, timestamptz)', 'EXECUTE')) AS reapply,
                  bool_or(has_database_privilege(role, current_database(), 'CONNECT')) AS connect
           FROM unnest(ARRAY['running_tracker_runtime', 'running_tracker_maintenance']) AS role`,
        );
        add('journal-denied-to-application', 'The runtime and maintenance roles have no access to the deletion journal table or the reapplication function', privileges.rows[0]!.journal === false && privileges.rows[0]!.reapply === false);
        add('application-cannot-connect', 'The runtime and maintenance roles cannot connect to the restored database: it stays closed until current permissions are restored (P12.4)', privileges.rows[0]!.connect === false);
        const sessions = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_stat_activity
           WHERE datname = current_database() AND usename IN ('running_tracker_runtime', 'running_tracker_maintenance')`,
        );
        add('no-application-sessions', 'No application login has a session on the restored database', sessions.rows[0]!.count === '0');
        return facts;
      });

      await withClient(target.ownerUrl, async (client) => {
        const postgis = await client.query<{ version: string | null }>('SELECT postgis_lib_version() AS version');
        add('postgis-available', 'PostGIS is installed and callable in the restored database', Boolean(postgis.rows[0]?.version));
        const applied = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM schema_migrations');
        const files = (await readdir(join(repositoryRoot, 'db', 'migrations'))).filter((name) => name.endsWith('.sql'));
        add('all-migrations-applied', 'Every migration file of this repository is recorded as applied', Number(applied.rows[0]!.count) === files.length);
      });

      add('journal-original-unchanged', 'The original journal directory is byte-identical to what the exporter wrote', (await manifestOf(journalDirectory)).digest === exportedDigest);
      add('journal-recovery-unchanged', 'The read-only recovery copy of the journal was not modified by reapplication', (await manifestOf(recoveryJournalDirectory)).digest === exportedDigest);

      const sourceReachable = await withClient(source.ownerUrl, () => Promise.resolve(true)).catch(() => false);
      add('source-stays-lost', 'The source database was not used after the simulated loss', !sourceReachable);
      return { checks, roles };
    },
  };

  return { databases, operations };
}

/** Drops every database whose name is a restore drill name on the configured local server. */
export async function dropLeftoverDrillDatabases(configuration: DrillConfiguration): Promise<string[]> {
  const databases = deriveDrillDatabases(configuration, 'cleanup');
  const dropped: string[] = [];
  await withClient(databases.adminMaintenanceUrl, async (client) => {
    const found = await client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname',
      [`${drillDatabasePrefix.replaceAll('_', '\\_')}%`],
    );
    for (const { datname } of found.rows) {
      assertDatabaseMayBeDropped(datname);
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(datname)} WITH (FORCE)`);
      dropped.push(datname);
    }
  });
  return dropped;
}

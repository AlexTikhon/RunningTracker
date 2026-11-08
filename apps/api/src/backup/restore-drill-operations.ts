import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { Client, Pool } from 'pg';

import { systemClock, type Clock } from '../clock.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { deleteActivity } from '../activities/activity-service.js';
import { deleteDailyMetrics } from '../daily-metrics/daily-metrics-service.js';
import { deleteDailyMovement } from '../daily-movement/daily-movement-service.js';
import { createFileDeletionJournalSink } from '../maintenance/deletion-journal-sink.js';
import { runAccessJournalExportOnce } from '../maintenance/run-access-journal-export.js';
import { runDeletionJournalExportOnce } from '../maintenance/run-deletion-journal-export.js';
import { runErasureLedgerExportOnce } from '../maintenance/run-erasure-ledger-export.js';
import { runRetentionDeleteOnce } from '../maintenance/run-retention-delete.js';
import { runReapplyAccessCli } from '../restore/reapply-access-cli.js';
import { loadAccessJournal, reapplyAccessOutcomes, type ReapplyAccessOutcome } from '../restore/reapply-access.js';
import { runReapplyCli } from '../restore/reapply-deletions-cli.js';
import { loadDeletionJournal, reapplyOutcomes, type ReapplyOutcome } from '../restore/reapply-deletions.js';
import { runClearSessionsCli } from '../restore/clear-sessions-cli.js';
import { runReapplyErasuresCli } from '../restore/reapply-erasures-cli.js';
import {
  loadErasureLedger,
  reapplyErasureOutcomes,
  type ReapplyErasureOutcome,
} from '../restore/reapply-erasures.js';
import { deleteRun, revokeRunShare, upsertRunShare } from '../runs/run-service.js';
import { createBackup, readSourceFacts } from './backup-create.js';
import { createBackupDecryptor, verifyBackupFile } from './backup-envelope.js';
import { loadBackupKey } from './backup-key.js';
import { createPgToolRunner, parsePgConnection, type PgToolRunner } from './pg-tools.js';
import {
  countedTables,
  userLabels,
  type AccessSnapshot,
  type ActivityState,
  type InsightLabel,
  type AccessState,
  type Check,
  type DatabaseState,
  type DrillDiagnostics,
  type DrillOperations,
  type JournalFacts,
  type MigrationRun,
  type ReapplyAccessRun,
  type ReapplyErasureRun,
  type ReapplyRun,
  type UserLabel,
  type RoleFacts,
  type RunLabel,
  type RunLabelState,
  type AuthenticationClearRun,
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
  granteeTwoUser: 'd1200000-0000-4000-8000-0000000000b3',
  leaverUser: 'd1200000-0000-4000-8000-0000000000b4',
  keeperUser: 'd1200000-0000-4000-8000-0000000000b5',
  runs: {
    A: 'd1200000-0000-4000-8000-0000000000c1',
    B: 'd1200000-0000-4000-8000-0000000000c2',
    C: 'd1200000-0000-4000-8000-0000000000c3',
    D: 'd1200000-0000-4000-8000-0000000000c4',
  } satisfies Record<RunLabel, string>,
  // ADR-0073: E is deleted by its owner after the backup, F survives.
  activities: {
    E: 'd1200000-0000-4000-8000-0000000000e1',
    F: 'd1200000-0000-4000-8000-0000000000e2',
  },
  // ADR-0074: check-in day G is deleted by its owner after the backup, H survives. Days are keyed by date; the dates
  // are fixed (any past date works) so the scenario does not depend on the clock's zone. ADR-0076: they are in 2020,
  // far from every fixture run (which are dated relative to the clock), so that no run deletion replayed before the
  // erasures can touch the weekly insight of their week.
  dailyMetrics: {
    G: '2020-01-18',
    H: '2020-01-19',
  },
  // ADR-0078: movement day M is deleted by its owner after the backup, N survives. The same fixed dates as G and H:
  // another table, and movement is not an insight source, so no insight of the scenario depends on them.
  dailyMovement: {
    M: '2020-01-18',
    N: '2020-01-19',
  },
  // ADR-0076: activity E and F start on a fixed date too, in the week before G and H, for the same reason.
  activityStartedAt: '2020-01-08T09:00:00.000Z',
  // ADR-0076: the Mondays of the weekly insights (Europe/Warsaw): E's week, G's week, and a week without erased records.
  insightWeeks: {
    activityWeek: '2020-01-06',
    checkInWeek: '2020-01-13',
    survivorWeek: '2019-12-30',
  } satisfies Record<InsightLabel, string>,
};

const labels = ['A', 'B', 'C', 'D'] as const;

const userIds: Record<UserLabel, string> = {
  grantee: ids.granteeUser,
  granteeTwo: ids.granteeTwoUser,
  keeper: ids.keeperUser,
  leaver: ids.leaverUser,
  owner: ids.ownerUser,
};
const dayMs = 24 * 60 * 60 * 1000;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Bounds of every connection the drill opens (ADR-0076, drill reliability). No drill statement may wait forever on a
 * lock or a server: connecting, a lock wait, a statement and an idle transaction are all limited, and the client gives
 * up on a query the server never answers. DROP DATABASE ... WITH (FORCE) obeys the lock bound too.
 */
export const DRILL_CONNECTION_LIMITS = {
  connectionTimeoutMillis: 10_000,
  idle_in_transaction_session_timeout: 120_000,
  lock_timeout: 30_000,
  query_timeout: 150_000,
  statement_timeout: 120_000,
} as const;
/** A drill script (bootstrap, migrations) that runs longer than this is killed. */
export const DRILL_SCRIPT_TIMEOUT_MS = 180_000;
/** Closing the drill's pools may take this long before it is reported as a failure. */
export const DRILL_POOL_CLOSE_TIMEOUT_MS = 10_000;

type AuthenticationTable = 'app_private.auth_sessions' | 'app_private.oidc_pending_logins';

async function hasTable(client: Client, table: AuthenticationTable): Promise<boolean> {
  const result = await client.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [table]);
  return result.rows[0]?.present === true;
}

async function hasSessionTable(client: Client): Promise<boolean> {
  return hasTable(client, 'app_private.auth_sessions');
}

/** Rows of one authentication table, or null when the schema predates it (migration 0036 or 0037). */
async function countRows(client: Client, table: AuthenticationTable): Promise<number | null> {
  if (!(await hasTable(client, table))) return null;
  const result = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number(result.rows[0]!.count);
}

/** Stored sessions, or null when the schema predates the session table (migration 0036). */
async function countSessions(client: Client): Promise<number | null> {
  return countRows(client, 'app_private.auth_sessions');
}

/** Pending OIDC logins, or null when the schema predates their table (migration 0037). */
async function countPendingLogins(client: Client): Promise<number | null> {
  return countRows(client, 'app_private.oidc_pending_logins');
}

async function withClient<T>(url: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ application_name: 'running-tracker-restore-drill', connectionString: url, ...DRILL_CONNECTION_LIMITS });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await Promise.race([client.end(), new Promise((resolveEnd) => setTimeout(resolveEnd, 5_000).unref())]);
  }
}

/** Ends a pool within a deadline, or fails naming what was still checked out. */
async function endPool(pool: Pool, name: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'expired'>((resolveExpired) => {
    timer = setTimeout(() => resolveExpired('expired'), DRILL_POOL_CLOSE_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([pool.end().then(() => 'ended' as const), expired]);
    if (outcome === 'expired') {
      throw new Error(
        `The drill's ${name} pool did not close within ${DRILL_POOL_CLOSE_TIMEOUT_MS} ms (${pool.totalCount} clients, ${pool.idleCount} idle, ${pool.waitingCount} waiting)`,
      );
    }
  } finally {
    clearTimeout(timer);
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
  let sourceRuntimePool: Pool | undefined;
  let sourceSessionRowsAtBackup: number | null = null;
  let sourcePendingLoginRowsAtBackup: number | null = null;

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
        env: { ...env, MIGRATION_CONNECT_TIMEOUT_MS: '10000', MIGRATION_LOCK_TIMEOUT_MS: '30000' },
        killSignal: 'SIGKILL',
        maxBuffer: 10 * 1024 * 1024,
        timeout: DRILL_SCRIPT_TIMEOUT_MS,
      });
      return stdout;
    } catch (error) {
      const failure = error as { killed?: boolean; signal?: string | null; stderr?: string; stdout?: string };
      const detail = scrubSecrets(`${failure.stderr ?? ''}${failure.stdout ?? ''}`, secrets).trim();
      if (failure.killed && failure.signal) {
        throw new Error(`scripts/${script} did not finish within ${DRILL_SCRIPT_TIMEOUT_MS} ms and was killed${detail ? `: ${detail}` : ''}`, {
          cause: error,
        });
      }
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
    await Promise.all(pools.map((pool, index) => endPool(pool, `source pool ${index + 1}`)));
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

    async clearSessions() {
      const restoredRows = await withClient(target.ownerUrl, countSessions);
      const restoredLogins = await withClient(target.ownerUrl, countPendingLogins);
      if (restoredRows === null || restoredLogins === null) {
        throw new Error('The restored and migrated database has no session or pending-login table');
      }
      onCommand(`restore:clear-sessions  (RESTORE_DATABASE_URL = owner of ${target.database})`);
      const lines: string[] = [];
      await runClearSessionsCli({ argv: [], env: { RESTORE_DATABASE_URL: target.ownerUrl }, log: (line) => lines.push(line) });
      const value = (name: string): number => {
        const line = lines.find((entry) => entry.startsWith(`${name}: `));
        if (!line) throw new Error('The authentication clearing report is incomplete');
        return Number(line.slice(name.length + 2));
      };
      // Counted again independently of what the command reported.
      const remaining = await withClient(target.ownerUrl, countSessions);
      const remainingLogins = await withClient(target.ownerUrl, countPendingLogins);
      return {
        pendingLogins: {
          cleared: value('pending logins cleared'),
          remaining: remainingLogins ?? 0,
          restoredRows: restoredLogins,
          sourceRowsAtBackup: sourcePendingLoginRowsAtBackup,
        },
        sessions: {
          cleared: value('sessions cleared'),
          remaining: remaining ?? 0,
          restoredRows,
          sourceRowsAtBackup: sourceSessionRowsAtBackup,
        },
      } satisfies AuthenticationClearRun;
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

    async diagnose() {
      // What every session on a drill database is doing and waiting for, and the locks that are not granted. No query
      // text (it can carry values), no addresses: names, states, wait events, ages and lock modes only.
      return withClient(databases.adminMaintenanceUrl, async (client) => {
        const sessions = await client.query<DrillDiagnostics['sessions'][number]>(
          `SELECT activity.datname AS database,
                  coalesce(activity.application_name, '') AS application,
                  coalesce(activity.usename, '') AS role,
                  coalesce(activity.state, '') AS state,
                  activity.wait_event_type AS "waitEventType",
                  activity.wait_event AS "waitEvent",
                  activity.backend_type AS "backendType",
                  round(extract(epoch FROM clock_timestamp() - activity.xact_start))::int AS "transactionAgeSeconds",
                  round(extract(epoch FROM clock_timestamp() - activity.state_change))::int AS "stateAgeSeconds",
                  cardinality(pg_blocking_pids(activity.pid)) AS "blockedBy"
           FROM pg_stat_activity AS activity
           WHERE activity.datname LIKE $1 AND activity.pid <> pg_backend_pid()
           ORDER BY activity.datname, activity.backend_start`,
          [`${drillDatabasePrefix}%`],
        );
        const locks = await client.query<DrillDiagnostics['ungrantedLocks'][number]>(
          `SELECT lock.locktype AS "lockType", lock.mode, count(*)::int AS count
           FROM pg_locks AS lock
           JOIN pg_database AS db ON db.oid = lock.database
           WHERE NOT lock.granted AND db.datname LIKE $1
           GROUP BY lock.locktype, lock.mode
           ORDER BY lock.locktype, lock.mode`,
          [`${drillDatabasePrefix}%`],
        );
        return { sessions: sessions.rows, ungrantedLocks: locks.rows } satisfies DrillDiagnostics;
      });
    },

    async inspectActivities() {
      return withClient(target.ownerUrl, async (client) => {
        const row = await client.query<{
          day_digest: string | null;
          digest: string | null;
          e: boolean;
          f: boolean;
          g: boolean;
          h: boolean;
          insight_activity: boolean;
          insight_check_in: boolean;
          insight_digest: string | null;
          insight_survivor: boolean;
          m: boolean;
          movement_digest: string | null;
          n: boolean;
          outbox: string;
        }>(
          `SELECT EXISTS (SELECT 1 FROM activities WHERE org_id = $1 AND id = $2) AS e,
                  EXISTS (SELECT 1 FROM activities WHERE org_id = $1 AND id = $3) AS f,
                  (SELECT md5(activity::text) FROM activities AS activity WHERE org_id = $1 AND id = $3) AS digest,
                  EXISTS (SELECT 1 FROM daily_metrics WHERE org_id = $1 AND user_id = $4 AND local_date = $5::date) AS g,
                  EXISTS (SELECT 1 FROM daily_metrics WHERE org_id = $1 AND user_id = $4 AND local_date = $6::date) AS h,
                  (SELECT md5(metric::text) FROM daily_metrics AS metric
                   WHERE org_id = $1 AND user_id = $4 AND local_date = $6::date) AS day_digest,
                  (SELECT count(*) FROM erasure_ledger)::text AS outbox,
                  EXISTS (SELECT 1 FROM weekly_insights WHERE org_id = $1 AND user_id = $4 AND week_start = $7::date) AS insight_activity,
                  EXISTS (SELECT 1 FROM weekly_insights WHERE org_id = $1 AND user_id = $4 AND week_start = $8::date) AS insight_check_in,
                  EXISTS (SELECT 1 FROM weekly_insights WHERE org_id = $1 AND user_id = $10 AND week_start = $9::date) AS insight_survivor,
                  (SELECT md5(insight::text) FROM weekly_insights AS insight
                   WHERE org_id = $1 AND user_id = $10 AND week_start = $9::date) AS insight_digest,
                  EXISTS (SELECT 1 FROM daily_movement WHERE org_id = $1 AND user_id = $4 AND local_date = $11::date) AS m,
                  EXISTS (SELECT 1 FROM daily_movement WHERE org_id = $1 AND user_id = $4 AND local_date = $12::date) AS n,
                  (SELECT md5(movement::text) FROM daily_movement AS movement
                   WHERE org_id = $1 AND user_id = $4 AND local_date = $12::date) AS movement_digest`,
          [
            ids.org,
            ids.activities.E,
            ids.activities.F,
            ids.ownerUser,
            ids.dailyMetrics.G,
            ids.dailyMetrics.H,
            ids.insightWeeks.activityWeek,
            ids.insightWeeks.checkInWeek,
            ids.insightWeeks.survivorWeek,
            ids.keeperUser,
            ids.dailyMovement.M,
            ids.dailyMovement.N,
          ],
        );
        const value = row.rows[0]!;
        return {
          outboxRows: Number(value.outbox),
          present: { E: value.e, F: value.f },
          presentDays: { G: value.g, H: value.h },
          presentInsights: {
            activityWeek: value.insight_activity,
            checkInWeek: value.insight_check_in,
            survivorWeek: value.insight_survivor,
          },
          presentMovementDays: { M: value.m, N: value.n },
          survivorDayDigest: value.day_digest ?? 'missing',
          survivorInsightDigest: value.insight_digest ?? 'missing',
          survivorMovementDigest: value.movement_digest ?? 'missing',
          survivorDigest: value.digest ?? 'missing',
        } satisfies ActivityState;
      });
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
      const accessJournal = await loadAccessJournal(recoveryJournalDirectory);
      const erasureLedger = await loadErasureLedger(recoveryJournalDirectory);
      const manifest = await manifestOf(recoveryJournalDirectory);
      return {
        accessEntries: accessJournal.entries.length,
        entries: journal.entries.length,
        erasureEntries: erasureLedger.entries.length,
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
      const poolLimits = { ...DRILL_CONNECTION_LIMITS, idleTimeoutMillis: 1_000, max: 2 };
      const runtimePool = new Pool({ application_name: 'running-tracker-restore-drill-runtime', connectionString: source.runtimeUrl, ...poolLimits });
      const maintenancePool = new Pool({ application_name: 'running-tracker-restore-drill-maintenance', connectionString: source.maintenanceUrl, ...poolLimits });
      for (const pool of [runtimePool, maintenancePool]) pool.on('error', () => undefined);
      sourcePools.push(runtimePool, maintenancePool);
      sourceMaintenancePool = maintenancePool;
      sourceRuntimePool = runtimePool;
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
      // ADR-0073: the owner deletes activity E through the application's own service, as the runtime role.
      await withAuthenticatedTenantTransaction(runtimePool, session, ids.org, (client) =>
        deleteActivity(client, session, ids.org, ids.activities.E),
      );
      // ADR-0074: and deletes check-in day G the same way.
      await withAuthenticatedTenantTransaction(runtimePool, session, ids.org, (client) =>
        deleteDailyMetrics(client, session, ids.org, ids.dailyMetrics.G),
      );
      // ADR-0078: and deletes movement day M the same way.
      await withAuthenticatedTenantTransaction(runtimePool, session, ids.org, (client) =>
        deleteDailyMovement(client, session, ids.org, ids.dailyMovement.M),
      );

      const journal = await withClient(source.ownerUrl, (client) =>
        client.query<{ deleted_at: Date }>(
          `SELECT deleted_at FROM (
             SELECT deleted_at, 1 AS source, journal_seq AS seq FROM run_deletion_journal
             UNION ALL
             SELECT erased_at, 2, ledger_seq FROM erasure_ledger
           ) AS deletion ORDER BY source, seq`,
        ),
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
      let accessBatches = 0;
      for (;;) {
        const result = await runAccessJournalExportOnce(maintenancePool, sink, clock);
        if (result.status === 'idle') break;
        accessBatches += 1;
      }
      if (accessBatches === 0) {
        throw new Error('The access journal exporter exported nothing');
      }
      let erasureBatches = 0;
      for (;;) {
        const result = await runErasureLedgerExportOnce(maintenancePool, sink, clock);
        if (result.status === 'idle') break;
        erasureBatches += 1;
      }
      if (erasureBatches === 0) {
        throw new Error('The erasure ledger exporter exported nothing');
      }
      const pending = await withClient(source.ownerUrl, (client) =>
        client.query<{ access: string; deletion: string; erasure: string }>(
          `SELECT (SELECT count(*) FROM run_deletion_journal)::text AS deletion,
                  (SELECT count(*) FROM access_restriction_journal)::text AS access,
                  (SELECT count(*) FROM erasure_ledger)::text AS erasure`,
        ),
      );
      if (pending.rows[0]!.erasure !== '0') {
        throw new Error('The erasure ledger outbox still holds rows after export');
      }
      if (pending.rows[0]!.deletion !== '0') {
        throw new Error('The deletion journal outbox still holds rows after export');
      }
      if (pending.rows[0]!.access !== '0') {
        throw new Error('The access journal outbox still holds rows after export');
      }
      const journal = await loadDeletionJournal(journalDirectory);
      const accessJournal = await loadAccessJournal(journalDirectory);
      const erasureLedger = await loadErasureLedger(journalDirectory);
      const manifest = await manifestOf(journalDirectory);
      exportedDigest = manifest.digest;
      return {
        accessEntries: accessJournal.entries.length,
        entries: journal.entries.length,
        erasureEntries: erasureLedger.entries.length,
        files: manifest.files,
        manifestDigest: manifest.digest,
      } satisfies JournalFacts;
    },

    async inspectAccess(sideName) {
      const side = sideName === 'source' ? source : target;
      const rows = await withClient(side.ownerUrl, async (client) => {
        const memberships = await client.query<{ active: boolean; user_id: string }>(
          'SELECT user_id, active FROM memberships WHERE org_id = $1',
          [ids.org],
        );
        const shares = await client.query<{ can_read_history: boolean; can_read_live: boolean; grantee_user_id: string }>(
          'SELECT grantee_user_id, can_read_history, can_read_live FROM run_shares WHERE org_id = $1 AND run_id = $2',
          [ids.org, ids.runs.C],
        );
        const outbox = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM access_restriction_journal');
        return { memberships: memberships.rows, outbox: Number(outbox.rows[0]!.count), shares: shares.rows };
      });
      // Who can really read run C: the application's runtime role under row-level security, as each
      // person. SET ROLE needs no CONNECT privilege, so this also works on the closed restored database.
      const readsSurvivor = {} as Record<UserLabel, boolean>;
      await withClient(side.adminUrl, async (client) => {
        for (const label of userLabels) {
          await client.query('BEGIN');
          try {
            await client.query('SET LOCAL ROLE running_tracker_runtime');
            await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)", [
              userIds[label],
              ids.org,
            ]);
            const visible = await client.query<{ visible: boolean }>(
              'SELECT EXISTS (SELECT 1 FROM runs WHERE org_id = $1 AND id = $2) AS visible',
              [ids.org, ids.runs.C],
            );
            readsSurvivor[label] = visible.rows[0]!.visible;
          } finally {
            await client.query('ROLLBACK');
          }
        }
      });
      const memberships = {} as AccessState['memberships'];
      const shares = {} as AccessState['shares'];
      for (const label of userLabels) {
        const membership = rows.memberships.find((row) => row.user_id === userIds[label]);
        memberships[label] = membership ? membership.active : null;
        const share = rows.shares.find((row) => row.grantee_user_id === userIds[label]);
        shares[label] = share ? { history: share.can_read_history, live: share.can_read_live } : null;
      }
      return { outboxRows: rows.outbox, state: { memberships, readsSurvivor, shares } } satisfies AccessSnapshot;
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

    async reapplyErasures() {
      onCommand(`restore:reapply-erasures --journal-dir <recovery copy>  (RESTORE_DATABASE_URL = owner of ${target.database})`);
      const lines: string[] = [];
      await runReapplyErasuresCli({
        argv: ['--journal-dir', recoveryJournalDirectory],
        env: { RESTORE_DATABASE_URL: target.ownerUrl },
        log: (line) => lines.push(line),
      });
      const value = (name: string): number => {
        const line = lines.find((entry) => entry.startsWith(`${name}: `));
        if (!line) throw new Error('The erasure replay report is incomplete');
        return Number(line.slice(name.length + 2));
      };
      const outcomes = Object.fromEntries(reapplyErasureOutcomes.map((name) => [name, value(name)])) as Record<
        ReapplyErasureOutcome,
        number
      >;
      return { entries: value('ledger entries'), files: value('ledger files'), outcomes } satisfies ReapplyErasureRun;
    },

    async reapplyAccess() {
      onCommand(`restore:reapply-access --journal-dir <recovery copy>  (RESTORE_DATABASE_URL = owner of ${target.database})`);
      const lines: string[] = [];
      await runReapplyAccessCli({
        argv: ['--journal-dir', recoveryJournalDirectory],
        env: { RESTORE_DATABASE_URL: target.ownerUrl },
        log: (line) => lines.push(line),
      });
      const value = (name: string): number => {
        const line = lines.find((entry) => entry.startsWith(`${name}: `));
        if (!line) throw new Error('The access reapplication report is incomplete');
        return Number(line.slice(name.length + 2));
      };
      const outcomes = Object.fromEntries(reapplyAccessOutcomes.map((name) => [name, value(name)])) as Record<
        ReapplyAccessOutcome,
        number
      >;
      return { entries: value('journal entries'), files: value('journal files'), outcomes } satisfies ReapplyAccessRun;
    },

    async restoreBackup() {
      // GCM authenticates only at the end of the stream, after pg_restore could already have committed.
      // Authenticate the whole file first so that no byte of an unverified dump ever reaches pg_restore.
      await verifyBackupFile(backupPath, requireKey());
      const { stream } = await createBackupDecryptor(backupPath, requireKey());
      await runner.restore(parsePgConnection(target.adminUrl), stream);
    },

    async restrictAccessAfterBackup() {
      const runtimePool = sourceRuntimePool;
      if (!runtimePool) throw new Error('The runtime connection of the source is not open');
      const session = { userId: ids.ownerUser };
      // The share API's own paths, as the run's owner under the runtime role.
      await withAuthenticatedTenantTransaction(runtimePool, session, ids.org, (client) =>
        revokeRunShare(client, session, ids.org, ids.runs.C, ids.granteeUser),
      );
      await withAuthenticatedTenantTransaction(runtimePool, session, ids.org, (client) =>
        upsertRunShare(client, session, ids.org, ids.runs.C, ids.granteeTwoUser, {
          canReadHistory: false,
          canReadLive: true,
        }),
      );
      // Memberships have no application path yet (the identity provider is P12.1): an administrator's SQL.
      await withClient(source.ownerUrl, (client) =>
        client.query('UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2', [
          ids.org,
          ids.leaverUser,
        ]),
      );
    },

    async seedScenario() {
      await withClient(source.ownerUrl, async (client) => {
        await client.query(
          `INSERT INTO users (id, external_identity)
           VALUES ($1, 'drill-owner'), ($2, 'drill-grantee'), ($3, 'drill-grantee-two'), ($4, 'drill-leaver'), ($5, 'drill-keeper')`,
          [ids.ownerUser, ids.granteeUser, ids.granteeTwoUser, ids.leaverUser, ids.keeperUser],
        );
        await client.query('INSERT INTO organizations (id) VALUES ($1)', [ids.org]);
        await client.query(
          `INSERT INTO memberships (org_id, user_id, role, active)
           VALUES ($1, $2, 'runner', true), ($1, $3, 'coach', true),
                  ($1, $4, 'runner', true), ($1, $5, 'runner', true), ($1, $6, 'runner', true)`,
          [ids.org, ids.ownerUser, ids.granteeUser, ids.granteeTwoUser, ids.leaverUser, ids.keeperUser],
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
        // ADR-0073: two of the owner's manual activities, both in the backup.
        await client.query(
          `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, distance_m, rpe, notes, created_at)
           VALUES ($1, $2, $4, 'swim', $5, 1800, 1500, 4, 'drill fixture', $6),
                  ($1, $3, $4, 'strength', $5, 2700, NULL, 7, NULL, $6)`,
          [ids.org, ids.activities.E, ids.activities.F, ids.ownerUser, ids.activityStartedAt, new Date(now - 3 * dayMs + 60_000)],
        );
        // ADR-0074: two of the owner's check-in days, both in the backup; ids and timestamps are database defaults.
        await client.query(
          `INSERT INTO daily_metrics (org_id, user_id, local_date, time_zone, weight_kg, sleep_minutes, mood, note)
           VALUES ($1, $2, $3, 'Europe/Warsaw', 71.80, 455, 4, 'drill fixture'),
                  ($1, $2, $4, 'Europe/Warsaw', NULL, 400, 3, NULL)`,
          [ids.org, ids.ownerUser, ids.dailyMetrics.G, ids.dailyMetrics.H],
        );
        // ADR-0078: two of the owner's manual movement days, both in the backup (a zero is a recorded value). N survives
        // with a one-decimal energy: its row digest, taken before the backup and after recovery, proves that the
        // restored value (and its scale) is unchanged by migrations the backup is behind (0035 widened the column type).
        await client.query(
          `INSERT INTO daily_movement (org_id, user_id, local_date, time_zone, steps, active_energy_kcal)
           VALUES ($1, $2, $3, 'Europe/Warsaw', 9120, 388.5),
                  ($1, $2, $4, 'Europe/Warsaw', 0, 120.5)`,
          [ids.org, ids.ownerUser, ids.dailyMovement.M, ids.dailyMovement.N],
        );
        // ADR-0076: weekly insights in the backup, ready ones so that a resurrected insight would carry text: the
        // owner's for the weeks of E and G, and the keeper's for a week without erased records (a replay invalidates
        // the owner's insights conservatively, migration 0032, but never another person's). Both source schemas (one
        // migration behind, and current) are after 0032, so an insert carries the current source revision.
        const insightRows = [
          { userId: ids.ownerUser, week: ids.insightWeeks.activityWeek },
          { userId: ids.ownerUser, week: ids.insightWeeks.checkInWeek },
          { userId: ids.keeperUser, week: ids.insightWeeks.survivorWeek },
        ];
        for (const row of insightRows) {
          await client.query(
            `INSERT INTO weekly_insights (org_id, user_id, week_start, time_zone, range_start, range_end, input_hash,
                                         source_revision, model, prompt_version, policy_version, status, output)
              SELECT $1, $2, $3::date, 'Europe/Warsaw', $3::date::timestamp AT TIME ZONE 'Europe/Warsaw',
                     ($3::date + 7)::timestamp AT TIME ZONE 'Europe/Warsaw', repeat('d', 64),
                     coalesce((SELECT revision FROM weekly_insight_source_gates WHERE org_id = $1 AND user_id = $2), 0),
                     'fake', 'weekly-insight-v2', 'weekly-insight-policy-2', 'ready',
                     jsonb_build_object('summary', 'Drill fixture.', 'observations', jsonb_build_array(),
                       'suggestion', jsonb_build_object('id', 'rest_and_recovery', 'source', 'approved', 'text', 'Rest.'),
                       'dataGaps', jsonb_build_array())`,
            [ids.org, row.userId, row.week],
          );
        }
        // Run C also carries the shares of the access scenario (the grantee's was seeded with the run).
        await client.query(
          `INSERT INTO run_shares (org_id, run_id, grantee_user_id, can_read_live, can_read_history)
           VALUES ($1, $2, $3, true, true), ($1, $2, $4, false, true), ($1, $2, $5, false, true)`,
          [ids.org, ids.runs.C, ids.granteeTwoUser, ids.leaverUser, ids.keeperUser],
        );
        // ADR-0080: on a schema that has the session table, the owner is signed in when the backup is taken. An older
        // schema has no such table, and none is added for the drill.
        if (await hasSessionTable(client)) {
          await client.query(
            `INSERT INTO app_private.auth_sessions (token_digest, user_id, csrf_token, issued_at, expires_at)
             VALUES ($1, $2, $3, now(), now() + interval '8 hours')`,
            [createHash('sha256').update('drill-session', 'utf8').digest('base64url'), ids.ownerUser,
              createHash('sha256').update('drill-csrf', 'utf8').digest('base64url')],
          );
        }
        // ADR-0081: likewise, a sign-in is pending (sent to the provider, not back yet) when the backup is taken.
        if (await hasTable(client, 'app_private.oidc_pending_logins')) {
          const drillValue = (label: string) => createHash('sha256').update(label, 'utf8').digest('base64url');
          await client.query(
            `INSERT INTO app_private.oidc_pending_logins (login_digest, created_at, expires_at, code_verifier, oidc_state, oidc_nonce)
             VALUES ($1, now(), now() + interval '10 minutes', $2, $3, $4)`,
            [drillValue('drill-login'), drillValue('drill-verifier'), drillValue('drill-state'), drillValue('drill-nonce')],
          );
        }
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
      sourceSessionRowsAtBackup = await withClient(source.ownerUrl, countSessions);
      sourcePendingLoginRowsAtBackup = await withClient(source.ownerUrl, countPendingLogins);
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

    async upgradeSourceSchema() {
      const output = await runScript('migrate.mjs', source);
      const lines = output.split(/\r?\n/u);
      return {
        applied: lines.filter((line) => line.startsWith('apply ')).length,
        skipped: lines.filter((line) => line.startsWith('skip ')).length,
      } satisfies MigrationRun;
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
        const privileges = await client.query<{
          access_journal: boolean;
          access_reapply: boolean;
          connect: boolean;
          journal: boolean;
          reapply: boolean;
        }>(
          `SELECT bool_or(has_table_privilege(role, 'public.run_deletion_journal', 'SELECT')
                          OR has_table_privilege(role, 'public.run_deletion_journal', 'INSERT')
                          OR has_table_privilege(role, 'public.run_deletion_journal', 'DELETE')) AS journal,
                  bool_or(has_table_privilege(role, 'public.access_restriction_journal', 'SELECT')
                          OR has_table_privilege(role, 'public.access_restriction_journal', 'INSERT')
                          OR has_table_privilege(role, 'public.access_restriction_journal', 'DELETE')) AS access_journal,
                  bool_or(has_function_privilege(role,
                    'app_private.reapply_access_restriction(text, uuid, uuid, uuid, boolean, boolean)', 'EXECUTE')) AS access_reapply,
                  bool_or(has_function_privilege(role,
                    'app_private.reapply_journaled_deletion(uuid, uuid, uuid, timestamptz, timestamptz)', 'EXECUTE')) AS reapply,
                  bool_or(has_database_privilege(role, current_database(), 'CONNECT')) AS connect
           FROM unnest(ARRAY['running_tracker_runtime', 'running_tracker_maintenance']) AS role`,
        );
        add('journal-denied-to-application', 'The runtime and maintenance roles have no access to the deletion journal table or the reapplication function', privileges.rows[0]!.journal === false && privileges.rows[0]!.reapply === false);
        add('access-journal-denied-to-application', 'The runtime and maintenance roles have no access to the access-restriction journal table or its reapplication function', privileges.rows[0]!.access_journal === false && privileges.rows[0]!.access_reapply === false);
        const erasure = await client.query<{ ledger: boolean; replay: boolean }>(
          `SELECT bool_or(has_table_privilege(role, 'public.erasure_ledger', 'SELECT')
                          OR has_table_privilege(role, 'public.erasure_ledger', 'INSERT')
                          OR has_table_privilege(role, 'public.erasure_ledger', 'DELETE')) AS ledger,
                  bool_or(has_function_privilege(role,
                    'app_private.reapply_erasure(text, uuid, uuid, uuid, timestamptz)', 'EXECUTE')) AS replay
           FROM unnest(ARRAY['running_tracker_runtime', 'running_tracker_maintenance']) AS role`,
        );
        add('erasure-ledger-denied-to-application', 'The runtime and maintenance roles have no access to the erasure ledger table or its replay function', erasure.rows[0]!.ledger === false && erasure.rows[0]!.replay === false);
        const sessionStore = await client.query<{ clear: boolean; table: boolean }>(
          `SELECT bool_or(has_table_privilege(role, 'app_private.auth_sessions', 'SELECT')
                          OR has_table_privilege(role, 'app_private.auth_sessions', 'INSERT')
                          OR has_table_privilege(role, 'app_private.auth_sessions', 'UPDATE')
                          OR has_table_privilege(role, 'app_private.auth_sessions', 'DELETE')) AS table,
                  bool_or(has_function_privilege(role, 'app_private.clear_auth_sessions()', 'EXECUTE')) AS clear
           FROM unnest(ARRAY['running_tracker_runtime', 'running_tracker_maintenance']) AS role`,
        );
        add('session-store-denied-to-application', 'The runtime and maintenance roles cannot read, list or change the session table directly, nor clear it (ADR-0080)', sessionStore.rows[0]!.table === false && sessionStore.rows[0]!.clear === false);
        const loginStore = await client.query<{ clear: boolean; table: boolean }>(
          `SELECT bool_or(has_table_privilege(role, 'app_private.oidc_pending_logins', 'SELECT')
                          OR has_table_privilege(role, 'app_private.oidc_pending_logins', 'INSERT')
                          OR has_table_privilege(role, 'app_private.oidc_pending_logins', 'UPDATE')
                          OR has_table_privilege(role, 'app_private.oidc_pending_logins', 'DELETE')) AS table,
                  bool_or(has_function_privilege(role, 'app_private.clear_oidc_pending_logins()', 'EXECUTE')) AS clear
           FROM unnest(ARRAY['running_tracker_runtime', 'running_tracker_maintenance']) AS role`,
        );
        add('pending-login-store-denied-to-application', 'The runtime and maintenance roles cannot read, list or change the pending-login table directly, nor clear it (ADR-0081)', loginStore.rows[0]!.table === false && loginStore.rows[0]!.clear === false);
        add('application-cannot-connect', 'The runtime and maintenance roles cannot connect to the restored database: the drill leaves it closed, and opening it is an explicit operator step', privileges.rows[0]!.connect === false);
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

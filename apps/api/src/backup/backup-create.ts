import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Client } from 'pg';

import type { Clock } from '../clock.js';
import { verifyBackupFile, type BackupMetadataInput } from './backup-envelope.js';
import { writeBackupArtifact } from './backup-store.js';
import { formatPgConnection, type PgConnection, type PgToolRunner } from './pg-tools.js';

export interface SourceFacts {
  lastMigration: string | null;
  migrationCount: number;
  postgisVersion: string | null;
  serverVersion: string;
}

/** Technical facts that identify what was backed up. Reads no run, point, user, or session data. */
export async function readSourceFacts(connectionString: string): Promise<SourceFacts> {
  const client = new Client({ application_name: 'running-tracker-backup-facts', connectionString });
  await client.connect();
  try {
    const version = await client.query<{ server_version: string }>('SHOW server_version');
    const postgis = await client.query<{ postgis_version: string | null }>(
      `SELECT CASE WHEN to_regproc('postgis_lib_version') IS NULL THEN NULL
                   ELSE postgis_lib_version() END AS postgis_version`,
    );
    const migrations = await client.query<{ count: string; last: string | null }>(
      `SELECT CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN 0
                   ELSE (SELECT count(*) FROM public.schema_migrations) END AS count,
              CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN NULL
                   ELSE (SELECT max(id) FROM public.schema_migrations) END AS last`,
    );
    return {
      lastMigration: migrations.rows[0]?.last ?? null,
      migrationCount: Number(migrations.rows[0]?.count ?? 0),
      postgisVersion: postgis.rows[0]?.postgis_version ?? null,
      serverVersion: version.rows[0]?.server_version ?? 'unknown',
    };
  } finally {
    await client.end();
  }
}

export interface CreateBackupOptions {
  clock: Pick<Clock, 'utcNow'>;
  /** A role that can read every row regardless of row-level security: the administrator. */
  connection: PgConnection;
  directory: string;
  key: Buffer;
  /** Defaults to a catalog query on the same connection. */
  readSourceFacts?: (connection: PgConnection) => Promise<SourceFacts>;
  runner: PgToolRunner;
}

export interface CreatedBackup {
  createdAt: string;
  durationMs: number;
  fileName: string;
  path: string;
  plaintextBytes: number;
  sizeBytes: number;
}

function scrub(error: unknown, secrets: readonly string[]): Error {
  const message = error instanceof Error ? error.message : 'The backup failed';
  let safe = message;
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join('[redacted]');
  }
  return new Error(safe);
}

/**
 * pg_dump (custom format) -> AES-256-GCM -> unique file, published atomically, then read back and
 * authenticated once. A failure at any point leaves no file under a backup name.
 */
export async function createBackup(options: CreateBackupOptions): Promise<CreatedBackup> {
  const { connection, directory, key, runner } = options;
  const createdAt = options.clock.utcNow();
  if (!Number.isFinite(createdAt.getTime())) {
    throw new Error('The clock returned an invalid UTC time');
  }
  const secrets = [connection.password, key.toString('hex'), key.toString('base64')];
  const started = performance.now();
  try {
    const facts = await (options.readSourceFacts ?? ((value) => readSourceFacts(formatPgConnection(value))))(connection);
    const metadata: BackupMetadataInput = {
      application: { lastMigration: facts.lastMigration, migrationCount: facts.migrationCount },
      createdAt: createdAt.toISOString(),
      dump: { format: 'pg_dump-custom', tool: await runner.version('pg_dump') },
      postgres: { postgisVersion: facts.postgisVersion, serverVersion: facts.serverVersion },
      source: { database: connection.database },
    };
    const written = await writeBackupArtifact({
      createdAt,
      directory,
      key,
      metadata,
      source: runner.dump(connection),
    });
    try {
      await verifyBackupFile(written.path, key);
    } catch (error) {
      await rm(written.path, { force: true });
      throw error;
    }
    return {
      createdAt: metadata.createdAt,
      durationMs: Math.round(performance.now() - started),
      fileName: written.fileName,
      path: written.path,
      plaintextBytes: written.plaintextBytes,
      sizeBytes: written.size,
    };
  } catch (error) {
    throw scrub(error, secrets);
  }
}

export interface BackupMetricsInput {
  createdAt: Date;
  durationMs: number;
  sizeBytes: number;
}

/**
 * Prometheus text for the node_exporter textfile collector. The backup job writes it after a
 * successful backup; the API never reads backups or this file, and the scrape endpoint stays cheap.
 * Backup age is `time() - running_tracker_backup_last_success_timestamp_seconds`.
 */
export function renderBackupMetrics(input: BackupMetricsInput): string {
  return [
    '# HELP running_tracker_backup_last_success_timestamp_seconds Unix time at which the last successful backup was created.',
    '# TYPE running_tracker_backup_last_success_timestamp_seconds gauge',
    `running_tracker_backup_last_success_timestamp_seconds ${Math.floor(input.createdAt.getTime() / 1000)}`,
    '# HELP running_tracker_backup_last_size_bytes Size of the last successful backup artifact.',
    '# TYPE running_tracker_backup_last_size_bytes gauge',
    `running_tracker_backup_last_size_bytes ${input.sizeBytes}`,
    '# HELP running_tracker_backup_last_duration_seconds Duration of the last successful backup.',
    '# TYPE running_tracker_backup_last_duration_seconds gauge',
    `running_tracker_backup_last_duration_seconds ${input.durationMs / 1000}`,
    '',
  ].join('\n');
}

export async function writeBackupMetricsFile(path: string, input: BackupMetricsInput): Promise<void> {
  const temporaryPath = join(dirname(path), `.tmp-metrics-${randomUUID()}`);
  const handle = await open(temporaryPath, 'wx', 0o644);
  try {
    try {
      await handle.writeFile(renderBackupMetrics(input), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

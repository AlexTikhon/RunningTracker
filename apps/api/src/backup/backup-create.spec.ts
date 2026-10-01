import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBackup, renderBackupMetrics, writeBackupMetricsFile } from './backup-create.js';
import { createBackupDecryptor, readBackupHeader } from './backup-envelope.js';
import type { PgConnection, PgToolRunner } from './pg-tools.js';

const connection: PgConnection = {
  database: 'running_tracker_restore_drill_x_source',
  host: '127.0.0.1',
  password: 'Sup3r-Secret-Db-Password',
  port: '5433',
  user: 'running_tracker',
};

function runnerWith(dump: () => Readable): PgToolRunner {
  return {
    dump: () => dump(),
    restore: () => Promise.reject(new Error('not used')),
    version: (tool) => Promise.resolve(`${tool} (PostgreSQL) 17.5`),
  };
}

const facts = {
  lastMigration: '0019_set_based_run_visibility.sql',
  migrationCount: 20,
  postgisVersion: '3.5.2',
  serverVersion: '17.5',
};

describe('createBackup', () => {
  let directory: string;
  let key: Buffer;
  const now = new Date('2026-10-01T10:00:00.000Z');

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rt-backup-create-'));
    key = randomBytes(32);
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it('writes a verified encrypted artifact whose header identifies the source without secrets', async () => {
    const payload = randomBytes(64_000);
    const result = await createBackup({
      clock: { utcNow: () => now },
      connection,
      directory,
      key,
      readSourceFacts: () => Promise.resolve(facts),
      runner: runnerWith(() => Readable.from([payload])),
    });

    expect(result.fileName).toMatch(/^running-tracker-backup-20261001T100000Z-[0-9a-f]{8}\.rtbak$/u);
    expect(result.createdAt).toBe('2026-10-01T10:00:00.000Z');
    expect(result.plaintextBytes).toBe(payload.length);
    expect(result.sizeBytes).toBeGreaterThan(payload.length);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(await readdir(directory)).toEqual([result.fileName]);

    const { metadata } = await readBackupHeader(result.path);
    expect(metadata).toMatchObject({
      algorithm: 'aes-256-gcm',
      application: { lastMigration: facts.lastMigration, migrationCount: 20 },
      createdAt: '2026-10-01T10:00:00.000Z',
      dump: { format: 'pg_dump-custom', tool: 'pg_dump (PostgreSQL) 17.5' },
      formatVersion: 1,
      postgres: { postgisVersion: '3.5.2', serverVersion: '17.5' },
      source: { database: connection.database },
    });

    const { stream } = await createBackupDecryptor(result.path, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(payload);
  });

  it('never exposes the database password or the key in the result, the header, or the file', async () => {
    const result = await createBackup({
      clock: { utcNow: () => now },
      connection,
      directory,
      key,
      readSourceFacts: () => Promise.resolve(facts),
      runner: runnerWith(() => Readable.from([randomBytes(1000)])),
    });

    const printed = JSON.stringify(result);
    const raw = await readFile(result.path);
    for (const secret of [connection.password, key.toString('hex'), key.toString('base64')]) {
      expect(printed).not.toContain(secret);
      expect(raw.includes(Buffer.from(secret))).toBe(false);
    }
  });

  it('fails without leaving an artifact when the dump fails', async () => {
    function* broken(): Generator<Buffer> {
      yield randomBytes(1000);
      throw new Error('pg_dump failed with exit code 1: connection refused');
    }

    await expect(
      createBackup({
        clock: { utcNow: () => now },
        connection,
        directory,
        key,
        readSourceFacts: () => Promise.resolve(facts),
        runner: runnerWith(() => Readable.from(broken())),
      }),
    ).rejects.toThrow('pg_dump failed');
    expect(await readdir(directory)).toEqual([]);
  });

  it('refuses an empty dump rather than publishing a backup of nothing', async () => {
    await expect(
      createBackup({
        clock: { utcNow: () => now },
        connection,
        directory,
        key,
        readSourceFacts: () => Promise.resolve(facts),
        runner: runnerWith(() => Readable.from([])),
      }),
    ).rejects.toThrow('empty');
    expect(await readdir(directory)).toEqual([]);
  });

  it('rejects an invalid clock before touching the database or the disk', async () => {
    await expect(
      createBackup({
        clock: { utcNow: () => new Date(Number.NaN) },
        connection,
        directory,
        key,
        readSourceFacts: () => Promise.reject(new Error('must not be called')),
        runner: runnerWith(() => Readable.from(['x'])),
      }),
    ).rejects.toThrow('invalid UTC time');
  });

  it('does not leak the database password through a failing facts query', async () => {
    const error = await createBackup({
      clock: { utcNow: () => now },
      connection,
      directory,
      key,
      readSourceFacts: () => Promise.reject(new Error(`password authentication failed for ${connection.password}`)),
      runner: runnerWith(() => Readable.from(['x'])),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(connection.password);
  });
});

describe('backup age metric file', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rt-backup-metrics-'));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it('renders Prometheus text with the last successful backup instant and nothing identifying', () => {
    const text = renderBackupMetrics({
      createdAt: new Date('2026-10-01T10:00:00.000Z'),
      durationMs: 12_345,
      sizeBytes: 4096,
    });

    expect(text).toContain('# TYPE running_tracker_backup_last_success_timestamp_seconds gauge');
    expect(text).toContain('running_tracker_backup_last_success_timestamp_seconds 1790848800');
    expect(text).toContain('running_tracker_backup_last_size_bytes 4096');
    expect(text).toContain('running_tracker_backup_last_duration_seconds 12.345');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toMatch(/database|password|path|\.rtbak/iu);
  });

  it('replaces the file atomically and leaves no temporary file', async () => {
    const path = join(directory, 'running_tracker_backup.prom');
    await writeBackupMetricsFile(path, { createdAt: new Date('2026-10-01T10:00:00.000Z'), durationMs: 1, sizeBytes: 1 });
    await writeBackupMetricsFile(path, { createdAt: new Date('2026-10-02T10:00:00.000Z'), durationMs: 1, sizeBytes: 2 });

    expect(await readdir(directory)).toEqual(['running_tracker_backup.prom']);
    expect(await readFile(path, 'utf8')).toContain('running_tracker_backup_last_success_timestamp_seconds 1790935200');
  });
});

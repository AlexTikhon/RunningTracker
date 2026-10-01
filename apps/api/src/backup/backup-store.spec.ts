import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { verifyBackupFile, type BackupMetadataInput } from './backup-envelope.js';
import {
  backupFileName,
  listBackups,
  parseBackupFileName,
  pruneBackups,
  writeBackupArtifact,
} from './backup-store.js';

const metadata: BackupMetadataInput = {
  application: { lastMigration: '0019_x.sql', migrationCount: 20 },
  createdAt: '2026-10-01T10:00:00.000Z',
  dump: { format: 'pg_dump-custom', tool: 'pg_dump (PostgreSQL) 17.5' },
  postgres: { postgisVersion: '3.5.2', serverVersion: '17.5' },
  source: { database: 'running_tracker_restore_drill_x_source' },
};

const created = new Date('2026-10-01T10:00:00.000Z');

describe('backup file names', () => {
  it('encodes the creation instant and a random suffix in a fixed pattern', () => {
    expect(backupFileName(created, 'deadbeef')).toBe(
      'running-tracker-backup-20261001T100000Z-deadbeef.rtbak',
    );
    expect(parseBackupFileName('running-tracker-backup-20261001T100000Z-deadbeef.rtbak')).toEqual({
      createdAt: created,
    });
  });

  it('does not recognize foreign, temporary, or malformed names', () => {
    for (const name of [
      '.tmp-backup-3f2a',
      'notes.txt',
      'running-tracker-backup-20261001T100000Z-deadbeef.rtbak.bak',
      'running-tracker-backup-20261301T100000Z-deadbeef.rtbak',
      'running-tracker-backup-20261001T100000Z-DEADBEEF.rtbak',
      '../running-tracker-backup-20261001T100000Z-deadbeef.rtbak',
      'running-tracker-backup-20261001T100000Z-deadbeef.rtbak\n',
    ]) {
      expect(parseBackupFileName(name), name).toBeUndefined();
    }
  });
});

describe('backup artifact storage', () => {
  let directory: string;
  let key: Buffer;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rt-backup-store-'));
    key = randomBytes(32);
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it('writes an authenticated artifact atomically and leaves no temporary file', async () => {
    const payload = randomBytes(100_000);
    const result = await writeBackupArtifact({
      createdAt: created,
      directory,
      key,
      metadata,
      randomSuffix: 'aaaaaaaa',
      source: Readable.from([payload]),
    });

    expect(result.fileName).toBe('running-tracker-backup-20261001T100000Z-aaaaaaaa.rtbak');
    expect(await readdir(directory)).toEqual([result.fileName]);
    expect(result.size).toBe((await readFile(result.path)).length);
    expect((await verifyBackupFile(result.path, key)).plaintextBytes).toBe(payload.length);
  });

  it('creates the backup directory when it does not exist', async () => {
    const nested = join(directory, 'a', 'b');
    const result = await writeBackupArtifact({ createdAt: created, directory: nested, key, metadata, source: Readable.from(['x']) });
    expect(await readdir(nested)).toEqual([result.fileName]);
  });

  it('never overwrites an existing backup and keeps it byte-identical', async () => {
    const existing = join(directory, backupFileName(created, 'aaaaaaaa'));
    await writeFile(existing, 'precious earlier backup');

    await expect(
      writeBackupArtifact({
        createdAt: created,
        directory,
        key,
        metadata,
        randomSuffix: 'aaaaaaaa',
        source: Readable.from(['new data']),
      }),
    ).rejects.toThrow('already exists');

    expect(await readFile(existing, 'utf8')).toBe('precious earlier backup');
    expect(await readdir(directory)).toEqual([backupFileName(created, 'aaaaaaaa')]);
  });

  it('leaves neither a final nor a temporary file when the dump fails midway', async () => {
    function* failing(): Generator<Buffer> {
      yield randomBytes(50_000);
      throw new Error('pg_dump exited with status 1');
    }

    await expect(
      writeBackupArtifact({ createdAt: created, directory, key, metadata, source: Readable.from(failing()) }),
    ).rejects.toThrow('pg_dump exited with status 1');

    expect(await readdir(directory)).toEqual([]);
  });

  it('does not treat a leftover temporary file as a backup and never lists or prunes it', async () => {
    await writeFile(join(directory, '.tmp-backup-3f2a0000'), randomBytes(1000));
    await writeFile(join(directory, 'running-tracker-backup-20261001T100000Z-aaaaaaaa.rtbak.partial'), 'x');

    expect(await listBackups(directory)).toEqual([]);
    const report = await pruneBackups(directory, { now: new Date('2030-01-01T00:00:00.000Z') });
    expect(report.removed).toEqual([]);
    expect(await readdir(directory)).toHaveLength(2);
  });

  it('lists only this tool\'s regular files, oldest first, and ignores directories with a matching name', async () => {
    await writeFile(join(directory, backupFileName(new Date('2026-10-03T00:00:00.000Z'), 'cccccccc')), 'c');
    await writeFile(join(directory, backupFileName(new Date('2026-10-01T00:00:00.000Z'), 'aaaaaaaa')), 'a');
    await mkdir(join(directory, backupFileName(new Date('2026-10-02T00:00:00.000Z'), 'bbbbbbbb')));
    await writeFile(join(directory, 'README.txt'), 'x');

    const listed = await listBackups(directory);
    expect(listed.map((entry) => entry.fileName)).toEqual([
      backupFileName(new Date('2026-10-01T00:00:00.000Z'), 'aaaaaaaa'),
      backupFileName(new Date('2026-10-03T00:00:00.000Z'), 'cccccccc'),
    ]);
  });
});

describe('backup retention', () => {
  let directory: string;
  const now = new Date('2026-10-10T12:00:00.000Z');

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rt-backup-retention-'));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  async function seed(instant: string, suffix: string): Promise<string> {
    const name = backupFileName(new Date(instant), suffix);
    await writeFile(join(directory, name), suffix);
    return name;
  }

  it('removes only backups older than seven days and reports exactly what it removed', async () => {
    const old = await seed('2026-10-02T11:59:59.000Z', 'aaaaaaaa');
    const older = await seed('2026-09-20T00:00:00.000Z', 'bbbbbbbb');
    const boundary = await seed('2026-10-03T12:00:00.000Z', 'cccccccc');
    const recent = await seed('2026-10-09T12:00:00.000Z', 'dddddddd');

    const report = await pruneBackups(directory, { now });

    expect(report).toMatchObject({ kept: 2, retentionDays: 7 });
    expect([...report.removed].sort()).toEqual([old, older].sort());
    expect((await readdir(directory)).sort()).toEqual([boundary, recent].sort());
  });

  it('never removes a backup newer than the threshold, including future-dated ones', async () => {
    const future = await seed('2026-10-11T00:00:00.000Z', 'eeeeeeee');
    const fresh = await seed('2026-10-10T11:00:00.000Z', 'ffffffff');

    const report = await pruneBackups(directory, { now });

    expect(report.removed).toEqual([]);
    expect((await readdir(directory)).sort()).toEqual([future, fresh].sort());
  });

  it('keeps the newest backup when every backup is expired, unless explicitly forced', async () => {
    const oldest = await seed('2026-08-01T00:00:00.000Z', 'aaaaaaaa');
    const newest = await seed('2026-09-01T00:00:00.000Z', 'bbbbbbbb');

    const report = await pruneBackups(directory, { now });

    expect(report.removed).toEqual([oldest]);
    expect(report.keptLastBackup).toBe(true);
    expect(await readdir(directory)).toEqual([newest]);

    const forced = await pruneBackups(directory, { allowRemoveLast: true, now });
    expect(forced.removed).toEqual([newest]);
    expect(forced.keptLastBackup).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });

  it('never deletes foreign files or directories, whatever their age', async () => {
    await seed('2026-01-01T00:00:00.000Z', 'aaaaaaaa');
    await seed('2026-10-10T00:00:00.000Z', 'bbbbbbbb');
    await writeFile(join(directory, 'important.txt'), 'x');
    await utimes(join(directory, 'important.txt'), new Date('2001-01-01'), new Date('2001-01-01'));
    await mkdir(join(directory, 'subdir'));
    await writeFile(join(directory, '.tmp-backup-12345678'), 'x');

    await pruneBackups(directory, { now });

    expect((await readdir(directory)).sort()).toEqual(
      ['.tmp-backup-12345678', backupFileName(new Date('2026-10-10T00:00:00.000Z'), 'bbbbbbbb'), 'important.txt', 'subdir'].sort(),
    );
  });

  it('is deterministic and a second run removes nothing more', async () => {
    await seed('2026-09-01T00:00:00.000Z', 'aaaaaaaa');
    await seed('2026-09-02T00:00:00.000Z', 'bbbbbbbb');
    await seed('2026-10-09T00:00:00.000Z', 'cccccccc');

    const first = await pruneBackups(directory, { now });
    const second = await pruneBackups(directory, { now });

    expect(first.removed).toHaveLength(2);
    expect(second.removed).toEqual([]);
  });

  it('rejects a retention period that is not a positive whole number of days', async () => {
    for (const retentionDays of [0, -1, 1.5, Number.NaN, 4000]) {
      await expect(pruneBackups(directory, { now, retentionDays })).rejects.toThrow('retentionDays');
    }
  });

  it('reports an empty or missing directory without error', async () => {
    expect((await pruneBackups(directory, { now })).removed).toEqual([]);
    await expect(pruneBackups(join(directory, 'absent'), { now })).rejects.toThrow('cannot be read');
  });
});

import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseBackupArguments, runBackupCli } from './backup-cli.js';
import { backupFileName } from './backup-store.js';
import type { PgToolRunner } from './pg-tools.js';

const password = 'Db-Password-That-Must-Not-Print';

describe('backup command line', () => {
  let directory: string;
  let keyFile: string;
  let keyHex: string;
  let lines: string[];

  const runner = (dump: () => Readable): PgToolRunner => ({
    dump,
    restore: () => Promise.reject(new Error('unused')),
    version: () => Promise.resolve('pg_dump (PostgreSQL) 17.5'),
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rt-backup-cli-'));
    keyHex = randomBytes(32).toString('hex');
    keyFile = join(directory, 'keys', 'backup.key');
    await writeFile(join(directory, 'placeholder'), '');
    lines = [];
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  async function writeKey(): Promise<void> {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(directory, 'keys'), { recursive: true });
    await writeFile(keyFile, `${keyHex}\n`);
  }

  const environment = (): Record<string, string> => ({
    BACKUP_DATABASE_URL: `postgresql://running_tracker:${password}@db.internal:5432/running_tracker`,
    BACKUP_ENCRYPTION_KEY_FILE: keyFile,
  });

  const deps = (dump: () => Readable) => ({
    log: (line: string) => lines.push(line),
    readSourceFacts: () =>
      Promise.resolve({ lastMigration: '0019_x.sql', migrationCount: 20, postgisVersion: '3.5.2', serverVersion: '17.5' }),
    runner: runner(dump),
  });

  it('parses commands and flags strictly', () => {
    expect(parseBackupArguments(['create', '--out-dir', '/b'])).toMatchObject({ command: 'create', outDir: '/b' });
    expect(parseBackupArguments(['prune', '--dir', '/b', '--retention-days', '3', '--allow-remove-last'])).toMatchObject({
      allowRemoveLast: true,
      command: 'prune',
      dir: '/b',
      retentionDays: 3,
    });
    expect(parseBackupArguments(['verify', '--file', '/b/x'])).toMatchObject({ command: 'verify', file: '/b/x' });
    expect(parseBackupArguments(['keygen', '--out', '/k'])).toMatchObject({ command: 'keygen', out: '/k' });
    expect(parseBackupArguments(['decrypt', '--file', '/b/x', '--out', '/d'])).toMatchObject({
      command: 'decrypt',
      file: '/b/x',
      out: '/d',
    });
    for (const bad of [
      [],
      ['unknown'],
      ['create'],
      ['create', '--out-dir'],
      ['create', '--out-dir', '/b', '--surprise', 'x'],
      ['prune', '--dir', '/b', '--retention-days', 'abc'],
      ['prune'],
      ['verify'],
      ['keygen'],
      ['decrypt', '--file', '/b/x'],
      ['decrypt', '--out', '/d'],
    ]) {
      expect(() => parseBackupArguments(bad), JSON.stringify(bad)).toThrow('Usage');
    }
  });

  it('creates an encrypted backup, prints facts, and never prints the password, the URL, or the key', async () => {
    await writeKey();
    const outDir = join(directory, 'out');
    const code = await runBackupCli({
      ...deps(() => Readable.from([randomBytes(5000)])),
      argv: ['create', '--out-dir', outDir],
      env: environment(),
    });

    expect(code).toBe(0);
    const printed = lines.join('\n');
    expect(printed).toMatch(/backup created: running-tracker-backup-\d{8}T\d{6}Z-[0-9a-f]{8}\.rtbak/u);
    expect(printed).not.toContain(password);
    expect(printed).not.toContain('db.internal');
    expect(printed).not.toContain(keyHex);
    expect((await readdir(outDir)).length).toBe(1);
  });

  it('writes the age metric file only after a successful backup', async () => {
    await writeKey();
    const metrics = join(directory, 'backup.prom');

    await expect(
      runBackupCli({
        ...deps(() => Readable.from((function* (): Generator<Buffer> { yield randomBytes(10); throw new Error('dump failed'); })())),
        argv: ['create', '--out-dir', join(directory, 'out'), '--metrics-file', metrics],
        env: environment(),
      }),
    ).rejects.toThrow('dump failed');
    await expect(readFile(metrics)).rejects.toThrow();

    await runBackupCli({
      ...deps(() => Readable.from([randomBytes(10)])),
      argv: ['create', '--out-dir', join(directory, 'out'), '--metrics-file', metrics],
      env: environment(),
    });
    expect(await readFile(metrics, 'utf8')).toContain('running_tracker_backup_last_success_timestamp_seconds');
  });

  it('refuses to run without a key file, with a malformed key, or without a database URL', async () => {
    await expect(
      runBackupCli({ ...deps(() => Readable.from(['x'])), argv: ['create', '--out-dir', directory], env: { BACKUP_DATABASE_URL: environment().BACKUP_DATABASE_URL! } }),
    ).rejects.toThrow('BACKUP_ENCRYPTION_KEY_FILE is required');

    const badKey = join(directory, 'bad.key');
    await writeFile(badKey, `${keyHex.slice(0, 40)}\n`);
    const error = await runBackupCli({
      ...deps(() => Readable.from(['x'])),
      argv: ['create', '--out-dir', directory],
      env: { ...environment(), BACKUP_ENCRYPTION_KEY_FILE: badKey },
    }).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain('hexadecimal');
    expect((error as Error).message).not.toContain(keyHex.slice(0, 40));

    await writeKey();
    await expect(
      runBackupCli({ ...deps(() => Readable.from(['x'])), argv: ['create', '--out-dir', directory], env: { BACKUP_ENCRYPTION_KEY_FILE: keyFile } }),
    ).rejects.toThrow('BACKUP_DATABASE_URL is required');
  });

  it('refuses a key stored inside the backup directory', async () => {
    const outDir = join(directory, 'keys');
    await writeKey();
    await expect(
      runBackupCli({ ...deps(() => Readable.from(['x'])), argv: ['create', '--out-dir', outDir], env: environment() }),
    ).rejects.toThrow('must not be stored in the backup directory');
    expect(await readdir(outDir)).toEqual(['backup.key']);
  });

  it('verifies a backup, prints only its technical metadata, and fails for a wrong key', async () => {
    await writeKey();
    const outDir = join(directory, 'out');
    await runBackupCli({ ...deps(() => Readable.from([randomBytes(2000)])), argv: ['create', '--out-dir', outDir], env: environment() });
    const [fileName] = await readdir(outDir);
    lines.length = 0;

    expect(
      await runBackupCli({ ...deps(() => Readable.from([])), argv: ['verify', '--file', join(outDir, fileName!)], env: environment() }),
    ).toBe(0);
    const printed = lines.join('\n');
    expect(printed).toContain('authenticated: yes');
    expect(printed).toContain('algorithm: aes-256-gcm');
    expect(printed).toContain('format version: 1');
    expect(printed).not.toContain(password);
    expect(printed).not.toContain(keyHex);

    await writeFile(keyFile, `${randomBytes(32).toString('hex')}\n`);
    await expect(
      runBackupCli({ ...deps(() => Readable.from([])), argv: ['verify', '--file', join(outDir, fileName!)], env: environment() }),
    ).rejects.toThrow('authentication failed');
  });

  it('prunes with the seven-day default and reports what it removed', async () => {
    await writeFile(join(directory, backupFileName(new Date('2026-01-01T00:00:00.000Z'), 'aaaaaaaa')), 'x');
    await writeFile(join(directory, backupFileName(new Date(), 'bbbbbbbb')), 'y');

    expect(
      await runBackupCli({ ...deps(() => Readable.from([])), argv: ['prune', '--dir', directory], env: {} }),
    ).toBe(0);
    const printed = lines.join('\n');
    expect(printed).toContain('retention days: 7');
    expect(printed).toContain('removed: running-tracker-backup-20260101T000000Z-aaaaaaaa.rtbak');
    expect(printed).toContain('kept: 1');
  });

  it('decrypts an authenticated backup into a new file, refuses to overwrite it, and writes nothing for a wrong key', async () => {
    await writeKey();
    const dump = randomBytes(40_000);
    const outDir = join(directory, 'out');
    await runBackupCli({ ...deps(() => Readable.from([dump])), argv: ['create', '--out-dir', outDir], env: environment() });
    const [fileName] = await readdir(outDir);
    const backup = join(outDir, fileName!);
    const plain = join(directory, 'restore', 'dump.custom');
    lines.length = 0;

    expect(
      await runBackupCli({ ...deps(() => Readable.from([])), argv: ['decrypt', '--file', backup, '--out', plain], env: environment() }),
    ).toBe(0);
    expect(await readFile(plain)).toEqual(dump);
    expect(lines.join('\n')).toContain('plaintext bytes: 40000');
    expect(lines.join('\n')).not.toContain(keyHex);

    await expect(
      runBackupCli({ ...deps(() => Readable.from([])), argv: ['decrypt', '--file', backup, '--out', plain], env: environment() }),
    ).rejects.toThrow('already exists');
    expect(await readFile(plain)).toEqual(dump);

    await writeFile(keyFile, `${randomBytes(32).toString('hex')}\n`);
    const refused = join(directory, 'restore', 'refused.custom');
    await expect(
      runBackupCli({ ...deps(() => Readable.from([])), argv: ['decrypt', '--file', backup, '--out', refused], env: environment() }),
    ).rejects.toThrow('authentication failed');
    expect(await readdir(join(directory, 'restore'))).toEqual(['dump.custom']);
  });

  it('generates a key file and prints only its path', async () => {
    const out = join(directory, 'new.key');
    expect(await runBackupCli({ ...deps(() => Readable.from([])), argv: ['keygen', '--out', out], env: {} })).toBe(0);
    expect(lines.join('\n')).toContain(out);
    expect(lines.join('\n')).not.toMatch(/[0-9a-f]{64}/u);
    expect((await readFile(out, 'utf8')).trim()).toMatch(/^[0-9a-f]{64}$/u);
  });
});

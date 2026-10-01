import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { backupKeyBytes, generateBackupKeyFile, loadBackupKey } from './backup-key.js';

const goodHex = 'ab'.repeat(backupKeyBytes);

describe('backup encryption key file', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rt-backup-key-'));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  async function keyFile(contents: string, name = 'backup.key'): Promise<string> {
    const path = join(directory, name);
    await writeFile(path, contents);
    return path;
  }

  it('loads a 32-byte key written as 64 hex characters', async () => {
    const key = await loadBackupKey(await keyFile(goodHex));
    expect(key).toHaveLength(32);
    expect(key.every((byte) => byte === 0xab)).toBe(true);
  });

  it('accepts exactly one trailing newline, LF or CRLF', async () => {
    expect(await loadBackupKey(await keyFile(`${goodHex}\n`, 'lf.key'))).toHaveLength(32);
    expect(await loadBackupKey(await keyFile(`${goodHex}\r\n`, 'crlf.key'))).toHaveLength(32);
  });

  it('rejects a second trailing newline, surrounding whitespace, wrong length, and non-hex content', async () => {
    for (const contents of [
      `${goodHex}\n\n`,
      ` ${goodHex}`,
      `${goodHex} `,
      goodHex.slice(2),
      `${goodHex}ab`,
      `${'zz'.repeat(backupKeyBytes)}`,
      '',
      '\n',
    ]) {
      await expect(loadBackupKey(await keyFile(contents, 'bad.key'))).rejects.toThrow(
        /BACKUP_ENCRYPTION_KEY_FILE|key file/u,
      );
    }
  });

  it('never puts key material in an error message, even for a malformed key', async () => {
    const secretLooking = `${'c0ffee'.repeat(10)}zz`;
    const error = await loadBackupKey(await keyFile(secretLooking)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('c0ffee');
    expect((error as Error).message).not.toContain(secretLooking);
  });

  it('refuses a missing path, an empty setting, and a relative path without leaking contents', async () => {
    await expect(loadBackupKey(undefined)).rejects.toThrow('BACKUP_ENCRYPTION_KEY_FILE is required');
    await expect(loadBackupKey('')).rejects.toThrow('BACKUP_ENCRYPTION_KEY_FILE is required');
    await expect(loadBackupKey(join(directory, 'absent.key'))).rejects.toThrow(
      'The backup encryption key file cannot be read',
    );
    await expect(loadBackupKey('relative.key')).rejects.toThrow('must be an absolute path');
  });

  it('refuses a directory in place of the key file', async () => {
    await expect(loadBackupKey(directory)).rejects.toThrow('The backup encryption key file cannot be read');
  });

  it('creates missing parent directories for a generated key file', async () => {
    const path = join(directory, 'new', 'nested', 'generated.key');
    await generateBackupKeyFile(path);
    expect(await loadBackupKey(path)).toHaveLength(32);
  });

  it('generates a fresh key file, never overwrites, and never returns the key', async () => {
    const path = join(directory, 'generated.key');
    const result = await generateBackupKeyFile(path);
    expect(result).toEqual({ path });
    expect(await loadBackupKey(path)).toHaveLength(32);
    expect((await readFile(path, 'utf8')).trim()).toMatch(/^[0-9a-f]{64}$/u);
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o077).toBe(0);
    }

    const before = await readFile(path, 'utf8');
    await expect(generateBackupKeyFile(path)).rejects.toThrow('already exists');
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});

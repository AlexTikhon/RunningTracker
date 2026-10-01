import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  backupAlgorithm,
  backupFormatVersion,
  createBackupEncryptor,
  createBackupDecryptor,
  readBackupHeader,
  verifyBackupFile,
  type BackupMetadataInput,
} from './backup-envelope.js';

const metadataInput: BackupMetadataInput = {
  application: { lastMigration: '0019_set_based_run_visibility.sql', migrationCount: 20 },
  createdAt: '2026-10-01T10:00:00.000Z',
  dump: { format: 'pg_dump-custom', tool: 'pg_dump (PostgreSQL) 17.5' },
  postgres: { postgisVersion: '3.5.2', serverVersion: '17.5' },
  source: { database: 'running_tracker_restore_drill_x_source' },
};

describe('encrypted backup envelope', () => {
  let directory: string;
  let key: Buffer;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rt-envelope-'));
    key = randomBytes(32);
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  async function write(plaintext: Buffer, path = join(directory, 'a.rtbak')): Promise<string> {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < plaintext.length; offset += 7919) {
      chunks.push(plaintext.subarray(offset, offset + 7919));
    }
    await pipeline(Readable.from(chunks), createBackupEncryptor(key, metadataInput), createWriteStream(path));
    return path;
  }

  async function decrypt(path: string, withKey: Buffer = key): Promise<Buffer> {
    const { stream } = await createBackupDecryptor(path, withKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  it('round-trips a multi-chunk payload byte for byte', async () => {
    const plaintext = randomBytes(300_000);
    const path = await write(plaintext);
    expect(await decrypt(path)).toEqual(plaintext);
  });

  it('round-trips an empty payload', async () => {
    const path = await write(Buffer.alloc(0));
    expect(await decrypt(path)).toHaveLength(0);
  });

  it('records exact version, algorithm, nonce and the declared metadata, and nothing else', async () => {
    const path = await write(Buffer.from('payload'));
    const { metadata } = await readBackupHeader(path);

    expect(backupFormatVersion).toBe(1);
    expect(backupAlgorithm).toBe('aes-256-gcm');
    expect(metadata).toMatchObject({ ...metadataInput, algorithm: 'aes-256-gcm', formatVersion: 1 });
    expect(Buffer.from(metadata.nonce, 'base64')).toHaveLength(12);
    expect(Object.keys(metadata).sort()).toEqual([
      'algorithm',
      'application',
      'createdAt',
      'dump',
      'formatVersion',
      'nonce',
      'postgres',
      'source',
    ]);
  });

  it('does not store the plaintext or the key in the file', async () => {
    const secretPayload = Buffer.from('SENSITIVE-DUMP-CONTENT-0123456789');
    const path = await write(secretPayload);
    const raw = await readFile(path);
    expect(raw.includes(secretPayload)).toBe(false);
    expect(raw.includes(key)).toBe(false);
    expect(raw.includes(Buffer.from(key.toString('hex')))).toBe(false);
  });

  it('uses a fresh nonce for every backup', async () => {
    const first = await readBackupHeader(await write(Buffer.from('x'), join(directory, 'one.rtbak')));
    const second = await readBackupHeader(await write(Buffer.from('x'), join(directory, 'two.rtbak')));
    expect(first.metadata.nonce).not.toBe(second.metadata.nonce);
  });

  it('fails authentication with the wrong key and releases nothing usable', async () => {
    const path = await write(randomBytes(5000));
    await expect(decrypt(path, randomBytes(32))).rejects.toThrow('authentication failed');
  });

  it('fails authentication when one ciphertext byte is flipped', async () => {
    const path = await write(randomBytes(5000));
    const raw = await readFile(path);
    raw[raw.length - 40] = raw[raw.length - 40]! ^ 0x01;
    await writeFile(path, raw);
    await expect(decrypt(path)).rejects.toThrow('authentication failed');
    await expect(verifyBackupFile(path, key)).rejects.toThrow('authentication failed');
  });

  it('fails authentication when the authentication tag is damaged', async () => {
    const path = await write(randomBytes(5000));
    const raw = await readFile(path);
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0x80;
    await writeFile(path, raw);
    await expect(verifyBackupFile(path, key)).rejects.toThrow('authentication failed');
  });

  it('fails when the file is truncated, at several cut points', async () => {
    const path = await write(randomBytes(20_000));
    const size = (await readFile(path)).length;
    for (const cut of [1, 15, 16, 17, 500, 10_000]) {
      const copy = join(directory, `cut-${cut}.rtbak`);
      await writeFile(copy, (await readFile(path)).subarray(0, size - cut));
      await expect(verifyBackupFile(copy, key)).rejects.toThrow(/authentication failed|truncated|malformed/u);
    }
  });

  it('fails when the file is cut inside the header', async () => {
    const path = await write(randomBytes(100));
    await truncate(path, 20);
    await expect(readBackupHeader(path)).rejects.toThrow(/truncated|malformed/u);
  });

  it('authenticates the metadata: changing a header byte is detected even with the right key', async () => {
    const path = await write(randomBytes(500));
    const raw = await readFile(path);
    const text = raw.toString('latin1');
    const at = text.indexOf('restore_drill_x_source');
    expect(at).toBeGreaterThan(0);
    raw[at] = 'R'.charCodeAt(0);
    await writeFile(path, raw);
    await expect(verifyBackupFile(path, key)).rejects.toThrow('authentication failed');
  });

  it('rejects malformed envelopes before any decryption', async () => {
    const good = await readFile(await write(randomBytes(64)));
    const headerLength = good.readUInt32BE(8);
    const header = JSON.parse(good.subarray(12, 12 + headerLength).toString('utf8')) as Record<string, unknown>;
    const rest = good.subarray(12 + headerLength);

    function withHeader(next: unknown, declaredLength?: number): Buffer {
      const body = Buffer.from(typeof next === 'string' ? next : JSON.stringify(next), 'utf8');
      const prefix = Buffer.alloc(12);
      good.copy(prefix, 0, 0, 8);
      prefix.writeUInt32BE(declaredLength ?? body.length, 8);
      return Buffer.concat([prefix, body, rest]);
    }

    const cases: [string, Buffer, RegExp][] = [
      ['bad magic', Buffer.concat([Buffer.from('NOTABACK'), good.subarray(8)]), /not a Running Tracker backup/u],
      ['unsupported version', withHeader({ ...header, formatVersion: 2 }), /malformed backup header|unsupported/u],
      ['unknown algorithm', withHeader({ ...header, algorithm: 'aes-128-cbc' }), /malformed backup header|unsupported/u],
      ['unknown key', withHeader({ ...header, password: 'hunter2' }), /malformed backup header/u],
      ['nested unknown key', withHeader({ ...header, source: { database: 'd', host: 'h' } }), /malformed backup header/u],
      ['short nonce', withHeader({ ...header, nonce: Buffer.alloc(8).toString('base64') }), /malformed backup header/u],
      ['not json', withHeader('{not json'), /malformed backup header/u],
      ['array header', withHeader('[]'), /malformed backup header/u],
      ['non-canonical date', withHeader({ ...header, createdAt: '2026-10-01 10:00' }), /malformed backup header/u],
      ['oversized length', withHeader(header, 10_000_000), /malformed backup header|truncated/u],
    ];
    for (const [name, bytes, expected] of cases) {
      const path = join(directory, `${name.replaceAll(' ', '-')}.rtbak`);
      await writeFile(path, bytes);
      await expect(readBackupHeader(path), name).rejects.toThrow(expected);
    }
  });

  it('refuses a key of the wrong size', async () => {
    expect(() => createBackupEncryptor(Buffer.alloc(16), metadataInput)).toThrow('32 bytes');
    await expect(createBackupDecryptor(await write(Buffer.from('x')), Buffer.alloc(31))).rejects.toThrow(
      '32 bytes',
    );
  });

  it('never includes the key in any error message', async () => {
    const path = await write(randomBytes(1000));
    const wrong = randomBytes(32);
    const error = await verifyBackupFile(path, wrong).catch((caught: unknown) => caught);
    expect((error as Error).message).not.toContain(wrong.toString('hex'));
    expect((error as Error).message).not.toContain(key.toString('hex'));
  });
});

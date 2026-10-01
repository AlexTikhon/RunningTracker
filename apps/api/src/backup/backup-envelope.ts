import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { PassThrough, Readable, Transform, pipeline } from 'node:stream';
import { z } from 'zod';

import { backupKeyBytes } from './backup-key.js';

/**
 * Backup artifact layout (all integers big-endian):
 *
 *   8 bytes   magic "RTBACKUP"
 *   4 bytes   header length N (1..16384)
 *   N bytes   header: UTF-8 JSON, exactly the fields of BackupMetadata
 *   ...       ciphertext of the pg_dump custom-format archive
 *   16 bytes  AES-256-GCM authentication tag
 *
 * The magic, the length, and the header bytes are the GCM additional authenticated data, so the
 * metadata cannot be changed without failing authentication. The header holds identity-free
 * technical facts only; it never carries credentials, tokens, coordinates, or run data.
 */
export const backupFormatVersion = 1;
export const backupAlgorithm = 'aes-256-gcm';
export const backupDumpFormat = 'pg_dump-custom';

const magic = Buffer.from('RTBACKUP', 'ascii');
const nonceBytes = 12;
const tagBytes = 16;
const maximumHeaderBytes = 16_384;
const prefixFixedBytes = magic.length + 4;

const canonicalInstant = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
});

const shortText = z.string().min(1).max(200);

const metadataInputSchema = z.strictObject({
  application: z.strictObject({
    lastMigration: shortText.nullable(),
    migrationCount: z.number().int().min(0).max(100_000),
  }),
  createdAt: canonicalInstant,
  dump: z.strictObject({
    format: z.literal(backupDumpFormat),
    tool: shortText,
  }),
  postgres: z.strictObject({
    postgisVersion: shortText.nullable(),
    serverVersion: shortText,
  }),
  source: z.strictObject({
    database: z.string().min(1).max(63),
  }),
});

const metadataSchema = metadataInputSchema.extend({
  algorithm: z.literal(backupAlgorithm),
  formatVersion: z.literal(backupFormatVersion),
  nonce: z
    .string()
    .refine((value) => /^[A-Za-z0-9+/]+={0,2}$/u.test(value) && Buffer.from(value, 'base64').length === nonceBytes),
});

export type BackupMetadataInput = z.infer<typeof metadataInputSchema>;
export type BackupMetadata = z.infer<typeof metadataSchema>;

const authenticationFailure =
  'Backup authentication failed: wrong key, or the backup is corrupted, truncated, or modified';

function assertKey(key: Buffer): void {
  if (key.length !== backupKeyBytes) {
    throw new Error(`The backup encryption key must be ${backupKeyBytes} bytes`);
  }
}

/**
 * A Transform that emits the envelope header, then the ciphertext, then the authentication tag.
 * It validates the metadata it is given, so a caller cannot smuggle unreviewed fields into the header.
 */
export function createBackupEncryptor(key: Buffer, input: BackupMetadataInput): Transform {
  assertKey(key);
  const nonce = randomBytes(nonceBytes);
  const metadata: BackupMetadata = metadataSchema.parse({
    ...input,
    algorithm: backupAlgorithm,
    formatVersion: backupFormatVersion,
    nonce: nonce.toString('base64'),
  });
  const headerBytes = Buffer.from(JSON.stringify(metadata), 'utf8');
  const prefix = Buffer.alloc(prefixFixedBytes);
  magic.copy(prefix, 0);
  prefix.writeUInt32BE(headerBytes.length, magic.length);
  const header = Buffer.concat([prefix, headerBytes]);

  const cipher = createCipheriv(backupAlgorithm, key, nonce);
  cipher.setAAD(header);
  let headerWritten = false;

  return new Transform({
    flush(callback) {
      try {
        const rest = [cipher.final(), cipher.getAuthTag()];
        if (!headerWritten) {
          rest.unshift(header);
        }
        callback(null, Buffer.concat(rest));
      } catch (error) {
        callback(error as Error);
      }
    },
    transform(chunk: Buffer, _encoding, callback) {
      try {
        const encrypted = cipher.update(chunk);
        callback(null, headerWritten ? encrypted : Buffer.concat([header, encrypted]));
        headerWritten = true;
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

export interface BackupHeader {
  /** Offset of the first ciphertext byte. */
  bodyOffset: number;
  metadata: BackupMetadata;
  /** Magic, length and header bytes: the additional authenticated data. */
  prefix: Buffer;
  size: number;
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) {
      throw new Error('The backup is truncated');
    }
    filled += bytesRead;
  }
  return buffer;
}

export async function readBackupHeader(path: string): Promise<BackupHeader> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const fixed = await readExactly(handle, prefixFixedBytes, 0);
    if (!fixed.subarray(0, magic.length).equals(magic)) {
      throw new Error('The file is not a Running Tracker backup');
    }
    const headerLength = fixed.readUInt32BE(magic.length);
    if (headerLength < 1 || headerLength > maximumHeaderBytes) {
      throw new Error('The backup has a malformed backup header');
    }
    const headerBytes = await readExactly(handle, headerLength, prefixFixedBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(headerBytes.toString('utf8'));
    } catch {
      throw new Error('The backup has a malformed backup header');
    }
    const result = metadataSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error('The backup has a malformed backup header');
    }
    const bodyOffset = prefixFixedBytes + headerLength;
    if (size < bodyOffset + tagBytes) {
      throw new Error('The backup is truncated');
    }
    return {
      bodyOffset,
      metadata: result.data,
      prefix: Buffer.concat([fixed, headerBytes]),
      size,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Opens a backup for decryption. GCM can only confirm authenticity at the end of the stream, so
 * plaintext may be produced before a failure is reported: call `verifyBackupFile` first and only
 * hand the stream to a consumer after it succeeds.
 */
export async function createBackupDecryptor(
  path: string,
  key: Buffer,
): Promise<{ metadata: BackupMetadata; stream: Readable }> {
  assertKey(key);
  const header = await readBackupHeader(path);
  const handle = await open(path, 'r');
  let tag: Buffer;
  try {
    tag = await readExactly(handle, tagBytes, header.size - tagBytes);
  } finally {
    await handle.close();
  }

  const decipher = createDecipheriv(backupAlgorithm, key, Buffer.from(header.metadata.nonce, 'base64'));
  decipher.setAAD(header.prefix);
  decipher.setAuthTag(tag);

  const ciphertextEnd = header.size - tagBytes;
  const source =
    ciphertextEnd > header.bodyOffset
      ? createReadStream(path, { end: ciphertextEnd - 1, start: header.bodyOffset })
      : Readable.from([]);
  const decrypt = new Transform({
    flush(callback) {
      try {
        callback(null, decipher.final());
      } catch {
        callback(new Error(authenticationFailure));
      }
    },
    transform(chunk: Buffer, _encoding, callback) {
      callback(null, decipher.update(chunk));
    },
  });
  const stream = new PassThrough();
  pipeline(source, decrypt, stream, () => undefined);
  return { metadata: header.metadata, stream };
}

/** Reads the whole backup, authenticating it, and discards the plaintext. */
export async function verifyBackupFile(
  path: string,
  key: Buffer,
): Promise<{ metadata: BackupMetadata; plaintextBytes: number }> {
  const { metadata, stream } = await createBackupDecryptor(path, key);
  let plaintextBytes = 0;
  for await (const chunk of stream) {
    plaintextBytes += (chunk as Buffer).length;
  }
  return { metadata, plaintextBytes };
}

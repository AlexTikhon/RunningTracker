import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';

import { syncDirectory } from '../maintenance/deletion-journal-sink.js';
import { createBackupEncryptor, type BackupMetadataInput } from './backup-envelope.js';

export const defaultRetentionDays = 7;
const maximumRetentionDays = 3650;
const dayMs = 24 * 60 * 60 * 1000;

const fileNamePattern = /^running-tracker-backup-(\d{8}T\d{6}Z)-([0-9a-f]{8})\.rtbak$/u;
const temporaryPrefix = '.tmp-backup-';

function compactInstant(instant: Date): string {
  return instant.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

export function backupFileName(createdAt: Date, suffix: string): string {
  return `running-tracker-backup-${compactInstant(createdAt)}-${suffix}.rtbak`;
}

/** The only names this tool ever lists or deletes. */
export function parseBackupFileName(name: string): { createdAt: Date } | undefined {
  const match = fileNamePattern.exec(name);
  if (!match) return undefined;
  const stamp = match[1]!;
  const createdAt = new Date(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.000Z`,
  );
  if (Number.isNaN(createdAt.getTime()) || compactInstant(createdAt) !== stamp) return undefined;
  return { createdAt };
}

export interface WriteBackupOptions {
  createdAt: Date;
  directory: string;
  key: Buffer;
  metadata: BackupMetadataInput;
  randomSuffix?: string;
  /** The pg_dump custom-format archive. It must error, not just end, when the dump failed. */
  source: Readable;
}

export interface WrittenBackup {
  fileName: string;
  path: string;
  plaintextBytes: number;
  size: number;
}

/**
 * Encrypts the dump into a temporary file, fsyncs it, and publishes it under its final unique name
 * without ever replacing an existing file: a hard link fails if the name is taken, and only then is
 * the temporary name removed. A partially written artifact is never visible under the final pattern.
 */
export async function writeBackupArtifact(options: WriteBackupOptions): Promise<WrittenBackup> {
  const { createdAt, directory, key, metadata, source } = options;
  const suffix = options.randomSuffix ?? randomBytes(4).toString('hex');
  const fileName = backupFileName(createdAt, suffix);
  if (!parseBackupFileName(fileName)) {
    throw new Error('The backup file name is invalid');
  }
  await mkdir(directory, { recursive: true });
  const finalPath = join(directory, fileName);
  const temporaryPath = join(directory, `${temporaryPrefix}${randomUUID()}`);

  let plaintextBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      plaintextBytes += chunk.length;
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      source,
      counter,
      createBackupEncryptor(key, metadata),
      createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
    );
    if (plaintextBytes === 0) {
      throw new Error('The dump is empty, so no backup was written');
    }
    const handle = await open(temporaryPath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await link(temporaryPath, finalPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        throw new Error('The backup file already exists and is never overwritten', { cause: error });
      }
      // Some mounts do not support hard links. The name carries a random suffix, so check and rename.
      if (await exists(finalPath)) {
        throw new Error('The backup file already exists and is never overwritten', { cause: error });
      }
      await rename(temporaryPath, finalPath);
    }
    await unlink(temporaryPath).catch(() => undefined);
    await syncDirectory(directory);
    return { fileName, path: finalPath, plaintextBytes, size: (await stat(finalPath)).size };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface BackupListing {
  createdAt: Date;
  fileName: string;
}

export async function listBackups(directory: string): Promise<BackupListing[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    throw new Error('The backup directory cannot be read');
  }
  const listing: BackupListing[] = [];
  for (const fileName of names) {
    const parsed = parseBackupFileName(fileName);
    if (!parsed) continue;
    const info = await stat(join(directory, fileName));
    if (info.isFile()) {
      listing.push({ createdAt: parsed.createdAt, fileName });
    }
  }
  return listing.sort(
    (left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() || left.fileName.localeCompare(right.fileName),
  );
}

export interface PruneOptions {
  /** Allow removing the newest backup even when it is the last one left. */
  allowRemoveLast?: boolean;
  now: Date;
  retentionDays?: number;
}

export interface PruneReport {
  keptLastBackup: boolean;
  kept: number;
  removed: string[];
  retentionDays: number;
}

/**
 * Deletes backups of this tool that are strictly older than the retention period. It looks at no other
 * file, never removes a backup at or inside the threshold, and keeps the newest backup even when it is
 * expired unless the caller forces otherwise, so a stalled backup job cannot empty the directory.
 */
export async function pruneBackups(directory: string, options: PruneOptions): Promise<PruneReport> {
  const retentionDays = options.retentionDays ?? defaultRetentionDays;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > maximumRetentionDays) {
    throw new Error(`retentionDays must be a whole number between 1 and ${maximumRetentionDays}`);
  }
  if (!Number.isFinite(options.now.getTime())) {
    throw new Error('now must be a valid instant');
  }
  const threshold = options.now.getTime() - retentionDays * dayMs;
  const backups = await listBackups(directory);
  let expired = backups.filter((backup) => backup.createdAt.getTime() < threshold);
  let keptLastBackup = false;
  if (!options.allowRemoveLast && expired.length > 0 && expired.length === backups.length) {
    expired = expired.slice(0, -1);
    keptLastBackup = true;
  }
  for (const backup of expired) {
    await unlink(join(directory, backup.fileName));
  }
  return {
    kept: backups.length - expired.length,
    keptLastBackup,
    removed: expired.map((backup) => backup.fileName),
    retentionDays,
  };
}

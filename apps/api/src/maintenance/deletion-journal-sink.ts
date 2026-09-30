import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { deletionJournalFileNamePattern } from './deletion-journal-format.js';

/**
 * Where exported deletion journal files go. `write` resolves only once the
 * file is durable and visible under its final name: the exporter removes the
 * database rows only after that, so a resolved write is the durability boundary.
 */
export interface DeletionJournalSink {
  verify(): Promise<void>;
  write(fileName: string, contents: string): Promise<void>;
}

/** Portable "sync a directory" that tolerates platforms where it is not possible. */
async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows cannot open a directory for fsync; every other platform must succeed.
    if (
      process.platform === 'win32' &&
      (code === 'EISDIR' || code === 'EPERM' || code === 'EINVAL' || code === 'ENOTSUP')
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Writes to a directory that the operator mounts on storage outside the
 * database host (see docs/runbooks/deletion-journal-and-recovery.md). A file is
 * written under a temporary name, fsynced, renamed to its final name, and the
 * directory is fsynced, so a reader never sees a partially written journal file.
 */
export function createFileDeletionJournalSink(directory: string): DeletionJournalSink {
  return {
    async verify() {
      await mkdir(directory, { recursive: true });
      const probe = join(directory, `.probe-${randomUUID()}`);
      const handle = await open(probe, 'wx');
      try {
        await handle.writeFile('ok\n');
        await handle.sync();
      } finally {
        await handle.close();
        await rm(probe, { force: true });
      }
    },
    async write(fileName, contents) {
      if (!deletionJournalFileNamePattern.test(fileName)) {
        throw new Error('Invalid deletion journal file name');
      }
      const finalPath = join(directory, fileName);
      const temporaryPath = join(directory, `.tmp-${randomUUID()}`);
      const handle = await open(temporaryPath, 'wx');
      try {
        try {
          await handle.writeFile(contents, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporaryPath, finalPath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
      await syncDirectory(directory);
    },
  };
}

/** Journal files in name order, which is export order. */
export async function listDeletionJournalFiles(directory: string): Promise<string[]> {
  const names = await readdir(directory);
  return names.filter((name) => deletionJournalFileNamePattern.test(name)).sort();
}

export async function readDeletionJournalFile(
  directory: string,
  fileName: string,
): Promise<string> {
  return readFile(join(directory, fileName), 'utf8');
}

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createFileDeletionJournalSink,
  listAccessJournalFiles,
  listDeletionJournalFiles,
  readDeletionJournalFile,
} from './deletion-journal-sink.js';

describe('file deletion journal sink', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rt-journal-'));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it('writes a complete file under its final name and leaves no temporary file', async () => {
    const sink = createFileDeletionJournalSink(directory);
    await sink.write('deletion-journal-a-1-1-aaaaaaaa.ndjson', 'line\n');

    expect(await readdir(directory)).toEqual(['deletion-journal-a-1-1-aaaaaaaa.ndjson']);
    expect(await readFile(join(directory, 'deletion-journal-a-1-1-aaaaaaaa.ndjson'), 'utf8')).toBe(
      'line\n',
    );
  });

  it('rejects names outside the journal pattern before touching the disk', async () => {
    const sink = createFileDeletionJournalSink(directory);
    await expect(sink.write('../escape.ndjson', 'x')).rejects.toThrow('Invalid journal file name');
    await expect(sink.write('notes.txt', 'x')).rejects.toThrow('Invalid journal file name');
    expect(await readdir(directory)).toEqual([]);
  });

  it('fails and cleans up when the destination is unusable', async () => {
    const sink = createFileDeletionJournalSink(join(directory, 'missing', 'child'));
    await expect(sink.write('deletion-journal-a-1-1-aaaaaaaa.ndjson', 'x')).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it('verify creates a missing directory, proves it is writable, and leaves nothing behind', async () => {
    const nested = join(directory, 'a', 'b');
    const sink = createFileDeletionJournalSink(nested);
    await sink.verify();
    expect(await readdir(nested)).toEqual([]);
  });

  it('lists only journal files in name order and ignores temporary or foreign files', async () => {
    await writeFile(join(directory, 'deletion-journal-b.ndjson'), '');
    await writeFile(join(directory, 'deletion-journal-a.ndjson'), 'x\n');
    await writeFile(join(directory, '.tmp-123'), '');
    await writeFile(join(directory, 'README.txt'), '');

    expect(await listDeletionJournalFiles(directory)).toEqual([
      'deletion-journal-a.ndjson',
      'deletion-journal-b.ndjson',
    ]);
    expect(await readDeletionJournalFile(directory, 'deletion-journal-a.ndjson')).toBe('x\n');
  });

  it('also writes access journal files and keeps the two journals apart when listing', async () => {
    const sink = createFileDeletionJournalSink(directory);
    await sink.write('access-journal-a-1-1-aaaaaaaa.ndjson', 'x\n');
    await sink.write('deletion-journal-a-1-1-aaaaaaaa.ndjson', 'y\n');

    expect(await listAccessJournalFiles(directory)).toEqual(['access-journal-a-1-1-aaaaaaaa.ndjson']);
    expect(await listDeletionJournalFiles(directory)).toEqual(['deletion-journal-a-1-1-aaaaaaaa.ndjson']);
    expect(await readDeletionJournalFile(directory, 'access-journal-a-1-1-aaaaaaaa.ndjson')).toBe('x\n');
  });
});

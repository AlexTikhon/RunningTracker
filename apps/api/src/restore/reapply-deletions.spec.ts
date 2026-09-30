import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  serializeDeletionJournalEntries,
  type DeletionJournalEntry,
} from '../maintenance/deletion-journal-format.js';
import { loadDeletionJournal, reapplyDeletions } from './reapply-deletions.js';
import { parseReapplyArguments, runReapplyCli } from './reapply-deletions-cli.js';

const clock = { utcNow: () => new Date('2032-06-01T00:00:00.000Z') };

function entry(seq: number, overrides: Partial<DeletionJournalEntry> = {}): DeletionJournalEntry {
  return {
    deletedAt: '2032-01-10T00:00:00.000Z',
    orgId: '11111111-1111-4111-8111-111111111111',
    ownerUserId: '22222222-2222-4222-8222-222222222222',
    runId: `33333333-3333-4333-8333-${String(seq).padStart(12, '0')}`,
    seq: String(seq),
    v: 1,
    ...overrides,
  };
}

describe('journal directory loading and reapplication', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rt-reapply-'));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it('loads every file in name order and ignores temporary files', async () => {
    await writeFile(
      join(directory, 'deletion-journal-2.ndjson'),
      serializeDeletionJournalEntries([entry(3)]),
    );
    await writeFile(
      join(directory, 'deletion-journal-1.ndjson'),
      serializeDeletionJournalEntries([entry(1), entry(2)]),
    );
    await writeFile(join(directory, '.tmp-partial'), 'garbage');

    const journal = await loadDeletionJournal(directory);

    expect(journal.files).toBe(2);
    expect(journal.entries.map((item) => item.seq)).toEqual(['1', '2', '3']);
  });

  it('rejects the whole journal when any one file is malformed', async () => {
    await writeFile(
      join(directory, 'deletion-journal-1.ndjson'),
      serializeDeletionJournalEntries([entry(1)]),
    );
    await writeFile(join(directory, 'deletion-journal-2.ndjson'), '{"broken":\n');

    await expect(loadDeletionJournal(directory)).rejects.toThrow('deletion-journal-2.ndjson');
  });

  it('applies each entry in its own transaction and tallies outcomes', async () => {
    const outcomes = ['deleted', 'marker_present', 'skipped_newer_run'];
    const statements: string[] = [];
    const client = {
      query: vi.fn((sql: string, values?: unknown[]) => {
        statements.push(sql.trim().split(/\s/u)[0]!);
        if (sql.includes('reapply_journaled_deletion')) {
          expect(values?.[4]).toBe('2032-06-01T00:00:00.000Z');
          return Promise.resolve({ rows: [{ outcome: outcomes.shift() }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: vi.fn(),
    };

    const report = await reapplyDeletions(
      { connect: () => Promise.resolve(client as unknown as PoolClient) },
      clock,
      { entries: [entry(1), entry(2), entry(3)], files: 1 },
    );

    expect(report.entries).toBe(3);
    expect(report.outcomes).toMatchObject({ deleted: 1, marker_present: 1, skipped_newer_run: 1 });
    expect(statements).toEqual([
      'BEGIN', 'SELECT', 'COMMIT',
      'BEGIN', 'SELECT', 'COMMIT',
      'BEGIN', 'SELECT', 'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledWith();
  });

  it('stops at the first failure, rolls it back, and destroys the connection', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn((sql: string) => {
        statements.push(sql.trim().split(/\s/u)[0]!);
        if (sql.includes('reapply_journaled_deletion')) return Promise.reject(new Error('lock timeout'));
        return Promise.resolve({ rows: [] });
      }),
      release: vi.fn(),
    };

    await expect(
      reapplyDeletions(
        { connect: () => Promise.resolve(client as unknown as PoolClient) },
        clock,
        { entries: [entry(1), entry(2)], files: 1 },
      ),
    ).rejects.toThrow('lock timeout');

    expect(statements).toEqual(['BEGIN', 'SELECT', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('rejects an unknown outcome from the database function', async () => {
    const client = {
      query: vi.fn((sql: string) =>
        Promise.resolve({ rows: sql.includes('reapply_journaled_deletion') ? [{ outcome: 'weird' }] : [] }),
      ),
      release: vi.fn(),
    };
    await expect(
      reapplyDeletions(
        { connect: () => Promise.resolve(client as unknown as PoolClient) },
        clock,
        { entries: [entry(1)], files: 1 },
      ),
    ).rejects.toThrow('invalid result');
  });
});

describe('reapply command line', () => {
  it('requires exactly --journal-dir with a value', () => {
    expect(parseReapplyArguments(['--journal-dir', '/mnt/journal'])).toEqual({
      journalDir: '/mnt/journal',
    });
    for (const argv of [[], ['--journal-dir'], ['--journal-dir', ''], ['--dir', 'x'], ['--journal-dir', 'x', 'y']]) {
      expect(() => parseReapplyArguments(argv)).toThrow('Usage');
    }
  });

  it('requires RESTORE_DATABASE_URL and the owner role, and prints counts only', async () => {
    await expect(runReapplyCli({ argv: ['--journal-dir', '/nonexistent'], env: {} })).rejects.toThrow(
      'RESTORE_DATABASE_URL is required',
    );

    const directory = await mkdtemp(join(tmpdir(), 'rt-reapply-cli-'));
    try {
      await writeFile(
        join(directory, 'deletion-journal-1.ndjson'),
        serializeDeletionJournalEntries([entry(1)]),
      );
      const end = vi.fn(() => Promise.resolve());
      const wrongRole = {
        connect: vi.fn(),
        end,
        query: vi.fn(() =>
          Promise.resolve({ rows: [{ database_name: 'restore', role_name: 'running_tracker_runtime' }] }),
        ),
      };
      await expect(
        runReapplyCli({
          argv: ['--journal-dir', directory],
          createPool: () => wrongRole as never,
          env: { RESTORE_DATABASE_URL: 'postgresql://x' },
          log: () => undefined,
        }),
      ).rejects.toThrow('must authenticate as running_tracker_owner');
      expect(wrongRole.connect).not.toHaveBeenCalled();
      expect(end).toHaveBeenCalledOnce();

      const lines: string[] = [];
      const client = {
        query: vi.fn((sql: string) =>
          Promise.resolve({ rows: sql.includes('reapply_journaled_deletion') ? [{ outcome: 'deleted' }] : [] }),
        ),
        release: vi.fn(),
      };
      const owner = {
        connect: () => Promise.resolve(client as unknown as PoolClient),
        end: vi.fn(() => Promise.resolve()),
        query: vi.fn(() =>
          Promise.resolve({ rows: [{ database_name: 'restore', role_name: 'running_tracker_owner' }] }),
        ),
      };
      await expect(
        runReapplyCli({
          argv: ['--journal-dir', directory],
          clock,
          createPool: () => owner as never,
          env: { RESTORE_DATABASE_URL: 'postgresql://x' },
          log: (line) => lines.push(line),
        }),
      ).resolves.toBe(0);
      expect(lines).toContain('journal entries: 1');
      expect(lines).toContain('deleted: 1');
      expect(lines.join('\n')).not.toContain('11111111-1111');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

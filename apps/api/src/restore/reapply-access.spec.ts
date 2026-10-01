import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  serializeAccessJournalEntries,
  type AccessJournalEntry,
} from '../maintenance/access-journal-format.js';
import { serializeDeletionJournalEntries } from '../maintenance/deletion-journal-format.js';
import { loadAccessJournal, reapplyAccessRestrictions } from './reapply-access.js';
import { runReapplyAccessCli } from './reapply-access-cli.js';

const org = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';

function entry(seq: number, overrides: Partial<AccessJournalEntry> = {}): AccessJournalEntry {
  return {
    changedAt: '2032-01-10T00:00:00.000Z',
    kind: 'membership_deactivated',
    orgId: org,
    seq: String(seq),
    userId: user,
    v: 1,
    ...overrides,
  } as AccessJournalEntry;
}

const revoked = (seq: number) =>
  entry(seq, { kind: 'share_revoked', runId: `33333333-3333-4333-8333-${String(seq).padStart(12, '0')}` });
const narrowed = (seq: number) =>
  entry(seq, {
    canReadHistory: false,
    canReadLive: true,
    kind: 'share_narrowed',
    runId: `33333333-3333-4333-8333-${String(seq).padStart(12, '0')}`,
  });

function clientReturning(outcomes: string[], onSql?: (sql: string, values?: unknown[]) => void) {
  const statements: string[] = [];
  const client = {
    query: vi.fn((sql: string, values?: unknown[]) => {
      statements.push(sql.trim().split(/\s/u)[0]!);
      onSql?.(sql, values);
      if (sql.includes('reapply_access_restriction')) {
        return Promise.resolve({ rows: [{ outcome: outcomes.shift() }] });
      }
      return Promise.resolve({ rows: [] });
    }),
    release: vi.fn(),
  };
  return { client, pool: { connect: () => Promise.resolve(client as unknown as PoolClient) }, statements };
}

describe('access journal loading and reapplication', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rt-reapply-access-'));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it('loads only access journal files, in name order, and ignores deletion and temporary files', async () => {
    await writeFile(join(directory, 'access-journal-2.ndjson'), serializeAccessJournalEntries([revoked(3)]));
    await writeFile(
      join(directory, 'access-journal-1.ndjson'),
      serializeAccessJournalEntries([entry(1), narrowed(2)]),
    );
    await writeFile(
      join(directory, 'deletion-journal-1.ndjson'),
      serializeDeletionJournalEntries([
        {
          deletedAt: '2032-01-10T00:00:00.000Z',
          orgId: org,
          ownerUserId: user,
          runId: '33333333-3333-4333-8333-000000000009',
          seq: '9',
          v: 1,
        },
      ]),
    );
    await writeFile(join(directory, '.tmp-partial'), 'garbage');

    const journal = await loadAccessJournal(directory);

    expect(journal.files).toBe(2);
    expect(journal.entries.map((item) => item.seq)).toEqual(['1', '2', '3']);
  });

  it('rejects the whole journal when any one file is malformed', async () => {
    await writeFile(join(directory, 'access-journal-1.ndjson'), serializeAccessJournalEntries([entry(1)]));
    await writeFile(join(directory, 'access-journal-2.ndjson'), '{"broken":\n');

    await expect(loadAccessJournal(directory)).rejects.toThrow('access-journal-2.ndjson');
  });

  it('applies each entry in its own transaction, passing its kind and booleans, and tallies outcomes', async () => {
    const calls: unknown[][] = [];
    const { client, pool, statements } = clientReturning(
      ['applied', 'already_applied', 'skipped_unknown_organization'],
      (sql, values) => {
        if (sql.includes('reapply_access_restriction')) calls.push(values ?? []);
      },
    );

    const report = await reapplyAccessRestrictions(pool, {
      entries: [entry(1), revoked(2), narrowed(3)],
      files: 1,
    });

    expect(report).toMatchObject({
      entries: 3,
      outcomes: { already_applied: 1, applied: 1, skipped_unknown_organization: 1 },
    });
    expect(calls).toEqual([
      ['membership_deactivated', org, user, null, null, null],
      ['share_revoked', org, user, '33333333-3333-4333-8333-000000000002', null, null],
      ['share_narrowed', org, user, '33333333-3333-4333-8333-000000000003', false, true],
    ]);
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
        if (sql.includes('reapply_access_restriction')) return Promise.reject(new Error('lock timeout'));
        return Promise.resolve({ rows: [] });
      }),
      release: vi.fn(),
    };

    await expect(
      reapplyAccessRestrictions(
        { connect: () => Promise.resolve(client as unknown as PoolClient) },
        { entries: [entry(1), entry(2)], files: 1 },
      ),
    ).rejects.toThrow('lock timeout');

    expect(statements).toEqual(['BEGIN', 'SELECT', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('rejects an unknown outcome from the database function', async () => {
    const { pool } = clientReturning(['granted']);
    await expect(reapplyAccessRestrictions(pool, { entries: [entry(1)], files: 1 })).rejects.toThrow(
      'invalid result',
    );
  });
});

describe('reapply access command line', () => {
  it('requires RESTORE_DATABASE_URL and the owner role, and prints counts only', async () => {
    await expect(runReapplyAccessCli({ argv: ['--journal-dir', '/nonexistent'], env: {} })).rejects.toThrow(
      'RESTORE_DATABASE_URL is required',
    );
    await expect(runReapplyAccessCli({ argv: [], env: {} })).rejects.toThrow('Usage');

    const directory = await mkdtemp(join(tmpdir(), 'rt-reapply-access-cli-'));
    try {
      await writeFile(join(directory, 'access-journal-1.ndjson'), serializeAccessJournalEntries([entry(1)]));
      const end = vi.fn(() => Promise.resolve());
      const wrongRole = {
        connect: vi.fn(),
        end,
        query: vi.fn(() =>
          Promise.resolve({ rows: [{ database_name: 'restore', role_name: 'running_tracker_runtime' }] }),
        ),
      };
      await expect(
        runReapplyAccessCli({
          argv: ['--journal-dir', directory],
          createPool: () => wrongRole as never,
          env: { RESTORE_DATABASE_URL: 'postgresql://x' },
          log: () => undefined,
        }),
      ).rejects.toThrow('must authenticate as running_tracker_owner');
      expect(wrongRole.connect).not.toHaveBeenCalled();
      expect(end).toHaveBeenCalledOnce();

      const lines: string[] = [];
      const { pool } = clientReturning(['applied']);
      const owner = {
        connect: pool.connect,
        end: vi.fn(() => Promise.resolve()),
        query: vi.fn(() =>
          Promise.resolve({ rows: [{ database_name: 'restore', role_name: 'running_tracker_owner' }] }),
        ),
      };
      await expect(
        runReapplyAccessCli({
          argv: ['--journal-dir', directory],
          createPool: () => owner as never,
          env: { RESTORE_DATABASE_URL: 'postgresql://x' },
          log: (line) => lines.push(line),
        }),
      ).resolves.toBe(0);
      expect(lines).toContain('journal entries: 1');
      expect(lines).toContain('applied: 1');
      expect(lines.join('\n')).not.toContain('11111111-1111');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { serializeErasureLedgerEntries, type ErasureLedgerEntry } from '../maintenance/erasure-ledger-format.js';
import { loadErasureLedger, reapplyErasures } from './reapply-erasures.js';
import { parseReapplyErasuresArguments, runReapplyErasuresCli } from './reapply-erasures-cli.js';

function entry(seq: number, overrides: Partial<ErasureLedgerEntry> = {}): ErasureLedgerEntry {
  return {
    entityType: 'activity',
    erasedAt: '2032-01-10T00:00:00.000000Z',
    orgId: '11111111-1111-4111-8111-111111111111',
    ownerUserId: '22222222-2222-4222-8222-222222222222',
    recordCreatedAt: '2032-01-09T08:00:00.123456Z',
    recordId: `33333333-3333-4333-8333-${String(seq).padStart(12, '0')}`,
    seq: String(seq),
    v: 1,
    ...overrides,
  };
}

function fakeClient(outcomes: unknown[]) {
  const statements: string[] = [];
  const client = {
    query: vi.fn((sql: string, values?: unknown[]) => {
      statements.push(sql.trim().split(/\s/u)[0]!);
      if (sql.includes('reapply_erasure')) {
        expect(values).toHaveLength(5);
        return Promise.resolve({ rows: [{ outcome: outcomes.shift() }] });
      }
      return Promise.resolve({ rows: [] });
    }),
    release: vi.fn(),
  };
  return { client, statements };
}

describe('erasure ledger loading and replay (ADR-0073)', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rt-erasures-'));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it('loads only erasure ledger files, in name order, and ignores the other journals and temporary files', async () => {
    await writeFile(join(directory, 'erasure-ledger-2.ndjson'), serializeErasureLedgerEntries([entry(3)]));
    await writeFile(join(directory, 'erasure-ledger-1.ndjson'), serializeErasureLedgerEntries([entry(1), entry(2)]));
    await writeFile(join(directory, 'deletion-journal-1.ndjson'), '{"not":"an erasure"}\n');
    await writeFile(join(directory, '.tmp-partial'), 'garbage');

    const ledger = await loadErasureLedger(directory);
    expect(ledger.files).toBe(2);
    expect(ledger.entries.map((item) => item.seq)).toEqual(['1', '2', '3']);
  });

  it('rejects the whole ledger when any one file is malformed, before any database work', async () => {
    await writeFile(join(directory, 'erasure-ledger-1.ndjson'), serializeErasureLedgerEntries([entry(1)]));
    await writeFile(join(directory, 'erasure-ledger-2.ndjson'), '{"broken":\n');
    await expect(loadErasureLedger(directory)).rejects.toThrow('erasure-ledger-2.ndjson');
  });

  it('replays each entry in its own transaction, passing the exact creation instant, and tallies outcomes', async () => {
    const { client, statements } = fakeClient(['erased', 'absent', 'skipped_different_record']);
    const pool = { connect: vi.fn(() => Promise.resolve(client as unknown as PoolClient)) };

    const report = await reapplyErasures(pool, { entries: [entry(1), entry(2), entry(3)], files: 1 });

    expect(report).toEqual({ entries: 3, files: 1, outcomes: { absent: 1, erased: 1, skipped_different_record: 1 } });
    expect(statements).toEqual(['BEGIN', 'SELECT', 'COMMIT', 'BEGIN', 'SELECT', 'COMMIT', 'BEGIN', 'SELECT', 'COMMIT']);
    expect(client.query.mock.calls[1]?.[1]).toEqual([
      'activity',
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-000000000001',
      '22222222-2222-4222-8222-222222222222',
      '2032-01-09T08:00:00.123456Z',
    ]);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('stops, rolls back and discards the connection on an unknown outcome', async () => {
    const { client, statements } = fakeClient(['vanished']);
    const pool = { connect: vi.fn(() => Promise.resolve(client as unknown as PoolClient)) };
    await expect(reapplyErasures(pool, { entries: [entry(1), entry(2)], files: 1 })).rejects.toThrow('invalid result');
    expect(statements).toEqual(['BEGIN', 'SELECT', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledWith(true);
  });
});

describe('restore:reapply-erasures command line', () => {
  it('accepts exactly --journal-dir <directory>', () => {
    expect(parseReapplyErasuresArguments(['--journal-dir', '/j'])).toEqual({ journalDir: '/j' });
    for (const argv of [[], ['--journal-dir'], ['/j'], ['--dir', '/j'], ['--journal-dir', '/j', 'extra']]) {
      expect(() => parseReapplyErasuresArguments(argv)).toThrow('Usage');
    }
  });

  it('requires RESTORE_DATABASE_URL and refuses any role but the object owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rt-erasures-cli-'));
    try {
      await expect(runReapplyErasuresCli({ argv: ['--journal-dir', directory], env: {} })).rejects.toThrow('RESTORE_DATABASE_URL');
      const end = vi.fn(() => Promise.resolve());
      await expect(
        runReapplyErasuresCli({
          argv: ['--journal-dir', directory],
          createPool: () => ({
            connect: vi.fn(),
            end,
            query: vi.fn(() => Promise.resolve({ rows: [{ database_name: 'restored', role_name: 'running_tracker_runtime' }] })),
          }) as never,
          env: { RESTORE_DATABASE_URL: 'postgres://ignored' },
        }),
      ).rejects.toThrow('must authenticate as running_tracker_owner');
      expect(end).toHaveBeenCalled();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('prints counts and outcome names only, never an identifier', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rt-erasures-cli-'));
    try {
      await writeFile(join(directory, 'erasure-ledger-1.ndjson'), serializeErasureLedgerEntries([entry(1)]));
      const { client } = fakeClient(['erased']);
      const lines: string[] = [];
      const code = await runReapplyErasuresCli({
        argv: ['--journal-dir', directory],
        createPool: () => ({
          connect: vi.fn(() => Promise.resolve(client)),
          end: vi.fn(() => Promise.resolve()),
          query: vi.fn(() => Promise.resolve({ rows: [{ database_name: 'restored', role_name: 'running_tracker_owner' }] })),
        }) as never,
        env: { RESTORE_DATABASE_URL: 'postgres://ignored' },
        log: (line) => lines.push(line),
      });
      expect(code).toBe(0);
      expect(lines).toEqual(['database: restored', 'ledger files: 1', 'ledger entries: 1', 'absent: 0', 'erased: 1', 'skipped_different_record: 0']);
      expect(lines.join('\n')).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

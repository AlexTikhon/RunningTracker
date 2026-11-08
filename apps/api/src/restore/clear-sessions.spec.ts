import { describe, expect, it, vi } from 'vitest';

import { runClearSessionsCli } from './clear-sessions-cli.js';

function fakePool(role: string, cleared: string, remaining = '0') {
  const queries: string[] = [];
  const pool = {
    end: vi.fn(() => Promise.resolve()),
    query: vi.fn((sql: string) => {
      queries.push(sql);
      if (sql.includes('current_user')) {
        return Promise.resolve({ rows: [{ database_name: 'restored_db', role_name: role }] });
      }
      if (sql.includes('clear_auth_sessions')) {
        return Promise.resolve({ rows: [{ cleared }] });
      }
      return Promise.resolve({ rows: [{ remaining }] });
    }),
  };
  return { pool, queries };
}

describe('restore:clear-sessions (ADR-0080)', () => {
  it('clears every session as the owner and prints only counts', async () => {
    const { pool, queries } = fakePool('running_tracker_owner', '3');
    const lines: string[] = [];

    const code = await runClearSessionsCli({
      argv: [],
      createPool: () => pool as never,
      env: { RESTORE_DATABASE_URL: 'postgresql://running_tracker_owner:secret@127.0.0.1/restored_db' },
      log: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(lines).toEqual(['database: restored_db', 'sessions cleared: 3', 'sessions remaining: 0']);
    expect(queries.some((sql) => sql.includes('app_private.clear_auth_sessions()'))).toBe(true);
    expect(lines.join('\n')).not.toContain('secret');
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('refuses any role but the owner, and changes nothing', async () => {
    const { pool, queries } = fakePool('running_tracker_runtime', '0');

    await expect(
      runClearSessionsCli({ argv: [], createPool: () => pool as never, env: { RESTORE_DATABASE_URL: 'postgresql://x' } }),
    ).rejects.toThrow('must authenticate as running_tracker_owner');
    expect(queries.some((sql) => sql.includes('clear_auth_sessions'))).toBe(false);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('fails, rather than reporting success, if any session remains', async () => {
    const { pool } = fakePool('running_tracker_owner', '1', '1');

    await expect(
      runClearSessionsCli({ argv: [], createPool: () => pool as never, env: { RESTORE_DATABASE_URL: 'postgresql://x' } }),
    ).rejects.toThrow('do not reopen the database');
  });

  it('requires the URL and takes no arguments', async () => {
    await expect(runClearSessionsCli({ argv: [], env: {} })).rejects.toThrow('RESTORE_DATABASE_URL is required');
    await expect(runClearSessionsCli({ argv: ['--all'], env: { RESTORE_DATABASE_URL: 'postgresql://x' } })).rejects.toThrow(
      'Usage:',
    );
  });
});

import { describe, expect, it, vi } from 'vitest';

import { runClearSessionsCli } from './clear-sessions-cli.js';

interface FakeCounts {
  loginsCleared?: string;
  loginsRemaining?: string;
  sessionsCleared?: string;
  sessionsRemaining?: string;
}

function fakePool(role: string, counts: FakeCounts = {}) {
  const queries: string[] = [];
  const pool = {
    end: vi.fn(() => Promise.resolve()),
    query: vi.fn((sql: string) => {
      queries.push(sql);
      if (sql.includes('current_user')) {
        return Promise.resolve({ rows: [{ database_name: 'restored_db', role_name: role }] });
      }
      if (sql.includes('clear_auth_sessions')) {
        return Promise.resolve({ rows: [{ cleared: counts.sessionsCleared ?? '0' }] });
      }
      if (sql.includes('clear_oidc_pending_logins')) {
        return Promise.resolve({ rows: [{ cleared: counts.loginsCleared ?? '0' }] });
      }
      if (sql.includes('app_private.oidc_pending_logins')) {
        return Promise.resolve({ rows: [{ remaining: counts.loginsRemaining ?? '0' }] });
      }
      return Promise.resolve({ rows: [{ remaining: counts.sessionsRemaining ?? '0' }] });
    }),
  };
  return { pool, queries };
}

describe('restore:clear-sessions (ADR-0080, ADR-0081)', () => {
  it('clears every session and every pending login as the owner and prints only separate counts', async () => {
    const { pool, queries } = fakePool('running_tracker_owner', { loginsCleared: '2', sessionsCleared: '3' });
    const lines: string[] = [];

    const code = await runClearSessionsCli({
      argv: [],
      createPool: () => pool as never,
      env: { RESTORE_DATABASE_URL: 'postgresql://running_tracker_owner:secret@127.0.0.1/restored_db' },
      log: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    // The ADR-0080 lines come first and are unchanged, so existing runbooks and scripts keep reading them.
    expect(lines).toEqual([
      'database: restored_db',
      'sessions cleared: 3',
      'sessions remaining: 0',
      'pending logins cleared: 2',
      'pending logins remaining: 0',
    ]);
    expect(queries.filter((sql) => sql.includes('()::text AS cleared'))).toEqual([
      'SELECT app_private.clear_auth_sessions()::text AS cleared',
      'SELECT app_private.clear_oidc_pending_logins()::text AS cleared',
    ]);
    expect(lines.join('\n')).not.toContain('secret');
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('refuses any role but the owner, and changes nothing', async () => {
    const { pool, queries } = fakePool('running_tracker_runtime');

    await expect(
      runClearSessionsCli({ argv: [], createPool: () => pool as never, env: { RESTORE_DATABASE_URL: 'postgresql://x' } }),
    ).rejects.toThrow('must authenticate as running_tracker_owner');
    expect(queries.some((sql) => sql.includes('clear_'))).toBe(false);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('fails, rather than reporting success, if any session or pending login remains', async () => {
    for (const counts of [{ sessionsRemaining: '1' }, { loginsRemaining: '1' }]) {
      const { pool } = fakePool('running_tracker_owner', counts);
      const lines: string[] = [];

      await expect(
        runClearSessionsCli({
          argv: [],
          createPool: () => pool as never,
          env: { RESTORE_DATABASE_URL: 'postgresql://x' },
          log: (line) => lines.push(line),
        }),
      ).rejects.toThrow('do not reopen the database');
      expect(lines).toEqual([]);
      expect(pool.end).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects an invalid count from either clearing function', async () => {
    for (const counts of [{ sessionsCleared: '-1' }, { loginsCleared: 'x' }]) {
      const { pool } = fakePool('running_tracker_owner', counts);
      await expect(
        runClearSessionsCli({ argv: [], createPool: () => pool as never, env: { RESTORE_DATABASE_URL: 'postgresql://x' } }),
      ).rejects.toThrow('returned an invalid result');
    }
  });

  it('requires the URL and takes no arguments', async () => {
    await expect(runClearSessionsCli({ argv: [], env: {} })).rejects.toThrow('RESTORE_DATABASE_URL is required');
    await expect(runClearSessionsCli({ argv: ['--all'], env: { RESTORE_DATABASE_URL: 'postgresql://x' } })).rejects.toThrow(
      'Usage:',
    );
  });
});

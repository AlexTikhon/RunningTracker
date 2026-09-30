import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { createLockSampler } from '../src/loadtest/load-lock-sampler.js';

describe('P11.4 lock sampler against real PostgreSQL', () => {
  let observer: Pool;
  let holder: Pool;
  let waiter: Pool;
  let apiLike: Pool;

  beforeAll(() => {
    const { migration } = loadIntegrationTestConfiguration();
    // The sampler's own connection is deliberately a different role from the sessions it watches.
    observer = new Pool({ connectionString: migration.connectionString, max: 1 });
    holder = new Pool({ application_name: 'running-tracker-api', connectionString: migration.connectionString, max: 1 });
    waiter = new Pool({ application_name: 'running-tracker-api', connectionString: migration.connectionString, max: 1 });
    apiLike = new Pool({ application_name: 'unrelated-tool', connectionString: migration.connectionString, max: 1 });
  });

  afterAll(async () => {
    await Promise.all([observer.end(), holder.end(), waiter.end(), apiLike.end()]);
  });

  it('sees a backend waiting for a row lock, and only the API application names', async () => {
    const table = 'lock_sampler_probe';
    await observer.query(`CREATE TABLE IF NOT EXISTS ${table} (id integer PRIMARY KEY)`);
    await observer.query(`INSERT INTO ${table} VALUES (1) ON CONFLICT DO NOTHING`);
    const heldBy = await holder.connect();
    const blockedClient = await waiter.connect();
    const unrelated = await apiLike.connect();
    let blocked: Promise<unknown> | undefined;
    try {
      await heldBy.query('BEGIN');
      await heldBy.query(`SELECT * FROM ${table} WHERE id = 1 FOR UPDATE`);
      await blockedClient.query('BEGIN');
      blocked = blockedClient.query(`SELECT * FROM ${table} WHERE id = 1 FOR SHARE`);
      await unrelated.query('BEGIN');
      await unrelated.query(`SELECT * FROM ${table} WHERE id = 1 FOR SHARE NOWAIT`).catch(() => undefined);

      const sample = createLockSampler(observer);
      let waits = await sample();
      for (let attempt = 0; attempt < 40 && waits.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        waits = await sample();
      }

      expect(waits.length).toBeGreaterThan(0);
      expect(waits.every(({ application }) => application === 'running-tracker-api')).toBe(true);
      expect(waits.reduce((sum, { waiting }) => sum + waiting, 0)).toBeGreaterThanOrEqual(1);

      await heldBy.query('ROLLBACK');
      await blocked;
      await blockedClient.query('ROLLBACK');
      expect(await sample()).toEqual([]);
    } finally {
      await unrelated.query('ROLLBACK').catch(() => undefined);
      await heldBy.query('ROLLBACK').catch(() => undefined);
      await blockedClient.query('ROLLBACK').catch(() => undefined);
      heldBy.release();
      blockedClient.release();
      unrelated.release();
      await observer.query(`DROP TABLE IF EXISTS ${table}`);
    }
  }, 30_000);
});

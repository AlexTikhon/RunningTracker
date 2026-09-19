import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://running_tracker:running_tracker_local@127.0.0.1:5433/running_tracker_test';

function assertTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.slice(1);
  if (!databaseName.endsWith('_test')) {
    throw new Error(`Integration tests require a database ending in _test, received ${databaseName}`);
  }
}

describe('PostGIS integration', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    assertTestDatabase(testDatabaseUrl);
    process.env.APP_ENV = 'test';
    process.env.DATABASE_URL = testDatabaseUrl;

    pool = new Pool({ connectionString: testDatabaseUrl, max: 2 });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('loads PostGIS in the isolated test database', async () => {
    const result = await pool.query<{ version: string }>(
      'SELECT PostGIS_Full_Version() AS version',
    );

    expect(result.rows[0]?.version).toContain('POSTGIS=');
  });

  it('reports the real database as ready', async () => {
    const server = app.getHttpServer() as Server;
    await request(server)
      .get('/api/health/ready')
      .expect(200)
      .expect({ checks: { database: 'up' }, status: 'ok' });
  });
});

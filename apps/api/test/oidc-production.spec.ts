import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { systemClock } from '../src/clock.js';
import { validateEnvironment } from '../src/config/environment.js';
import type { DatabasePool } from '../src/database/database.js';

const connect = vi.fn(() => Promise.reject(new Error('The database must not be used by these tests')));
const pool: DatabasePool = { connect };

/** A loopback port nothing listens on, so a connection attempt is refused at once. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

const production = {
  ALLOWED_ORIGINS: 'https://tracker.example',
  APP_ENV: 'production',
  DATABASE_URL: 'postgresql://running_tracker_runtime:password@127.0.0.1:5433/running_tracker',
  DELETION_JOURNAL_DIR: resolve('/var/lib/running-tracker/deletion-journal'),
  LIVE_TRACK_CURSOR_SIGNING_KEY: Buffer.from(
    'deployment-specific-live-track-key-material',
    'utf8',
  ).toString('base64url'),
  MAINTENANCE_DATABASE_URL:
    'postgresql://running_tracker_maintenance:password@127.0.0.1:5433/running_tracker',
  OIDC_CLIENT_ID: 'running-tracker',
  OIDC_CLIENT_SECRET: 'client-secret-value',
  OIDC_ISSUER_URL: 'https://idp.example/realm',
  OIDC_REDIRECT_URI: 'https://tracker.example/api/auth/callback',
};

describe('production sign-in surface', () => {
  const app = createApp({
    clock: systemClock,
    config: validateEnvironment(production),
    pool,
  });
  const unreachableProviderApp = async () =>
    createApp({
      clock: systemClock,
      config: validateEnvironment({
        ...production,
        OIDC_ISSUER_URL: `https://127.0.0.1:${await closedPort()}`,
      }),
      pool,
    });

  it('has no development login: POST /api/session does not exist', async () => {
    const response = await request(app)
      .post('/api/session')
      .set('Origin', 'https://tracker.example')
      .type('application/json')
      .send({ userId: '11111111-1111-4111-8111-111111111111' })
      .expect(404);

    expect(response.body).toMatchObject({ error: { code: 'ROUTE_NOT_FOUND' } });
  });

  it('serves the OIDC routes and reports an unreachable provider as 503 without touching the database', async () => {
    const response = await request(await unreachableProviderApp()).get('/api/auth/login').expect(503);

    expect(response.body).toMatchObject({ error: { code: 'IDENTITY_PROVIDER_UNAVAILABLE' } });
    expect(connect).not.toHaveBeenCalled();
  });

  it('keeps the session endpoint closed without a session', async () => {
    await request(app).get('/api/session').expect(401);
  });

  it('does not mount the OIDC routes when OIDC is not configured', async () => {
    const local = createApp({
      clock: systemClock,
      config: validateEnvironment({
        ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
        DATABASE_URL: production.DATABASE_URL,
        MAINTENANCE_DATABASE_URL: production.MAINTENANCE_DATABASE_URL,
      }),
      pool,
    });

    await request(local).get('/api/auth/login').expect(404);
  });
});

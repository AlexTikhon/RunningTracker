import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DatabaseService } from '../src/database/database.service.js';
import { HealthController } from '../src/health/health.controller.js';

describe('health endpoints', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('reports liveness and readiness when PostgreSQL responds', async () => {
    const ping = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: DatabaseService, useValue: { ping } }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    const server = app.getHttpServer() as Server;
    await request(server)
      .get('/api/health/live')
      .expect(200)
      .expect({ status: 'ok' });
    await request(server)
      .get('/api/health/ready')
      .expect(200)
      .expect({ checks: { database: 'up' }, status: 'ok' });
    expect(ping).toHaveBeenCalledOnce();
  });

  it('keeps liveness up while readiness reports a database failure', async () => {
    const ping = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('database unavailable'));
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: DatabaseService, useValue: { ping } }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    const server = app.getHttpServer() as Server;
    await request(server).get('/api/health/ready').expect(503);
    await request(server)
      .get('/api/health/live')
      .expect(200)
      .expect({ status: 'ok' });
  });
});

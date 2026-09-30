import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import { systemClock } from '../src/clock.js';
import {
  loadIntegrationTestConfiguration,
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import { createDatabasePool, createMaintenanceDatabasePool } from '../src/database/database.js';
import { createLiveSseHub } from '../src/live/live-sse.js';
import { PeriodicRunner } from '../src/maintenance/periodic-runner.js';
import { runSummaryPublicationBatch } from '../src/maintenance/run-summary-publication.js';
import { createApiMetrics } from '../src/observability/api-metrics.js';
import { startMetricsListener, type MetricsListener } from '../src/observability/metrics-server.js';
import { observePool, registerProcessMetrics } from '../src/observability/runtime-metrics.js';
import { planDataset, smokeProfile, type DatasetPlan } from '../src/loadtest/dataset-plan.js';
import type { ApiTarget } from '../src/loadtest/load-api-process.js';
import { cleanupLoadRuns, verifyDatasetMatchesPlan } from '../src/loadtest/load-dataset-check.js';
import { runLoadScenario, type ScenarioReport } from '../src/loadtest/load-orchestrator.js';
import { assertSafeResult } from '../src/loadtest/load-result.js';
import { planLoadScenario, workloadProfiles, type LoadScenarioPlan } from '../src/loadtest/load-scenario.js';
import { seedDataset } from '../src/loadtest/seed-dataset.js';

const origin = 'http://127.0.0.1:5173';
const seed = 9_002;

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

describe('P11.3 load scenario against the real API and PostgreSQL (smoke profile)', () => {
  let ownerPool: Pool;
  let runtimePool: Pool;
  let maintenancePool: Pool;
  let server: Server;
  let listener: MetricsListener;
  let summaryRunner: PeriodicRunner;
  let liveHub: ReturnType<typeof createLiveSseHub>;
  let processMetrics: ReturnType<typeof registerProcessMetrics>;
  let dataset: DatasetPlan;
  let plan: LoadScenarioPlan;
  let api: ApiTarget;
  let config: Environment;

  async function removeDataset(): Promise<void> {
    await ownerPool.query('DELETE FROM runs WHERE org_id = $1', [dataset.organizationId]);
    await ownerPool.query('DELETE FROM memberships WHERE org_id = $1', [dataset.organizationId]);
    await ownerPool.query('DELETE FROM organizations WHERE id = $1', [dataset.organizationId]);
    await ownerPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [dataset.users.map((user) => user.id)]);
  }

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    const asOf = utcMidnight(new Date());
    dataset = planDataset(smokeProfile, seed, asOf);
    const workload = workloadProfiles.smoke;
    if (!workload) {
      throw new Error('missing smoke workload');
    }
    plan = planLoadScenario(dataset, workload);

    ownerPool = new Pool({
      application_name: 'running-tracker-p113-owner',
      connectionString: integration.migration.connectionString,
      max: 2,
    });
    await removeDataset();
    await seedDataset(ownerPool, {
      allowedDatabaseSuffixes: ['_test'],
      asOf,
      profile: smokeProfile,
      requireEmptyDatabase: false,
      seed,
    });

    config = validateEnvironment({
      ALLOWED_ORIGINS: origin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      LIVE_SSE_POLL_INTERVAL_MS: '500',
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: dataset.users.map((user) => user.id).join(','),
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      SESSION_COOKIE_SECURE: 'false',
    });
    const metrics = createApiMetrics();
    processMetrics = registerProcessMetrics(metrics.registry);
    runtimePool = createDatabasePool(config);
    maintenancePool = createMaintenanceDatabasePool(config);
    observePool(runtimePool, { clock: systemClock, metrics, name: 'runtime' });
    const sessionManager = new SessionManager({
      clock: systemClock,
      store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
      ttlMs: config.SESSION_TTL_MS,
    });
    liveHub = createLiveSseHub({
      clock: systemClock,
      config,
      metrics: metrics.live,
      pool: runtimePool,
      sessionManager,
    });
    const app = createApp({
      clock: systemClock,
      config,
      liveConnections: liveHub,
      metrics,
      pool: runtimePool,
      sessionManager,
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    listener = await startMetricsListener(metrics.registry, { host: '127.0.0.1', port: 0 });
    summaryRunner = new PeriodicRunner({
      clock: systemClock,
      intervalMs: 500,
      metrics: metrics.maintenance,
      runOnce: () => runSummaryPublicationBatch(maintenancePool, systemClock, config.RUN_SUMMARY_CONCURRENCY),
      taskName: 'Run summary publication',
    });
    summaryRunner.start();

    const port = (server.address() as AddressInfo).port;
    const metricsPort = (listener.server.address() as AddressInfo).port;
    api = {
      baseUrl: `http://127.0.0.1:${port}`,
      configuration: {},
      logSummary: () => null,
      metricsUrl: `http://127.0.0.1:${metricsPort}/metrics`,
      origin,
      stop: () => Promise.resolve(),
    };
  });

  afterAll(async () => {
    summaryRunner?.stop();
    liveHub?.stop();
    processMetrics?.stop();
    await listener?.close();
    await new Promise<void>((resolve) => {
      server?.closeAllConnections();
      server?.close(() => resolve());
    });
    if (ownerPool) {
      await cleanupLoadRuns(ownerPool, plan);
      await removeDataset();
    }
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  it(
    'drives sessions, runs, SSE observers, offline batches, fresh points, tile bursts, and a published summary together',
    async () => {
      const { report, secrets } = await runLoadScenario({ api, drainMs: 4_000, plan, summaryWaitMs: 45_000 });

      expect(report.failure).toBeNull();
      expect(report.status).toBe('ok');

      // Ten-observer shape at smoke scale: one authenticated SSE stream per member, none dropped.
      expect(report.observers).toHaveLength(smokeProfile.users);
      for (const observer of report.observers) {
        expect(observer.connectedMs).not.toBeNull();
        expect(observer.closedUnexpectedly).toBe(false);
        expect(observer.protocolErrors).toBe(0);
        expect(observer.statesReceived).toBeGreaterThan(1);
      }

      // Offline catch-up: every member sends exactly `rounds` batches of exactly 100 points, all accepted.
      const catchup = report.http.ingestion.filter((sample) => sample.kind === 'catchup');
      expect(catchup).toHaveLength(smokeProfile.users * plan.workload.catchupRounds);
      for (const sample of catchup) {
        expect(sample).toMatchObject({ duplicateCount: 0, insertedCount: 100, pointCount: 100, status: 200 });
        expect(sample.unexpected).toBe(false);
      }
      const retries = report.http.ingestion.filter((sample) => sample.kind.startsWith('retry'));
      expect(retries.map((sample) => [sample.kind, sample.insertedCount, sample.duplicateCount]).sort()).toEqual([
        ['retry-exact', 0, 100],
        ['retry-overlap', 50, 50],
      ]);

      // Catch-up rounds overlap the tile bursts in time (the bounded overlap phase).
      const catchupStart = Math.min(...catchup.map((sample) => sample.startMs));
      const catchupEnd = Math.max(...catchup.map((sample) => sample.endMs));
      const overlappingTiles = report.http.tiles.filter(
        (tile) => tile.startMs < catchupEnd && tile.endMs > catchupStart,
      );
      expect(overlappingTiles.length).toBeGreaterThan(0);
      const roundOneStarts = catchup.filter((sample) => sample.round === 0).map((sample) => sample.startMs);
      const roundOneEnds = catchup.filter((sample) => sample.round === 0).map((sample) => sample.endMs);
      expect(Math.max(...roundOneStarts)).toBeLessThan(Math.min(...roundOneEnds));

      // Fresh measurements were observed through the real SSE stream.
      expect(report.freshPoints.length).toBeGreaterThan(0);
      expect(report.freshLatency.samples.length).toBeGreaterThan(0);
      expect(report.freshLatency.summaryMs.count).toBeGreaterThan(0);
      expect(report.freshLatency.summaryMs.p95).toBeGreaterThan(0);
      expect(report.freshLatency.unresolved).toBe(0);

      // Tiles: valid responses across several zoom levels, with repeats.
      const okTiles = report.http.tiles.filter((tile) => tile.outcome === 'ok');
      expect(okTiles.length).toBeGreaterThan(20);
      expect(new Set(okTiles.map((tile) => tile.zoom)).size).toBeGreaterThanOrEqual(3);
      expect(okTiles.some((tile) => tile.repeatOfEarlier)).toBe(true);
      expect(report.http.tiles.every((tile) => tile.outcome === 'ok' || tile.outcome === 'revision-changed')).toBe(true);

      // The real summary worker published the finished run, and the archive revision advanced with it.
      const publication = report.summaryPublication;
      expect(publication.timedOut).toBe(false);
      expect(publication.finishAckedMs).not.toBeNull();
      expect(publication.summaryVisibleMs).toBeGreaterThanOrEqual(publication.finishAckedMs ?? Infinity);
      expect(publication.archiveRevisionVisibleMs).toBeGreaterThanOrEqual(publication.finishAckedMs ?? Infinity);
      expect(BigInt(publication.archiveRevisionAfter ?? '0')).toBeGreaterThan(
        BigInt(publication.archiveRevisionBefore ?? '0'),
      );
      expect(publication.tileVerification?.changed).toBe(true);

      // Server metrics were scraped before and after and moved as expected.
      const insertedSeries = (series: NonNullable<ScenarioReport['metrics']['after']>): number =>
        series.find((entry) => entry.name === 'point_ingest_points_total' && entry.labels.kind === 'inserted')
          ?.value ?? 0;
      expect(report.metrics.before).not.toBeNull();
      expect(report.metrics.after).not.toBeNull();
      expect(insertedSeries(report.metrics.after ?? [])).toBeGreaterThan(
        insertedSeries(report.metrics.before ?? []),
      );

      // Nothing sensitive can be written from this report.
      expect(secrets.length).toBe(smokeProfile.users * 2);
      expect(() => assertSafeResult(report, secrets)).not.toThrow();
    },
    120_000,
  );

  it('leaves exactly the planned load runs behind and cleanup restores the dataset', async () => {
    const remaining = await ownerPool.query<{ count: string }>(
      'SELECT count(*) FROM runs WHERE org_id = $1',
      [dataset.organizationId],
    );
    expect(Number(remaining.rows[0]?.count)).toBe(dataset.runs.length + plan.activeRuns.length + 1);
    const active = await ownerPool.query<{ count: string }>(
      `SELECT count(*) FROM runs WHERE org_id = $1 AND status <> 'finished'`,
      [dataset.organizationId],
    );
    expect(Number(active.rows[0]?.count)).toBe(plan.activeRuns.length);

    await expect(verifyDatasetMatchesPlan(ownerPool, dataset)).rejects.toThrow();
    await expect(cleanupLoadRuns(ownerPool, plan)).resolves.toBe(plan.activeRuns.length + 1);
    await expect(verifyDatasetMatchesPlan(ownerPool, dataset)).resolves.toBeUndefined();
  });
});

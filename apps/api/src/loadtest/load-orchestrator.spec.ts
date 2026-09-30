import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { planDataset, smokeProfile } from './dataset-plan.js';
import type { ApiTarget } from './load-api-process.js';
import { sleep } from './load-concurrency.js';
import { runLoadScenario } from './load-orchestrator.js';
import { assertSafeResult } from './load-result.js';
import { planLoadScenario, workloadProfiles, type WorkloadProfile } from './load-scenario.js';

const origin = 'http://127.0.0.1:5173';
const runtimeCsrf = 'A'.repeat(43);
const dataset = planDataset(smokeProfile, 1, new Date('2026-09-30T00:00:00.000Z'));

type Fault = 'ingest-500' | 'ingest-hang' | 'ingest-reset' | 'none' | 'sse-drop';

interface Stats {
  ingestCalls: number;
  liveClosed: number;
  liveOpened: number;
  tileCalls: number;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

const runView = (runId: string, extra: Record<string, unknown> = {}) => ({
  controlRevision: '0',
  dataRevision: '0',
  finishedAt: null,
  rawState: 'available',
  runId,
  startedAt: '2026-09-30T00:00:00.000Z',
  status: 'recording',
  summary: null,
  ...extra,
});

describe('runLoadScenario failure handling', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function startFake(fault: Fault): Promise<{ api: ApiTarget; server: Server; stats: Stats }> {
    const stats: Stats = { ingestCalls: 0, liveClosed: 0, liveOpened: 0, tileCalls: 0 };
    const storedSequences = new Map<string, Set<string>>();
    const handler = (request: IncomingMessage, response: ServerResponse): void => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
        if (url.pathname === '/api/session') {
          response.setHeader('set-cookie', 'running_tracker_session=FAKESESSIONCOOKIE0123456789; HttpOnly');
          json(response, 201, {
            csrf: { headerName: 'x-csrf-token', token: runtimeCsrf },
            expiresAt: '2026-09-30T08:00:00.000Z',
            identity: { userId: body.userId },
          });
        } else if (url.pathname.endsWith('/archive/metadata')) {
          json(response, 200, {
            archiveRevision: '1',
            filter: { from: url.searchParams.get('from'), to: url.searchParams.get('to') },
            maxzoom: 16,
            minzoom: 8,
            sourceLayer: 'runs',
            tiles: [`/api/orgs/${dataset.organizationId}/tiles/runs/{z}/{x}/{y}.mvt?revision=1&from=a&to=b`],
          });
        } else if (url.pathname.includes('/tiles/runs/')) {
          stats.tileCalls += 1;
          response.statusCode = 200;
          response.end(Buffer.alloc(32));
        } else if (url.pathname.endsWith('/live')) {
          stats.liveOpened += 1;
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          let sequence = 0;
          const emit = (): void => {
            response.write(
              `event: live.state\ndata: ${JSON.stringify({
                algorithmVersion: 'v1',
                runs: [],
                sequence: sequence++,
                serverTime: '2026-09-30T00:00:00.000Z',
                streamId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
              })}\n\n`,
            );
          };
          emit();
          const timer = setInterval(emit, 50);
          response.on('close', () => {
            clearInterval(timer);
            stats.liveClosed += 1;
          });
          if (fault === 'sse-drop') {
            setTimeout(() => response.end(), 400);
          }
        } else if (request.method === 'GET' && url.pathname.includes('/runs/')) {
          json(response, 200, runView(url.pathname.split('/').at(-1) ?? ''));
        } else if (request.method === 'PUT' && url.pathname.includes('/shares/')) {
          json(response, 200, { canReadHistory: true, canReadLive: true });
        } else if (request.method === 'PUT') {
          json(response, 201, runView(url.pathname.split('/').at(-1) ?? ''));
        } else if (url.pathname.endsWith('/points')) {
          stats.ingestCalls += 1;
          if (stats.ingestCalls > 1 && fault === 'ingest-500') {
            json(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'boom', requestId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' } });
          } else if (stats.ingestCalls > 1 && fault === 'ingest-hang') {
            // never answers
          } else if (stats.ingestCalls > 1 && fault === 'ingest-reset') {
            request.socket.destroy();
          } else {
            const known = storedSequences.get(url.pathname) ?? new Set<string>();
            storedSequences.set(url.pathname, known);
            let inserted = 0;
            let duplicate = 0;
            for (const point of body.points as { seq: string }[]) {
              if (known.has(point.seq)) {
                duplicate += 1;
              } else {
                known.add(point.seq);
                inserted += 1;
              }
            }
            json(response, 200, { dataRevision: '2', duplicateCount: duplicate, insertedCount: inserted });
          }
        } else if (url.pathname.endsWith('/commands')) {
          json(response, 200, {
            commandId: body.commandId,
            controlRevision: '1',
            dataRevision: '2',
            finishedAt: '2026-09-30T00:01:00.000Z',
            status: 'finished',
          });
        } else {
          json(response, 404, { error: { code: 'ROUTE_NOT_FOUND', message: 'x', requestId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' } });
        }
      });
    };
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
      api: {
        baseUrl: `http://127.0.0.1:${port}`,
        configuration: {},
        logSummary: () => null,
        metricsUrl: null,
        origin,
        stop: () => Promise.resolve(),
      },
      server,
      stats,
    };
  }

  function planWith(overrides: Partial<WorkloadProfile>) {
    const base = workloadProfiles.smoke;
    if (!base) {
      throw new Error('missing smoke workload');
    }
    return planLoadScenario(dataset, { ...base, ...overrides });
  }

  it('stops all load, closes every observer stream, and reports an unexpected ingestion response', async () => {
    const { api, server, stats } = await startFake('ingest-500');
    const { report, secrets } = await runLoadScenario({ api, plan: planWith({}), summaryWaitMs: 2_000 });

    expect(report.status).toBe('failed');
    expect(report.failure).toMatchObject({ kind: 'unexpected-response', phase: 'catchup' });
    expect(report.http.ingestion.some((sample) => sample.status === 500 && sample.unexpected)).toBe(true);
    expect(report.freshPoints).toEqual([]);

    // Every observer stream was closed by the client, and no new tile load starts once the run is over.
    await sleep(300);
    expect(stats.liveOpened).toBe(smokeProfile.users);
    expect(stats.liveClosed).toBe(smokeProfile.users);
    const tilesAtEnd = stats.tileCalls;
    await sleep(300);
    expect(stats.tileCalls).toBe(tilesAtEnd);
    await new Promise<void>((resolve) => server.getConnections((_, count) => {
      expect(count).toBe(0);
      resolve();
    }));

    // A partial report is still safe to write.
    expect(secrets).toContain(runtimeCsrf);
    expect(() => assertSafeResult(report, secrets)).not.toThrow();
  });

  it('classifies a hung ingestion request as a timeout', async () => {
    const { api } = await startFake('ingest-hang');
    const { report } = await runLoadScenario({ api, plan: planWith({ requestTimeoutMs: 300 }), summaryWaitMs: 2_000 });
    expect(report.failure).toMatchObject({ kind: 'timeout' });
    expect(report.status).toBe('failed');
  });

  it('classifies a reset connection as a transport failure', async () => {
    const { api } = await startFake('ingest-reset');
    const { report } = await runLoadScenario({ api, plan: planWith({}), summaryWaitMs: 2_000 });
    expect(report.failure).toMatchObject({ kind: 'transport' });
  });

  it('fails as an SSE failure when an observer stream drops, and records which one', async () => {
    const { api, stats } = await startFake('sse-drop');
    const { report } = await runLoadScenario({
      api,
      plan: planWith({ freshMinDurationMs: 60_000 }),
      summaryWaitMs: 60_000,
    });
    expect(report.failure?.kind).toBe('sse');
    expect(report.observers.some((observer) => observer.closedUnexpectedly)).toBe(true);
    await sleep(200);
    expect(stats.liveClosed).toBe(smokeProfile.users);
  }, 30_000);

  it('samples lock waits on the scenario clock during the concurrent window without affecting the run', async () => {
    const { api } = await startFake('none');
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('user interrupt')), 1_500);
    let calls = 0;
    const { report } = await runLoadScenario({
      api,
      plan: planWith({ freshMinDurationMs: 60_000, lockSampleIntervalMs: 100 }),
      sampleLocks: () => {
        calls += 1;
        return Promise.resolve(calls % 2 === 0 ? [{ application: 'running-tracker-api', locktype: 'transactionid', waiting: calls }] : []);
      },
      signal: controller.signal,
      summaryWaitMs: 60_000,
    });

    expect(report.lockSamples.length).toBeGreaterThanOrEqual(3);
    const times = report.lockSamples.map(({ atMs }) => atMs);
    expect(times).toEqual([...times].sort((left, right) => left - right));
    expect(report.lockSamples.some(({ waits }) => waits.length > 0)).toBe(true);
    // The only failure is the deliberate cancellation, not the sampler.
    expect(report.failure?.message).toMatch(/cancelled/u);
    expect(report.warnings.some((warning) => /lock sampling/iu.test(warning))).toBe(false);
  }, 30_000);

  it('records a failing lock sampler as a warning, stops sampling, and keeps the run going', async () => {
    const { api } = await startFake('none');
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('user interrupt')), 1_500);
    let calls = 0;
    const { report } = await runLoadScenario({
      api,
      plan: planWith({ freshMinDurationMs: 60_000, lockSampleIntervalMs: 100 }),
      sampleLocks: () => {
        calls += 1;
        return calls < 3 ? Promise.resolve([]) : Promise.reject(new Error('permission denied for secret-relation'));
      },
      signal: controller.signal,
      summaryWaitMs: 60_000,
    });

    expect(report.lockSamples).toHaveLength(2);
    expect(calls).toBe(3);
    expect(report.warnings.some((warning) => /lock sampling stopped/iu.test(warning))).toBe(true);
    expect(JSON.stringify(report.warnings)).not.toContain('secret-relation');
    expect(report.failure?.message).toMatch(/cancelled/u);
  }, 30_000);

  it('sends no tile burst load at all when the workload has zero tile streams', async () => {
    const { api, stats } = await startFake('none');
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('user interrupt')), 1_500);
    const { report } = await runLoadScenario({
      api,
      plan: planWith({ freshMinDurationMs: 60_000, tileStreams: 0 }),
      signal: controller.signal,
      summaryWaitMs: 60_000,
    });

    expect(report.workload.tileBursts).toBe(0);
    expect(report.workload.tileRequests).toBe(0);
    expect(report.http.tiles).toEqual([]);
    expect(report.http.ingestion.length).toBeGreaterThan(0);
    // Only the baseline and verification tile reads may reach the server.
    expect(stats.tileCalls).toBeLessThanOrEqual(2);
  }, 30_000);

  it('can be cancelled from outside and still returns a partial report', async () => {
    const { api, stats } = await startFake('none');
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('user interrupt')), 700);
    const { report } = await runLoadScenario({
      api,
      plan: planWith({ freshMinDurationMs: 60_000 }),
      signal: controller.signal,
      summaryWaitMs: 60_000,
    });
    expect(report.status).toBe('failed');
    expect(report.failure?.message).toMatch(/cancelled/u);
    await sleep(200);
    expect(stats.liveClosed).toBe(smokeProfile.users);
  }, 30_000);
});

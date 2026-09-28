import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect as connectHttp2, constants as http2Constants } from 'node:http2';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { Pool } from 'pg';

const repositoryRoot = resolve(import.meta.dirname, '..');
const origin = 'https://localhost:8443';
const expectedUserId = '88888888-8888-4888-8888-888888888888';
const fixture = {
  orgId: '88888888-8888-4888-8888-000000000001',
  runId: '88888888-8888-4888-8888-000000000002',
};
const composeFiles = [
  '-f',
  'infra/compose/docker-compose.yml',
  '-f',
  'infra/compose/docker-compose.transport.yml',
];

function loadLocalEnvironment() {
  let fileValues = {};
  for (const name of ['.env', '.env.example']) {
    try {
      fileValues = parseEnv(readFileSync(resolve(repositoryRoot, name), 'utf8'));
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return { ...fileValues, ...process.env };
}

function headerValue(headers, name) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function openHttp2Client(certificate) {
  const client = connectHttp2(origin, {
    ca: certificate,
    rejectUnauthorized: true,
    servername: 'localhost',
  });
  await new Promise((resolveConnect, reject) => {
    client.once('connect', resolveConnect);
    client.once('error', reject);
  });
  assert.equal(client.socket.alpnProtocol, 'h2', 'TLS ALPN did not negotiate HTTP/2');
  return client;
}

function request(client, options, body = '') {
  return new Promise((resolveRequest, reject) => {
    const stream = client.request(
      {
        [http2Constants.HTTP2_HEADER_METHOD]: options.method ?? 'GET',
        [http2Constants.HTTP2_HEADER_PATH]: options.path,
        ...(options.headers ?? {}),
      },
      { endStream: body.length === 0 },
    );
    const chunks = [];
    let responseHeaders;
    stream.on('response', (headers) => {
      responseHeaders = headers;
    });
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      resolveRequest({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: responseHeaders,
        status: Number(responseHeaders?.[http2Constants.HTTP2_HEADER_STATUS]),
      });
    });
    stream.on('error', reject);
    if (body.length > 0) stream.end(body);
  });
}

function openSse(client, cookie, orgId) {
  const openedAt = performance.now();
  const stream = client.request({
    [http2Constants.HTTP2_HEADER_METHOD]: 'GET',
    [http2Constants.HTTP2_HEADER_PATH]: `/api/orgs/${orgId}/live`,
    accept: 'text/event-stream',
    cookie,
  });
  const frames = [];
  const waiters = new Set();
  let buffer = '';
  let ended = false;
  let firstFrameMs;
  let heartbeatFrameMs;
  let responseHeaders;

  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };

  stream.on('response', (headers) => {
    responseHeaders = headers;
    wake();
  });
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk.replaceAll('\r\n', '\n');
    let end = buffer.indexOf('\n\n');
    while (end >= 0) {
      if (firstFrameMs === undefined) firstFrameMs = performance.now() - openedAt;
      const frame = buffer.slice(0, end);
      frames.push(frame);
      if (heartbeatFrameMs === undefined && frame.startsWith(': heartbeat')) {
        heartbeatFrameMs = performance.now() - openedAt;
      }
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf('\n\n');
    }
    wake();
  });
  stream.on('end', () => {
    ended = true;
    wake();
  });
  stream.on('error', () => {
    ended = true;
    wake();
  });

  async function waitUntil(predicate, timeoutMs, description) {
    const deadline = performance.now() + timeoutMs;
    while (true) {
      const value = predicate();
      if (value !== undefined && value !== false) return value;
      if (ended && description !== 'stream disconnect') {
        throw new Error(`SSE ended while waiting for ${description}`);
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${description}`);
      await new Promise((resolveWait) => {
        const timeout = setTimeout(() => {
          waiters.delete(onWake);
          resolveWait();
        }, Math.min(remaining, 250));
        const onWake = () => {
          clearTimeout(timeout);
          waiters.delete(onWake);
          resolveWait();
        };
        waiters.add(onWake);
      });
    }
  }

  const states = () =>
    frames.flatMap((frame) => {
      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) return [];
      return [JSON.parse(dataLine.slice('data: '.length))];
    });

  return {
    close: () => stream.close(),
    frames,
    get firstFrameMs() {
      return firstFrameMs;
    },
    get headers() {
      return responseHeaders;
    },
    get heartbeatFrameMs() {
      return heartbeatFrameMs;
    },
    get lifetimeMs() {
      return performance.now() - openedAt;
    },
    states,
    waitForDisconnect: (timeoutMs) =>
      waitUntil(() => ended, timeoutMs, 'stream disconnect'),
    waitForHeaders: (timeoutMs) =>
      waitUntil(() => responseHeaders, timeoutMs, 'SSE response headers'),
    waitForHeartbeat: (timeoutMs) =>
      waitUntil(
        () => frames.find((frame) => frame.startsWith(': heartbeat')),
        timeoutMs,
        '15-second heartbeat',
      ),
    waitForLifetime: (targetMs) =>
      waitUntil(
        () => (performance.now() - openedAt >= targetMs ? true : undefined),
        targetMs + 5_000,
        `${targetMs} ms stream lifetime`,
      ),
    waitForState: (predicate, timeoutMs) =>
      waitUntil(() => states().find(predicate), timeoutMs, 'matching live.state'),
  };
}

async function createSession(client) {
  const body = JSON.stringify({ userId: expectedUserId });
  const response = await request(
    client,
    {
      headers: {
        'content-length': Buffer.byteLength(body),
        'content-type': 'application/json',
        origin,
      },
      method: 'POST',
      path: '/api/session',
    },
    body,
  );
  assert.equal(response.status, 201, response.body);
  const setCookie = response.headers['set-cookie'];
  const cookieHeader = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0];
  assert.ok(cookieHeader, 'Session response did not set a cookie');
  assert.match(Array.isArray(setCookie) ? setCookie[0] : setCookie, /; Secure(?:;|$)/u);
  assert.match(Array.isArray(setCookie) ? setCookie[0] : setCookie, /; HttpOnly(?:;|$)/u);
  return cookieHeader;
}

async function waitForReady(client) {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    try {
      const response = await request(client, { path: '/api/health/ready' });
      if (response.status === 200) return;
    } catch {
      // The proxy remains available while the upstream container restarts.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error('API did not become ready through the proxy after restart');
}

async function removeFixture(pool) {
  await pool.query('DELETE FROM runs WHERE org_id = $1 AND id = $2', [fixture.orgId, fixture.runId]);
  await pool.query('DELETE FROM memberships WHERE org_id = $1 AND user_id = $2', [
    fixture.orgId,
    expectedUserId,
  ]);
  await pool.query('DELETE FROM organizations WHERE id = $1', [fixture.orgId]);
  await pool.query('DELETE FROM users WHERE id = $1', [expectedUserId]);
}

async function createFixture(pool) {
  await removeFixture(pool);
  await pool.query('BEGIN');
  try {
    await pool.query(
      `INSERT INTO users (id, external_identity) VALUES ($1, 'p08-5-transport-verification')`,
      [expectedUserId],
    );
    await pool.query('INSERT INTO organizations (id) VALUES ($1)', [fixture.orgId]);
    await pool.query(
      `INSERT INTO memberships (org_id, user_id, role, active)
       VALUES ($1, $2, 'coach', true)`,
      [fixture.orgId, expectedUserId],
    );
    await pool.query(
      `INSERT INTO runs (org_id, id, user_id, status, started_at, created_at)
       VALUES ($1, $2, $3, 'recording', clock_timestamp(), clock_timestamp())`,
      [fixture.orgId, fixture.runId, expectedUserId],
    );
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

async function commitPoint(pool, revision) {
  await pool.query('BEGIN');
  try {
    await pool.query(
      `INSERT INTO run_points (
         org_id, run_id, seq, segment_id, recorded_at, received_at,
         geom, accuracy_m, ingested_revision
       ) VALUES (
         $1, $2, $3::bigint, 0, clock_timestamp(), clock_timestamp(),
         public.ST_SetSRID(
           public.ST_MakePoint(21.0 + $3::bigint::double precision / 100000, 52.0),
           4326
         ),
         5.0, $3::bigint
       )`,
      [fixture.orgId, fixture.runId, revision],
    );
    await pool.query(
      'UPDATE runs SET data_revision = $3::bigint WHERE org_id = $1 AND id = $2',
      [fixture.orgId, fixture.runId, revision],
    );
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

function percentile(values, percentileValue) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil((percentileValue / 100) * ordered.length) - 1];
}

const environment = loadLocalEnvironment();
assert.ok(environment.TEST_MIGRATION_DATABASE_URL, 'TEST_MIGRATION_DATABASE_URL is required');
assert.ok(environment.TEST_BOOTSTRAP_DATABASE_URL, 'TEST_BOOTSTRAP_DATABASE_URL is required');

const ownerPool = new Pool({
  application_name: 'p08-5-transport-fixture',
  connectionString: environment.TEST_MIGRATION_DATABASE_URL,
  max: 1,
});
const observerPool = new Pool({
  application_name: 'p08-5-transport-observer',
  connectionString: environment.TEST_BOOTSTRAP_DATABASE_URL,
  max: 1,
});
const certificate = readFileSync(resolve(repositoryRoot, '.local', 'tls', 'localhost-cert.pem'));
let client;

try {
  await createFixture(ownerPool);
  client = await openHttp2Client(certificate);

  const health = await request(client, { path: '/api/health/live' });
  assert.equal(health.status, 200, health.body);
  assert.deepEqual(JSON.parse(health.body), { status: 'ok' });
  const web = await request(client, { path: '/' });
  assert.equal(web.status, 200);
  assert.match(headerValue(web.headers, 'content-type'), /^text\/html/u);
  let untrustedHostRejected = false;
  try {
    const untrustedHost = await request(client, {
      headers: { [http2Constants.HTTP2_HEADER_AUTHORITY]: 'untrusted.invalid' },
      path: '/api/health/live',
    });
    untrustedHostRejected = untrustedHost.status >= 400 || untrustedHost.status === 0;
  } catch {
    untrustedHostRejected = true;
  }
  assert.equal(untrustedHostRejected, true, 'Proxy accepted an unconfigured Host');

  const cookie = await createSession(client);
  const sse = openSse(client, cookie, fixture.orgId);
  const headers = await sse.waitForHeaders(5_000);
  assert.equal(Number(headers[http2Constants.HTTP2_HEADER_STATUS]), 200);
  assert.equal(headerValue(headers, 'content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(headerValue(headers, 'cache-control'), 'private, no-store');
  assert.equal(headerValue(headers, 'x-accel-buffering'), 'no');
  assert.equal(headerValue(headers, 'content-encoding'), undefined);
  const first = await sse.waitForState((state) => state.sequence === 0, 5_000);
  assert.ok(sse.firstFrameMs < 3_000, `Initial SSE frame took ${sse.firstFrameMs} ms`);

  const activity = await observerPool.query(
    `SELECT state, count(*)::integer AS count
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND application_name = 'running-tracker-api'
     GROUP BY state`,
  );
  const idleInTransaction = activity.rows.find(({ state }) => state === 'idle in transaction');
  assert.equal(idleInTransaction?.count ?? 0, 0, 'SSE retained an idle database transaction');

  const latencyMs = [];
  for (let revision = 1; revision <= 8; revision += 1) {
    await commitPoint(ownerPool, revision);
    const committedAt = performance.now();
    await sse.waitForState(
      (state) =>
        state.runs?.some(
          (run) => run.runId === fixture.runId && run.dataRevision === String(revision),
        ),
      5_000,
    );
    latencyMs.push(performance.now() - committedAt);
  }

  await sse.waitForHeartbeat(20_000);
  await sse.waitForLifetime(77_000);
  assert.ok(sse.lifetimeMs > 75_000, 'SSE did not remain open beyond proxy_read_timeout');
  const statesBeforeRestart = sse.states();
  assert.ok(statesBeforeRestart.length > 1);
  assert.equal(new Set(statesBeforeRestart.map(({ streamId }) => streamId)).size, 1);
  for (let index = 1; index < statesBeforeRestart.length; index += 1) {
    assert.ok(statesBeforeRestart[index].sequence > statesBeforeRestart[index - 1].sequence);
  }

  execFileSync('docker', ['compose', ...composeFiles, 'restart', 'api'], {
    cwd: repositoryRoot,
    stdio: 'inherit',
  });
  await sse.waitForDisconnect(15_000);
  await waitForReady(client);

  const replacementCookie = await createSession(client);
  const replacementSse = openSse(client, replacementCookie, fixture.orgId);
  const replacement = await replacementSse.waitForState((state) => state.sequence === 0, 5_000);
  assert.notEqual(replacement.streamId, first.streamId);
  replacementSse.close();

  const result = {
    apiHealthStatus: health.status,
    databaseActivity: activity.rows,
    firstFrameMs: Math.round(sse.firstFrameMs),
    heartbeatObservedAfterMs: Math.round(sse.heartbeatFrameMs),
    hostAllowlistRejectedUntrustedAuthority: untrustedHostRejected,
    http2Alpn: client.socket.alpnProtocol,
    latency: {
      p50Ms: Math.round(percentile(latencyMs, 50)),
      p95Ms: Math.round(percentile(latencyMs, 95)),
      samples: latencyMs.length,
      valuesMs: latencyMs.map(Math.round),
    },
    reconnect: {
      firstSequence: replacement.sequence,
      newStreamId: replacement.streamId !== first.streamId,
    },
    streamLifetimeBeforeRestartMs: Math.round(sse.lifetimeMs),
    sseHeaders: {
      cacheControl: headerValue(headers, 'cache-control'),
      contentType: headerValue(headers, 'content-type'),
      xAccelBuffering: headerValue(headers, 'x-accel-buffering'),
    },
  };
  console.info(JSON.stringify(result, null, 2));
} finally {
  client?.close();
  await removeFixture(ownerPool).catch(() => undefined);
  await Promise.allSettled([ownerPool.end(), observerPool.end()]);
}

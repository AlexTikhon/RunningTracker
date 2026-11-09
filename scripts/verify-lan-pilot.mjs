// npm run pilot:verify: behavioral checks of a running iPhone LAN pilot (docs/runbooks/iphone-lan-pilot.md), through its
// real HTTPS proxy on the configured private address, with full certificate validation against the pilot's own
// authority (Node's TLS: chain, name constraints, address/name, validity). Nothing here disables verification.
//
// It writes one check-in with a random marker as the demo runner and deletes it again, opens and closes sessions for
// the two demo people, and sends a few refused requests. It reads the normal development and test databases only to
// show the marker is absent there. It needs the pilot running (npm run pilot:up) and Docker.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as connectHttp2, constants as http2Constants } from 'node:http2';
import { request as httpsRequest } from 'node:https';
import { resolve } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { parseEnv } from 'node:util';

import pg from 'pg';

import { demoIds } from './demo-plan.mjs';
import { composeArguments, parsePilotEnv, pilotDatabase, pilotPaths, pilotProject, pilotVolume } from './lan-pilot-config.mjs';
import { certificateFiles } from './lan-pilot-tls.mjs';
import { correlate, countExposed, createCanary, misroutedErrorLineCount, unsanitizedLineCount } from './proxy-log-boundary.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const paths = pilotPaths(repositoryRoot);
const settings = parsePilotEnv(readFileSync(paths.env, 'utf8'));
const files = certificateFiles(paths);
const pilotCa = readFileSync(files.caCert);
const { origin } = settings;
const authority = settings.port === 443 ? settings.host : `${settings.host}:${settings.port}`;
const caSubject = new X509Certificate(pilotCa).subject;
const results = {};

// One request on a fresh TLS connection (agent: false), so every call is validated from the handshake. The socket
// always goes to the bind address; the identity checked is the configured host (`expect`, default: the host itself).
// `ca: null` trusts only Node's default roots, which do not include the pilot authority.
function call(method, path, { body, ca = pilotCa, expect = settings.host, headers = {} } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolveCall, reject) => {
    const outgoing = httpsRequest(
      {
        agent: false,
        ...(ca === null ? {} : { ca }),
        headers: {
          host: authority,
          ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload), 'content-type': 'application/json' }),
          ...headers,
        },
        host: settings.bindAddress,
        method,
        path,
        port: settings.port,
        rejectUnauthorized: true,
        // Node sends no SNI for an address, as Safari does; a name is sent and checked when one is configured.
        servername: /^[\d.]+$/u.test(expect) ? '' : expect,
        checkServerIdentity: (_host, certificate) => tlsIdentity(expect, certificate),
        timeout: 10_000,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolveCall({
            authorized: response.socket.authorized,
            certificate: response.socket.getPeerCertificate(),
            headers: response.headers,
            json,
            protocol: response.socket.getProtocol(),
            status: response.statusCode,
            text,
          });
        });
      },
    );
    outgoing.on('timeout', () => outgoing.destroy(new Error(`${method} ${path} timed out`)));
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}

// Node's own host/address check, against the name the caller expects rather than the socket's address.
function tlsIdentity(expected, certificate) {
  return checkServerIdentity(expected, certificate);
}

async function refusedHandshake(options) {
  try {
    await call('GET', '/api/health/live', options);
    return null;
  } catch (error) {
    return error.code ?? error.message;
  }
}

function cookieOf(response) {
  const header = [response.headers['set-cookie'] ?? []].flat().find((value) => value.startsWith('running_tracker_session='));
  assert.ok(header, 'no session cookie');
  return header;
}

async function signIn(userId) {
  const created = await call('POST', '/api/session', { body: { userId }, headers: { origin } });
  assert.equal(created.status, 201, created.text);
  const setCookie = cookieOf(created);
  const cookie = setCookie.split(';', 1)[0];
  const session = await call('GET', '/api/session', { headers: { cookie } });
  assert.equal(session.status, 200, session.text);
  assert.equal(session.json.identity.userId, userId);
  return { cookie, csrf: session.json.csrf.token, setCookie };
}

function docker(args) {
  return execFileSync('docker', args, { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 });
}

function inspect(service) {
  const id = docker([...composeArguments(paths), 'ps', '--quiet', service]).trim();
  assert.ok(id, `the pilot ${service} container is not running`);
  return JSON.parse(docker(['inspect', id]))[0];
}

function pilotSql(sql) {
  return docker([
    ...composeArguments(paths), 'exec', '-T', 'postgres',
    'psql', '--no-psqlrc', '--tuples-only', '--no-align', '-U', 'running_tracker_admin', '-d', pilotDatabase, '-c', sql,
  ]).trim();
}

function loadLocalEnvironment() {
  for (const name of ['.env', '.env.example']) {
    try {
      return { ...parseEnv(readFileSync(resolve(repositoryRoot, name), 'utf8')), ...process.env };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return { ...process.env };
}

async function countInNormalDatabase(url, marker) {
  const client = new pg.Client({ application_name: 'running-tracker-lan-pilot-verify', connectionString: url, connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
  } catch {
    return 'unreachable';
  }
  try {
    const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
    const { rows } = await client.query('SELECT count(*)::integer AS count FROM daily_metrics WHERE note = $1', [marker]);
    return { count: rows[0].count, database };
  } finally {
    await client.end();
  }
}

function localDate(daysAgo) {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

function openSse(cookie) {
  return new Promise((resolveSse, reject) => {
    const client = connectHttp2(`https://${settings.bindAddress}:${settings.port}`, {
      ca: pilotCa,
      checkServerIdentity: (_host, certificate) => tlsIdentity(settings.host, certificate),
      rejectUnauthorized: true,
      servername: settings.hostname ?? '',
    });
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('no SSE frame within 5 s'));
    }, 5_000);
    client.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    client.once('connect', () => {
      const alpn = client.socket.alpnProtocol;
      const stream = client.request({
        [http2Constants.HTTP2_HEADER_AUTHORITY]: authority,
        [http2Constants.HTTP2_HEADER_PATH]: `/api/orgs/${demoIds.organization}/live`,
        accept: 'text/event-stream',
        cookie,
      });
      let headers;
      let buffer = '';
      stream.on('response', (value) => {
        headers = value;
      });
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.includes('\n\n')) {
          clearTimeout(timer);
          stream.close();
          client.close();
          resolveSse({ alpn, firstFrame: buffer.slice(0, buffer.indexOf('\n\n')), headers });
        }
      });
    });
  });
}

function sendOversized(path) {
  // A 256 KiB body over the 128 KiB limit: nginx refuses it itself, so its error log records the request line.
  const body = 'x'.repeat(256 * 1024);
  return call('POST', path, { headers: { 'content-length': body.length, 'content-type': 'application/octet-stream', origin } }).catch(
    () => ({ status: undefined }),
  );
}

const marker = `pilot-verify-${randomBytes(8).toString('hex')}`;
const checkInDate = localDate(45);
const checkInPath = `/api/orgs/${demoIds.organization}/daily-metrics/${checkInDate}`;
let runner;
let coach;

try {
  // 1. The environment as Docker runs it: one published port, on the configured address; nothing else published.
  const proxy = inspect('proxy');
  const api = inspect('api');
  const postgres = inspect('postgres');
  const published = (container) =>
    Object.entries(container.NetworkSettings.Ports ?? {}).flatMap(([port, bindings]) => (bindings ?? []).map((binding) => `${binding.HostIp}:${binding.HostPort}->${port}`));
  assert.deepEqual(published(proxy), [`${settings.bindAddress}:${settings.port}->443/tcp`]);
  assert.deepEqual(published(api), []);
  assert.deepEqual(published(postgres), []);
  const postgresNetworks = Object.keys(postgres.NetworkSettings.Networks);
  assert.deepEqual(postgresNetworks, [`${pilotProject}_data`]);
  assert.equal(JSON.parse(docker(['network', 'inspect', `${pilotProject}_data`]))[0].Internal, true);
  assert.deepEqual(postgres.Mounts.filter((mount) => mount.Type === 'volume').map((mount) => mount.Name), [pilotVolume]);
  assert.deepEqual(proxy.Mounts.map((mount) => `${mount.Destination}:${mount.RW ? 'rw' : 'ro'}`), ['/etc/nginx/tls:ro']);
  const developmentPostgres = spawnSync('docker', ['ps', '--quiet', '--filter', 'label=com.docker.compose.project=running-tracker', '--filter', 'label=com.docker.compose.service=postgres'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(!developmentPostgres.split('\n').includes(postgres.Id.slice(0, 12)), 'the pilot shares the development PostgreSQL container');
  results.environment = { apiPublished: 0, postgresNetworks, postgresPublished: 0, postgresVolume: pilotVolume, proxyPublished: published(proxy) };

  // 2. TLS with the pilot authority only: a validated chain for the configured identity.
  const health = await call('GET', '/api/health/ready');
  assert.equal(health.authorized, true);
  assert.equal(health.status, 200, health.text);
  assert.equal(health.json.checks.database, 'up');
  assert.equal(health.certificate.issuer.CN, new X509Certificate(pilotCa).subject.match(/CN=([^\n]+)/u)[1]);
  const refusedWithoutPilotCa = await refusedHandshake({ ca: null });
  assert.match(String(refusedWithoutPilotCa), /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED|UNABLE_TO_GET_ISSUER/u);
  const refusedOtherName = await refusedHandshake({ expect: 'other-host.local' });
  assert.match(String(refusedOtherName), /ERR_TLS_CERT_ALTNAME_INVALID/u);
  const plainHttp = await new Promise((resolvePlain) => {
    const outgoing = httpRequest({ host: settings.bindAddress, path: '/', port: settings.port, timeout: 5_000 }, (response) => {
      response.resume();
      resolvePlain(response.statusCode);
    });
    outgoing.on('error', () => resolvePlain('refused'));
    outgoing.end();
  });
  assert.notEqual(plainHttp, 200, 'plain HTTP must not serve the app');
  const loopback = await new Promise((resolveLoopback) => {
    const outgoing = httpsRequest(
      { agent: false, ca: pilotCa, host: '127.0.0.1', path: '/api/health/live', port: settings.port, rejectUnauthorized: true, servername: '', timeout: 5_000, checkServerIdentity: (_host, certificate) => tlsIdentity(settings.host, certificate) },
      (response) => {
        response.resume();
        resolveLoopback(`answered ${response.statusCode}`);
      },
    );
    outgoing.on('error', (error) => resolveLoopback(error.code ?? 'error'));
    outgoing.end();
  });
  assert.doesNotMatch(loopback, /^answered/u, 'the pilot answered on loopback');
  results.tls = {
    caSubject: caSubject.replaceAll('\n', ', '),
    loopback,
    plainHttpOnPilotPort: plainHttp,
    protocol: health.protocol,
    refusedOtherName,
    refusedWithoutPilotCa,
    serverSubjectAltName: health.certificate.subjectaltname,
  };

  // 3. The app and the proxy's headers; an unconfigured Host is turned away before the app or the API.
  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/u);
  assert.equal(page.headers['strict-transport-security'], 'max-age=31536000');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['content-security-policy'], "frame-ancestors 'none'");
  assert.equal(page.headers['access-control-allow-origin'], undefined);
  const bundlePath = /src="(\/assets\/index-[^"]+\.js)"/u.exec(page.text)?.[1];
  assert.ok(bundlePath, 'no application bundle in the page');
  const bundle = await call('GET', bundlePath);
  assert.ok(bundle.text.includes('Local demo sign-in') && bundle.text.includes('Demo runner'), 'the pilot bundle lacks the demo sign-in');
  const otherHost = await call('GET', '/api/health/live', { headers: { host: 'evil.example' } });
  assert.equal(otherHost.status, 421);
  assert.equal(otherHost.json, undefined, 'the API answered for an unconfigured Host');
  results.http = { bundleHasDemoSignIn: true, otherHostStatus: otherHost.status, pageStatus: page.status };

  // 4. Origin: exactly the pilot origin. Everything else is refused before any session exists.
  const origins = {};
  for (const candidate of [undefined, 'null', 'https://evil.example', `http://${authority}`, `https://${settings.host}:${settings.port + 1}`, 'https://localhost:8443']) {
    const refused = await call('POST', '/api/session', { body: { userId: demoIds.runner }, headers: candidate === undefined ? {} : { origin: candidate } });
    assert.equal(refused.status, 403, `${candidate}: ${refused.text}`);
    assert.equal(refused.json.error.code, 'ORIGIN_DENIED');
    assert.equal(refused.headers['set-cookie'], undefined);
    origins[candidate ?? '(none)'] = `${refused.status} ${refused.json.error.code}`;
  }
  const stranger = await call('POST', '/api/session', { body: { userId: randomUUID() }, headers: { origin } });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.json.error.code, 'LOCAL_IDENTITY_DENIED');
  results.origins = { allowed: origin, refused: origins, unlistedIdentity: `${stranger.status} ${stranger.json.error.code}` };

  // 5. Sessions: Secure, HttpOnly, SameSite=Strict cookies; the API reports exactly the person signed in.
  runner = await signIn(demoIds.runner);
  coach = await signIn(demoIds.coach);
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) {
    assert.ok(runner.setCookie.split('; ').includes(flag), `the session cookie lacks ${flag}`);
  }
  results.session = { cookieFlags: runner.setCookie.split('; ').slice(1).filter((part) => !part.startsWith('Max-Age')), runner: demoIds.runner, coach: demoIds.coach };

  // 6. An owner-only record: written by the runner (CSRF and Origin enforced), invisible to the coach and to nobody.
  const writeHeaders = { cookie: runner.cookie, origin, 'x-csrf-token': runner.csrf };
  const checkIn = { note: marker, timeZone: 'UTC', weightKg: 70.1 };
  const noCsrf = await call('PUT', checkInPath, { body: checkIn, headers: { cookie: runner.cookie, origin } });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.error.code, 'CSRF_DENIED');
  const foreignOrigin = await call('PUT', checkInPath, { body: checkIn, headers: { ...writeHeaders, origin: 'https://evil.example' } });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(foreignOrigin.json.error.code, 'ORIGIN_DENIED');
  const written = await call('PUT', checkInPath, { body: checkIn, headers: writeHeaders });
  assert.equal(written.status, 201, written.text);
  const ownRead = await call('GET', checkInPath, { headers: { cookie: runner.cookie } });
  assert.equal(ownRead.status, 200);
  assert.equal(ownRead.json.note, marker);
  const coachRead = await call('GET', checkInPath, { headers: { cookie: coach.cookie } });
  assert.equal(coachRead.status, 404);
  assert.equal(coachRead.json.error.code, 'DAILY_METRICS_NOT_FOUND');
  assert.ok(!coachRead.text.includes(marker));
  const anonymousRead = await call('GET', checkInPath);
  assert.equal(anonymousRead.status, 401);
  results.ownerOnly = {
    anonymous: anonymousRead.status,
    coachRead: `${coachRead.status} ${coachRead.json.error.code}`,
    noCsrf: `${noCsrf.status} ${noCsrf.json.error.code}`,
    foreignOrigin: `${foreignOrigin.status} ${foreignOrigin.json.error.code}`,
    ownerRead: ownRead.status,
    write: written.status,
  };

  // 7. Isolation: the record is in the pilot database, which the pilot API is connected to, and in no normal database.
  assert.equal(pilotSql('SELECT current_database()'), pilotDatabase);
  assert.equal(pilotSql(`SELECT count(*) FROM daily_metrics WHERE note = '${marker}'`), '1');
  assert.ok(Number(pilotSql("SELECT count(*) FROM pg_stat_activity WHERE application_name = 'running-tracker-api' AND datname = current_database()")) > 0);
  const local = loadLocalEnvironment();
  const normal = {
    development: await countInNormalDatabase(local.BOOTSTRAP_DATABASE_URL, marker),
    test: await countInNormalDatabase(local.TEST_BOOTSTRAP_DATABASE_URL, marker),
  };
  for (const [name, outcome] of Object.entries(normal)) {
    if (outcome !== 'unreachable') assert.equal(outcome.count, 0, `the marker reached the ${name} database`);
  }
  results.isolation = { normalDatabases: normal, pilotDatabase, pilotRowsWithMarker: 1 };

  // 8. Live SSE through the proxy: HTTP/2, the no-buffer headers, and a first frame.
  const live = await openSse(coach.cookie);
  assert.equal(live.alpn, 'h2');
  assert.equal(Number(live.headers[http2Constants.HTTP2_HEADER_STATUS]), 200);
  assert.equal(live.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(live.headers['x-accel-buffering'], 'no');
  assert.equal(live.headers['content-encoding'], undefined);
  assert.match(live.firstFrame, /^(?:event: |data: |: )/mu);
  results.sse = { alpn: live.alpn, cacheControl: live.headers['cache-control'], firstFrame: live.firstFrame.split('\n')[0].slice(0, 40) };

  // 9. Log boundary: callback-shaped canaries in the query string, one through nginx's own refusal (413), never logged.
  const canaries = [createCanary('pilotcode'), createCanary('pilotstate'), createCanary('pilotbig')];
  await call('GET', `/api/auth/callback?code=${canaries[0]}&state=${canaries[1]}`);
  const refusedBody = await sendOversized(`/api/auth/callback?code=${canaries[2]}`);
  let streams;
  let refusedEntries = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const logged = spawnSync('docker', ['logs', proxy.Id], { encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 });
    streams = { access: logged.stdout, error: logged.stderr };
    refusedEntries = correlate(streams).filter((entry) => entry.status === 413);
    if (refusedEntries.some((entry) => entry.events.includes('request_body_too_large'))) break;
    await new Promise((wait) => setTimeout(wait, 250));
  }
  const exposure = {
    accessLogCanariesFound: countExposed(streams.access, canaries),
    errorLinesOnStdout: misroutedErrorLineCount(streams.access),
    errorLogCanariesFound: countExposed(streams.error, canaries),
    errorLogUnsanitizedLines: unsanitizedLineCount(streams.error),
  };
  assert.deepEqual(exposure, { accessLogCanariesFound: 0, errorLinesOnStdout: 0, errorLogCanariesFound: 0, errorLogUnsanitizedLines: 0 });
  assert.ok(refusedEntries.some((entry) => entry.events.includes('request_body_too_large')), 'the 413 left no sanitized event');
  results.logBoundary = { ...exposure, oversizedStatus: refusedBody.status, refusedWithEvent: true };

  // 10. Clean up through the API: the record is gone everywhere, and both sessions end.
  const removed = await call('DELETE', checkInPath, { headers: writeHeaders });
  assert.equal(removed.status, 204);
  assert.equal((await call('GET', checkInPath, { headers: { cookie: runner.cookie } })).status, 404);
  assert.equal(pilotSql(`SELECT count(*) FROM daily_metrics WHERE note = '${marker}'`), '0');
  for (const person of [runner, coach]) {
    const ended = await call('DELETE', '/api/session', { headers: { cookie: person.cookie, origin, 'x-csrf-token': person.csrf } });
    assert.equal(ended.status, 204);
    assert.equal((await call('GET', '/api/session', { headers: { cookie: person.cookie } })).status, 401);
  }
  runner = undefined;
  coach = undefined;
  results.cleanup = { checkInDeleted: true, sessionsEnded: 2 };

  console.info(JSON.stringify({ origin, verdict: 'PASS', ...results }, null, 2));
  if (Object.values(normal).includes('unreachable')) {
    console.info('Note: a normal database was not reachable, so the marker could not be looked up there (see isolation).');
  }
} finally {
  // Best effort after a failure: never leave the marker row or the sessions behind.
  if (runner) {
    await call('DELETE', checkInPath, { headers: { cookie: runner.cookie, origin, 'x-csrf-token': runner.csrf } }).catch(() => undefined);
  }
  for (const person of [runner, coach].filter(Boolean)) {
    await call('DELETE', '/api/session', { headers: { cookie: person.cookie, origin, 'x-csrf-token': person.csrf } }).catch(() => undefined);
  }
}

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as connectHttp2, constants as http2Constants } from 'node:http2';
import { resolve } from 'node:path';
import { connect as connectTls } from 'node:tls';

import { writeProductionSecrets } from './production-secrets.mjs';
import {
  accessEntries,
  canaryForms,
  correlate,
  countExposed,
  createCanary,
  misroutedErrorLineCount,
  percentEncodeAll,
  unsanitizedLineCount,
} from './proxy-log-boundary.mjs';

// Brings up the P12.2 deployment profile on this machine with throwaway secrets and a
// self-signed certificate, then asserts the properties the profile claims. It proves the
// configuration; it is not a deployment and says nothing about a real host, DNS, or CA.

const repositoryRoot = resolve(import.meta.dirname, '..');
const workDirectory = resolve(repositoryRoot, '.local', 'prod-verify');
const secretsDirectory = resolve(workDirectory, 'secrets');
const tlsDirectory = resolve(workDirectory, 'tls');
const journalDirectory = resolve(workDirectory, 'deletion-journal');
const composeFile = 'infra/compose/docker-compose.production.yml';
const httpPort = 19080;
const httpsPort = 19443;
const hostname = 'localhost';
const origin = `https://${hostname}:${httpsPort}`;
const project = 'running-tracker-prodverify';
const postgresImage = readFileSync(resolve(repositoryRoot, composeFile), 'utf8').match(
  /image: (postgis\/postgis:\S+)/u,
)[1];
const keep = process.argv.includes('--keep');

const composeEnvironment = {
  ...process.env,
  API_CPUS: '1.5',
  API_MEM_LIMIT: '384m',
  BIND_ADDRESS: '127.0.0.1',
  COMPOSE_PROJECT_NAME: project,
  DELETION_JOURNAL_HOST_DIR: journalDirectory,
  HTTPS_PORT: String(httpsPort),
  HTTP_PORT: String(httpPort),
  IMAGE_TAG: 'prodverify',
  // P12.1: a throwaway client and an issuer nothing listens on. Discovery is lazy, so the API must still
  // start, and sign-in must then fail closed with 503 instead of the API failing to come up.
  OIDC_CLIENT_ID: 'running-tracker-verify',
  OIDC_ISSUER_URL: 'https://127.0.0.1:1',
  POSTGRES_CPUS: '2',
  POSTGRES_MEM_LIMIT: '1536m',
  PROXY_CPUS: '0.5',
  PROXY_MEM_LIMIT: '96m',
  PUBLIC_HOSTNAME: hostname,
  PUBLIC_ORIGIN: origin,
  SECRETS_DIR: secretsDirectory,
  TLS_DIR: tlsDirectory,
};

function compose(args, options = {}) {
  return execFileSync('docker', ['compose', '-f', composeFile, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: composeEnvironment,
    stdio: ['ignore', 'pipe', options.quiet ? 'ignore' : 'inherit'],
  });
}

function psql(sql) {
  return compose(
    ['exec', '-T', 'postgres', 'psql', '-U', 'running_tracker_admin', '-d', 'running_tracker', '-Atc', sql],
    { quiet: true },
  ).trim();
}

function containerId(service) {
  return compose(['ps', '-aq', service], { quiet: true }).trim();
}

function inspect(service) {
  return JSON.parse(execFileSync('docker', ['inspect', containerId(service)], { encoding: 'utf8' }))[0];
}

function generateCertificate() {
  mkdirSync(tlsDirectory, { recursive: true });
  execFileSync(
    'docker',
    [
      'run', '--rm', '--entrypoint', 'openssl', '--volume', `${tlsDirectory}:/tls`, postgresImage,
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '2',
      '-keyout', '/tls/privkey.pem', '-out', '/tls/fullchain.pem',
      '-subj', `/CN=${hostname}`, '-addext', `subjectAltName=DNS:${hostname},IP:127.0.0.1`,
    ],
    { stdio: 'inherit' },
  );
}

function http2Request(path, headers = {}, { method = 'GET', body } = {}) {
  const certificate = readFileSync(resolve(tlsDirectory, 'fullchain.pem'));
  const client = connectHttp2(origin, { ca: certificate, servername: hostname });
  return new Promise((resolveRequest, reject) => {
    client.once('error', reject);
    const stream = client.request(
      { [http2Constants.HTTP2_HEADER_METHOD]: method, [http2Constants.HTTP2_HEADER_PATH]: path, ...headers },
      { endStream: body === undefined },
    );
    const chunks = [];
    let responseHeaders;
    stream.on('response', (value) => {
      responseHeaders = value;
    });
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      const alpn = client.socket.alpnProtocol;
      client.close();
      resolveRequest({
        alpn,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: responseHeaders,
        status: Number(responseHeaders[http2Constants.HTTP2_HEADER_STATUS]),
      });
    });
    stream.on('error', reject);
    if (body !== undefined) stream.end(body);
  });
}

function plainHttp(path, hostHeader) {
  return new Promise((resolveRequest, reject) => {
    const request = httpRequest(
      { headers: { host: hostHeader }, host: '127.0.0.1', path, port: httpPort },
      (response) => {
        response.resume();
        response.on('end', () => resolveRequest({ headers: response.headers, status: response.statusCode }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

// Declares a body larger than the listener accepts and sends only its start: nginx answers from the declared
// length, before reading the body.
function plainHttpDeclaredUpload(path, declaredBytes) {
  return new Promise((resolveRequest, reject) => {
    const request = httpRequest(
      {
        headers: { 'content-length': String(declaredBytes), 'content-type': 'application/octet-stream', host: hostname },
        host: '127.0.0.1',
        method: 'POST',
        path,
        port: httpPort,
      },
      (response) => {
        response.resume();
        response.on('end', () => {
          request.destroy();
          resolveRequest({ status: response.statusCode });
        });
      },
    );
    request.on('error', reject);
    request.write(Buffer.alloc(1024));
  });
}

function handshakeRefused(servername) {
  return new Promise((resolveHandshake) => {
    const socket = connectTls({ host: '127.0.0.1', port: httpsPort, rejectUnauthorized: false, servername });
    socket.once('secureConnect', () => {
      socket.destroy();
      resolveHandshake(false);
    });
    socket.once('error', () => resolveHandshake(true));
  });
}

async function waitFor(description, check, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

const results = {};
// Every canary sent through the proxy; the failure dump below masks them.
const sentCanaries = [];

try {
  rmSync(workDirectory, { force: true, recursive: true });
  mkdirSync(journalDirectory, { recursive: true });
  // The API runs as uid 1000 and must write the journal; on Linux hosts the runbook chowns it.
  if (process.platform !== 'win32') execFileSync('chmod', ['0777', journalDirectory]);
  writeProductionSecrets(secretsDirectory, { randomBytes });
  // Issued by the identity provider in a real deployment, so it is not part of the generated set.
  writeFileSync(resolve(secretsDirectory, 'oidc-client-secret'), randomBytes(32).toString('hex'), { mode: 0o444 });
  generateCertificate();

  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '240']);

  // 1. Transport: HTTP/2 over TLS, application reachable, healthy through the proxy.
  const ready = await http2Request('/api/health/ready');
  assert.equal(ready.status, 200, ready.body);
  assert.equal(ready.alpn, 'h2', 'TLS ALPN did not negotiate HTTP/2');
  results.http2Alpn = ready.alpn;

  const page = await http2Request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/u);
  assert.equal(page.headers['cache-control'], 'no-cache');
  const fallback = await http2Request('/some/client/route');
  assert.equal(fallback.status, 200, 'single-page fallback is missing');
  const asset = page.body.match(/\/assets\/[\w.-]+\.(?:js|css)/u)?.[0];
  assert.ok(asset, 'built web bundle has no /assets/ reference');
  const assetResponse = await http2Request(asset);
  assert.equal(assetResponse.status, 200);
  assert.match(assetResponse.headers['cache-control'], /immutable/u);

  // 2. Headers survive every location (nginx drops inherited add_header in a location that sets one).
  for (const [name, response] of [['/', page], ['/assets', assetResponse], ['/api', ready]]) {
    assert.match(response.headers['strict-transport-security'] ?? '', /max-age=31536000/u, `HSTS missing on ${name}`);
    assert.equal(response.headers['x-content-type-options'], 'nosniff', `nosniff missing on ${name}`);
    assert.match(response.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/u, `CSP missing on ${name}`);
    assert.ok(response.headers['referrer-policy'], `Referrer-Policy missing on ${name}`);
  }
  assert.equal(ready.headers.server, 'nginx', 'server version must not be disclosed');
  results.securityHeaders = 'present on /, /assets, /api';

  // 3. HTTP only redirects, to the configured origin, whatever Host says; unknown TLS names are refused.
  const redirect = await plainHttp('/api/health/ready?x=1', 'evil.invalid');
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.location, `${origin}/api/health/ready?x=1`);
  assert.equal(await handshakeRefused('untrusted.invalid'), true, 'unknown SNI was served');
  results.httpRedirect = redirect.headers.location;

  // 4. No development login: the session bootstrap route does not exist and sets no cookie.
  const login = await http2Request(
    '/api/session',
    { 'content-type': 'application/json', origin },
    { body: JSON.stringify({ userId: '11111111-1111-4111-8111-111111111111' }), method: 'POST' },
  );
  assert.ok(login.status >= 400 && login.status < 500, `dev login answered ${login.status}`);
  assert.equal(login.headers['set-cookie'], undefined);
  results.devLoginStatus = login.status;

  // 5. Exposure: only the proxy publishes ports; PostgreSQL and the API are unreachable from the host.
  for (const service of ['postgres', 'api', 'db-init']) {
    const ports = inspect(service).NetworkSettings.Ports ?? {};
    assert.equal(Object.values(ports).filter(Boolean).length, 0, `${service} publishes a host port`);
  }
  const proxyPorts = Object.keys(inspect('proxy').NetworkSettings.Ports ?? {}).sort();
  assert.deepEqual(proxyPorts, ['443/tcp', '80/tcp']);
  const networks = JSON.parse(
    execFileSync('docker', ['network', 'inspect', `${project}_data`], { encoding: 'utf8' }),
  )[0];
  assert.equal(networks.Internal, true, 'data network must be internal');
  results.publishedPorts = proxyPorts;

  // 6. Resource limits and container hardening are actually applied.
  const gib = 1024 ** 3;
  const expected = {
    api: { cpus: 1.5, memory: 384 * 1024 ** 2, user: /^node$|^1000/u },
    postgres: { cpus: 2, memory: 1.5 * gib },
    proxy: { cpus: 0.5, memory: 96 * 1024 ** 2 },
  };
  results.limits = {};
  for (const [service, want] of Object.entries(expected)) {
    const { HostConfig, Config } = inspect(service);
    assert.equal(HostConfig.Memory, want.memory, `${service} memory limit`);
    assert.equal(HostConfig.MemorySwap, want.memory, `${service} must not swap`);
    assert.equal(HostConfig.NanoCpus, want.cpus * 1e9, `${service} cpu limit`);
    assert.ok(HostConfig.PidsLimit > 0, `${service} pids limit`);
    assert.ok(HostConfig.CapDrop?.includes('ALL'), `${service} must drop all capabilities`);
    assert.ok(HostConfig.SecurityOpt?.includes('no-new-privileges:true'), `${service} no-new-privileges`);
    assert.equal(HostConfig.LogConfig.Config['max-size'], '10m', `${service} log size is unbounded`);
    if (service !== 'postgres') assert.equal(HostConfig.ReadonlyRootfs, true, `${service} rootfs writable`);
    if (want.user) assert.match(Config.User, want.user, `${service} runs as root`);
    results.limits[service] = { cpus: HostConfig.NanoCpus / 1e9, memoryMiB: HostConfig.Memory / 1024 ** 2 };
  }
  const apiEnvironment = inspect('api').Config.Env;
  assert.ok(apiEnvironment.includes('APP_ENV=production'));
  assert.ok(apiEnvironment.includes('LOCAL_AUTH_ENABLED=false'));

  // 7. Secrets are files, never environment values or image content.
  const secretValues = readdirSync(secretsDirectory).flatMap((file) => {
    const value = readFileSync(resolve(secretsDirectory, file), 'utf8').trim();
    return file.endsWith('database-url') ? [new URL(value).password] : [value];
  });
  const everything = ['postgres', 'api', 'db-init', 'proxy']
    .map((service) => JSON.stringify(inspect(service).Config))
    .join('\n');
  for (const value of new Set(secretValues)) {
    assert.ok(!everything.includes(value), 'a secret value appears in container configuration');
  }
  assert.ok(apiEnvironment.some((entry) => entry.startsWith('DATABASE_URL_FILE=/run/secrets/')));
  const logs = compose(['logs', '--no-color'], { quiet: true });
  for (const value of new Set(secretValues)) {
    assert.ok(!logs.includes(value), 'a secret value appears in container logs');
  }
  results.secrets = 'files only; absent from container config and logs';

  // 8. Database: least-privilege logins, SCRAM, configured limits.
  const roles = psql(
    "SELECT rolname || ':' || rolsuper || ':' || rolbypassrls || ':' || rolcreatedb || ':' || rolcreaterole FROM pg_roles WHERE rolname LIKE 'running_tracker_%' ORDER BY 1",
  ).split('\n');
  assert.deepEqual(roles, [
    'running_tracker_admin:true:true:true:true',
    'running_tracker_maintenance:false:false:false:false',
    'running_tracker_owner:false:false:false:false',
    'running_tracker_runtime:false:false:false:false',
  ]);
  assert.equal(psql('SHOW password_encryption'), 'scram-sha-256');
  assert.equal(psql('SHOW max_connections'), '40');
  assert.equal(psql('SHOW shared_buffers'), '512MB');
  const weakRules = psql(
    "SELECT count(*) FROM pg_hba_file_rules WHERE type LIKE 'host%' AND auth_method <> 'scram-sha-256' AND coalesce(address, '') NOT IN ('127.0.0.1', '::1')",
  );
  assert.equal(weakRules, '0', 'a non-loopback pg_hba rule is not SCRAM');
  results.roles = 'runtime, maintenance, owner: no superuser/BYPASSRLS/CREATEDB/CREATEROLE';

  // 9. Observability is reachable inside the network only.
  const metrics = execFileSync(
    'docker',
    ['exec', containerId('api'), 'node', '-e', "fetch('http://127.0.0.1:9464/metrics').then(r=>r.text()).then(t=>process.stdout.write(t))"],
    { encoding: 'utf8' },
  );
  assert.match(metrics, /process_resident_memory_bytes/u);
  const scrape = spawnSync('curl', ['--silent', '--max-time', '2', `http://127.0.0.1:9464/metrics`]);
  assert.notEqual(scrape.status, 0, 'metrics answered on the host');

  // 9b. Sign-in surface (P12.1): OIDC routes exist behind the proxy, there is no development login, and an
  // unreachable provider fails closed with 503 while the rest of the API stays healthy.
  const devLogin = await http2Request(
    '/api/session',
    { 'content-type': 'application/json', origin },
    { body: JSON.stringify({ userId: '11111111-1111-4111-8111-111111111111' }), method: 'POST' },
  );
  assert.equal(devLogin.status, 404, 'a development login exists in production');
  const oidcLogin = await http2Request('/api/auth/login');
  assert.equal(oidcLogin.status, 503, oidcLogin.body);
  assert.equal(JSON.parse(oidcLogin.body).error.code, 'IDENTITY_PROVIDER_UNAVAILABLE');
  assert.equal(oidcLogin.headers['cache-control'], 'no-store');
  // The public socket is the limiter key. Header spoofing, a trailing slash and
  // Express's case-insensitive route spelling must not bypass the same zone.
  const loginBurst = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    http2Request(index % 2 === 0 ? '/api/auth/login/' : '/API/AUTH/LOGIN', {
      'x-forwarded-for': `203.0.113.${index + 1}`,
      'x-real-ip': `198.51.100.${index + 1}`,
    }),
  ));
  assert.ok(loginBurst.some((response) => response.status === 429), 'login burst bypassed the public-edge limiter');
  assert.ok(loginBurst.every((response) => [429, 503].includes(response.status)), 'unexpected login admission response');
  assert.equal((await http2Request('/api/session')).status, 401);
  assert.equal((await http2Request('/api/health/ready')).status, 200);
  assert.ok(apiEnvironment.includes('OIDC_REDIRECT_URI=' + origin + '/api/auth/callback'));
  assert.ok(apiEnvironment.some((entry) => entry.startsWith('OIDC_CLIENT_SECRET_FILE=/run/secrets/')));
  assert.ok(!apiEnvironment.some((entry) => entry.startsWith('OIDC_CLIENT_SECRET=')), 'client secret is an environment value');
  results.signIn = 'no dev login (404); unreachable provider returns 503; login burst returns 429 despite forged IP headers and alternate route spellings; API stays ready';

  // 9c. F01 and ADR-0062: the OIDC callback's one-time code and state must not reach anything the proxy keeps.
  // Unique canaries go through the real edge on both listeners: an ordinary callback, the same values
  // percent-encoded and next to a raw quote and backslash, the HTTP redirect, requests nginx fails itself (a body
  // over client_max_body_size before any routing, an upstream it cannot reach) and copies carried only in the
  // Referer. Then the proxy's Docker streams are read as stored (stdout is the access log, stderr the error log)
  // together with the container's writable mounts. Checks count matches; they never print a log sample.
  const callbackQuery = (label, encode = (value) => value) => {
    const code = createCanary(`${label}code`);
    const state = createCanary(`${label}state`);
    sentCanaries.push(code, state);
    return `code=${encode(code)}&state=${encode(state)}`;
  };
  const callbackReferer = (label) => `${origin}/api/auth/callback?${callbackQuery(label)}`;
  const callbackStatus = (response) => response.status >= 300 && response.status < 600;

  const callback = await http2Request(`/api/auth/callback?${callbackQuery('ordinary')}`);
  assert.ok(callbackStatus(callback), `callback answered ${callback.status}`);
  const encodedCallback = await http2Request(`/api/auth/callback?${callbackQuery('encoded', percentEncodeAll)}`);
  assert.ok(callbackStatus(encodedCallback), `encoded callback answered ${encodedCallback.status}`);
  // nginx writes a raw quote or backslash escaped in its own entries; the canary between them stays whole.
  const escapedCallback = await http2Request(`/api/auth/callback?${callbackQuery('escaped', (value) => `"${value}\\`)}`)
    .catch((error) => ({ error: error.message, status: undefined }));

  const redirectQuery = callbackQuery('redirect');
  const plainCallback = await plainHttp(`/api/auth/callback?${redirectQuery}`, hostname);
  assert.equal(plainCallback.status, 301);
  // The redirect itself legitimately carries the query back to the browser; only the logs are in question.
  assert.equal(plainCallback.headers.location, `${origin}/api/auth/callback?${redirectQuery}`);

  // nginx may reset an HTTP/2 stream while the body is still being sent, so an answer is not required to arrive
  // intact: what matters is the access entry and the error entry, which are waited for below.
  const oversized = 'x'.repeat(256 * 1024);
  const oversizedHeaders = { 'content-length': String(oversized.length), 'content-type': 'application/octet-stream', origin };
  const refused = await http2Request(
    `/api/auth/callback?${callbackQuery('oversized')}`,
    { ...oversizedHeaders, referer: callbackReferer('oversizedreferer') },
    { body: oversized, method: 'POST' },
  ).catch((error) => ({ error: error.message, status: undefined }));
  assert.ok(refused.status === undefined || refused.status === 413, `the oversized callback answered ${refused.status}`);
  const refusedByReferer = await http2Request(
    '/api/runs',
    { ...oversizedHeaders, referer: callbackReferer('refereronly') },
    { body: oversized, method: 'POST' },
  ).catch((error) => ({ error: error.message, status: undefined }));
  assert.ok(refusedByReferer.status === undefined || refusedByReferer.status === 413);
  // The HTTP listener applies the default 1 MiB limit before its redirect.
  const plainRefused = await plainHttpDeclaredUpload(`/api/auth/callback?${callbackQuery('plainoversized')}`, 2 * 1024 ** 2);
  assert.equal(plainRefused.status, 413);

  // An upstream nginx cannot reach: with the API container stopped, the proxy fails the callback itself.
  execFileSync('docker', ['stop', '--time', '15', containerId('api')], { stdio: 'ignore' });
  let upstreamFailure;
  try {
    upstreamFailure = await http2Request(
      `/api/auth/callback?${callbackQuery('upstream')}`,
      { referer: callbackReferer('upstreamreferer') },
    );
  } finally {
    execFileSync('docker', ['start', containerId('api')], { stdio: 'ignore' });
  }
  assert.ok([502, 504].includes(upstreamFailure.status), `the unreachable upstream answered ${upstreamFailure.status}`);
  await waitFor('API readiness after the upstream probe', async () => (await http2Request('/api/health/ready')).status === 200);

  const proxyStreams = () => {
    const logged = spawnSync('docker', ['logs', containerId('proxy')], { encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 });
    assert.equal(logged.status, 0, 'docker logs failed');
    return { access: logged.stdout, error: logged.stderr };
  };
  await waitFor('the probes in the proxy access log', () => {
    const statuses = accessEntries(proxyStreams().access).map((entry) => entry.status);
    const tooLarge = statuses.filter((status) => status === 413).length;
    return tooLarge >= 3 && statuses.some((status) => status === 502 || status === 504);
  }, 30_000);
  // Each refused request needs an event of its own category on its connection. Error entries reach Docker after
  // their access entries (they pass through the sanitizer), so they get time to arrive; the gate runs either way.
  const upstreamEvent = /^upstream_(?:connect_failed|timeout|unavailable)$/u;
  const paired = (entry) => {
    if (entry.status === 413) return entry.events.includes('request_body_too_large');
    if (entry.status === 502 || entry.status === 504) return entry.events.some((event) => upstreamEvent.test(event));
    return true;
  };
  await waitFor('the error events of the refused requests', () => correlate(proxyStreams()).every(paired), 15_000).catch(() => undefined);
  const streams = proxyStreams();
  // Regular files only: the error-log FIFO must never be opened by a reader other than the sanitizer.
  const fileScan = spawnSync(
    'docker',
    [
      'exec', containerId('proxy'), 'find', '/tmp', '/run', '/var/cache/nginx', '/etc/nginx/conf.d', '/var/log',
      '-type', 'f', '-exec', 'grep', '-lF', ...sentCanaries.flatMap((canary) => canaryForms(canary).flatMap((form) => ['-e', form])), '{}', '+',
    ],
    { encoding: 'utf8' },
  );
  assert.ok(fileScan.status === 0 || fileScan.status === 1, 'the writable-mount scan failed');
  const errorLogCanariesFound = countExposed(streams.error, sentCanaries);
  const apiLogged = compose(['logs', '--no-color', 'api'], { quiet: true });
  results.callbackLogging = {
    canariesSent: sentCanaries.length,
    accessLogCanariesFound: countExposed(streams.access, sentCanaries),
    errorLogCanariesFound,
    writableFilesWithCanaries: fileScan.stdout.split('\n').filter(Boolean).length,
    // Informational: the API's own log is outside this check's assertions.
    apiLogCanariesFound: countExposed(apiLogged, sentCanaries),
    answers: {
      escapedCallback: escapedCallback.status ?? 'no answer',
      oversizedCallback: refused.status ?? 'no answer',
      oversizedRefererOnly: refusedByReferer.status ?? 'no answer',
      plainOversizedCallback: plainRefused.status,
      unreachableUpstream: upstreamFailure.status,
    },
    errorLogQueryExposedOnNginxError: errorLogCanariesFound > 0,
    errorLogUnsanitizedLines: unsanitizedLineCount(streams.error),
    errorLinesOnStdout: misroutedErrorLineCount(streams.access),
  };
  // Security gate (ADR-0062). It used to be reported as an accepted limitation; it now fails the run.
  assert.equal(
    results.callbackLogging.errorLogQueryExposedOnNginxError,
    false,
    `errorLogQueryExposedOnNginxError: ${errorLogCanariesFound} of ${sentCanaries.length} callback values reached the proxy error stream`,
  );
  assert.equal(results.callbackLogging.accessLogCanariesFound, 0, 'a callback query value is in the proxy access log');
  assert.equal(results.callbackLogging.writableFilesWithCanaries, 0, 'a callback query value is in a proxy file');
  assert.equal(results.callbackLogging.errorLogUnsanitizedLines, 0, 'the proxy error stream has a line the sanitizer did not build');
  assert.equal(results.callbackLogging.errorLinesOnStdout, 0, 'sanitized error lines went to the access stream');

  // Diagnostics that must survive: the access log keeps method, path, protocol, status and timing with a connection
  // number, and each refused or failed request has an error event of its own category on that connection.
  const entries = correlate(streams);
  const callbackEntries = entries.filter((entry) => entry.path === '/api/auth/callback');
  assert.ok(callbackEntries.some((entry) => entry.method === 'GET' && entry.status === callback.status));
  assert.ok(callbackEntries.some((entry) => entry.method === 'GET' && entry.status === 301));
  assert.ok(entries.every((entry) => !entry.path.includes('?') && entry.connection !== undefined), 'an access entry lost its shape');
  const tooLarge = entries.filter((entry) => entry.status === 413);
  const failedUpstream = entries.filter((entry) => entry.status === 502 || entry.status === 504);
  assert.ok(tooLarge.length >= 3 && tooLarge.every(paired), 'a 413 has no request_body_too_large event');
  assert.ok(failedUpstream.length >= 1 && failedUpstream.every(paired), 'an upstream failure has no upstream event');
  results.callbackLogging.diagnostics = {
    accessEntryShape: 'method, path without query, protocol, status, bytes, upstream, request_time, connection',
    tooLarge: [...new Set(tooLarge.flatMap((entry) => entry.events))],
    upstreamFailure: [...new Set(failedUpstream.flatMap((entry) => entry.events))],
    sampleAccessLine: streams.access.split('\n').find((line) => line.includes('" 413 ')),
    sampleErrorLine: streams.error.split('\n').find((line) => line.includes('event=request_body_too_large')),
  };

  // 10. Restart and redeploy behaviour: the API returns, the one-shot job is idempotent.
  compose(['restart', 'api']);
  await waitFor('API readiness after restart', async () => (await http2Request('/api/health/ready')).status === 200);
  const rerun = compose(['run', '--rm', '--no-deps', 'db-init'], { quiet: true });
  assert.match(rerun, /skip 0019_set_based_run_visibility\.sql/u);
  assert.doesNotMatch(rerun, /apply /u, 'a second db-init applied migrations');
  results.redeploy = 'db-init re-run applied nothing; API recovered after restart';

  // Certificate renewal is a file swap plus a reload; the read-only, capability-dropped proxy must allow it.
  compose(['exec', '-T', 'proxy', 'nginx', '-s', 'reload'], { quiet: true });
  await waitFor('API through the proxy after reload', async () => (await http2Request('/api/health/ready')).status === 200);
  results.proxyReload = 'nginx -s reload succeeded and traffic continued';

  // 11. Credential rotation as the runbook describes it: new role secrets, db-init, API recreate.
  const runtimeUrlFile = resolve(secretsDirectory, 'runtime-database-url');
  const oldRuntimeUrl = readFileSync(runtimeUrlFile, 'utf8').trim();
  const loginWorks = (url) =>
    spawnSync(
      'docker',
      ['exec', containerId('postgres'), 'psql', url, '-Atc', 'SELECT 1'],
      { encoding: 'utf8' },
    ).status === 0;
  assert.equal(loginWorks(oldRuntimeUrl), true, 'runtime login must work before rotation');
  const rotated = writeProductionSecrets(secretsDirectory, { randomBytes, rotateRoles: true });
  assert.equal(rotated.length, 3);
  compose(['run', '--rm', '--no-deps', 'db-init'], { quiet: true });
  const newRuntimeUrl = readFileSync(runtimeUrlFile, 'utf8').trim();
  assert.notEqual(newRuntimeUrl, oldRuntimeUrl);
  assert.equal(loginWorks(oldRuntimeUrl), false, 'the old runtime password still works');
  assert.equal(loginWorks(newRuntimeUrl), true, 'the new runtime password does not work');
  compose(['up', '-d', '--no-deps', '--force-recreate', '--wait', 'api'], { quiet: true });
  await waitFor('API readiness after rotation', async () => (await http2Request('/api/health/ready')).status === 200);
  results.rotation = 'old runtime password rejected, new accepted, API ready on the new credentials';

  console.info(JSON.stringify(results, null, 2));
} catch (error) {
  try {
    let logs = compose(['logs', '--no-color', '--tail', '60'], { quiet: true });
    for (const form of sentCanaries.flatMap(canaryForms)) logs = logs.replaceAll(form, '<canary>');
    console.error(logs);
  } catch {
    // Diagnostics only.
  }
  throw error;
} finally {
  if (!keep) {
    try {
      compose(['down', '--volumes', '--remove-orphans', '--timeout', '20'], { quiet: true });
    } catch {
      // Nothing was started.
    }
    try {
      rmSync(workDirectory, { force: true, recursive: true });
    } catch {
      // Root-owned files created by the certificate container on Linux hosts.
    }
  }
}

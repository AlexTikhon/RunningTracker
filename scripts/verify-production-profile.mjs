import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as connectHttp2, constants as http2Constants } from 'node:http2';
import { resolve } from 'node:path';
import { connect as connectTls } from 'node:tls';

import { writeProductionSecrets } from './production-secrets.mjs';

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
    console.error(compose(['logs', '--no-color', '--tail', '60'], { quiet: true }));
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

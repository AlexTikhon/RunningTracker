import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { seedDemoPeople } from './demo-people.mjs';
import { demoIds } from './demo-plan.mjs';
import {
  composeArguments,
  isLocalInterfaceAddress,
  parsePilotArguments,
  parsePilotEnv,
  pilotDatabase,
  pilotPaths,
  pilotProject,
  pilotVolume,
  renderPilotEnv,
  requireLanPilotDatabase,
  requirePrivateAddress,
  requirePrivateHostname,
} from './lan-pilot-config.mjs';
import {
  caValidityDays,
  certificateFiles,
  existingCertificateFiles,
  issuePilotCertificates,
  nameConstraints,
  opensslSteps,
  renderCaConfig,
  renderServerConfig,
  serverValidityDays,
  subjectAltName,
} from './lan-pilot-tls.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8').replaceAll('\r\n', '\n');
const paths = pilotPaths('C:\\work\\repo');

// One top-level service of a compose file, from its key to the next key at the same indentation.
function service(compose, name) {
  const start = compose.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `service ${name} is missing`);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n|\n[a-z]/u);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

test('LAN pilot: only a private RFC 1918 address of the host can be published', () => {
  for (const address of ['10.0.0.2', '172.16.0.10', '172.31.255.254', '192.168.1.50']) {
    assert.equal(requirePrivateAddress(address), address);
  }
  for (const address of ['0.0.0.0', '127.0.0.1', '169.254.10.1', '100.64.0.1', '8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1']) {
    assert.throws(() => requirePrivateAddress(address), /not a private LAN address/u, address);
  }
  for (const address of ['192.168.1.0', '192.168.1.255']) {
    assert.throws(() => requirePrivateAddress(address), /network or broadcast/u, address);
  }
  for (const address of ['192.168.1', '192.168.01.5', '192.168.1.256', ' 192.168.1.5', '::1', 'fe80::1', '', undefined]) {
    assert.throws(() => requirePrivateAddress(address), /must be an IPv4 address/u, String(address));
  }
});

test('LAN pilot: an optional name must be a private-use name, never a public domain', () => {
  assert.equal(requirePrivateHostname('My-PC.local'), 'my-pc.local');
  assert.equal(requirePrivateHostname('desk.home.arpa'), 'desk.home.arpa');
  for (const name of ['example.com', 'tracker.example', 'localhost', 'local', 'pc.local.example.com']) {
    assert.throws(() => requirePrivateHostname(name), /must end in/u, name);
  }
  for (const name of ['.local', 'a..local', '-pc.local', 'pc_1.local', 'pc .local', '']) {
    assert.throws(() => requirePrivateHostname(name), /must be a DNS name/u, name);
  }
});

test('LAN pilot: arguments give one host, one exact origin and one bind address', () => {
  const byAddress = parsePilotArguments(['--address', '192.168.1.50']);
  assert.deepEqual({ ...byAddress }, {
    bindAddress: '192.168.1.50',
    host: '192.168.1.50',
    hostname: null,
    origin: 'https://192.168.1.50:8443',
    port: 8443,
  });
  const byName = parsePilotArguments(['--address', '10.1.2.3', '--hostname', 'pc.local', '--port', '443']);
  assert.equal(byName.host, 'pc.local');
  assert.equal(byName.origin, 'https://pc.local');
  assert.equal(byName.bindAddress, '10.1.2.3');

  assert.throws(() => parsePilotArguments([]), /--address is required/u);
  assert.throws(() => parsePilotArguments(['--address']), /needs a value/u);
  assert.throws(() => parsePilotArguments(['--address', '--port']), /needs a value/u);
  assert.throws(() => parsePilotArguments(['--bind', '0.0.0.0']), /Unknown argument/u);
  assert.throws(() => parsePilotArguments(['--address', '10.0.0.2', '--address', '10.0.0.3']), /given twice/u);
  for (const port of ['80', '1023', '65536', '8443x', '-1']) {
    assert.throws(() => parsePilotArguments(['--address', '10.0.0.2', '--port', port]), /--port must be/u, port);
  }
});

test('LAN pilot: the env file round-trips and a hand edit gets the same checks', () => {
  const settings = parsePilotArguments(['--address', '192.168.1.50', '--hostname', 'pc.local']);
  const text = renderPilotEnv(settings, paths);
  assert.match(text, /^PILOT_BIND_ADDRESS=192\.168\.1\.50$/mu);
  assert.match(text, /^PILOT_ORIGIN=https:\/\/pc\.local:8443$/mu);
  assert.match(text, /^PILOT_SECRETS_DIR=C:\/work\/repo\/\.local\/lan-pilot\/secrets$/mu);
  assert.match(text, /^PILOT_TLS_DIR=C:\/work\/repo\/\.local\/lan-pilot\/tls\/server$/mu);
  assert.deepEqual({ ...parsePilotEnv(text.replaceAll('\n', '\r\n')) }, { ...settings });

  assert.throws(() => parsePilotEnv(text.replace('PILOT_BIND_ADDRESS=192.168.1.50', 'PILOT_BIND_ADDRESS=0.0.0.0')), /not a private/u);
  assert.throws(() => parsePilotEnv(text.replace('https://pc.local:8443', 'https://evil.example')), /do not match/u);
  assert.throws(() => parsePilotEnv(`${text}garbage\n`), /cannot read/u);
});

test('LAN pilot: the address must belong to one of this computer\'s external interfaces', () => {
  const interfaces = {
    Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    'Wi-Fi': [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '192.168.1.50', family: 'IPv4', internal: false },
    ],
    Old: [{ address: '10.0.0.2', family: 4, internal: false }],
  };
  assert.equal(isLocalInterfaceAddress('192.168.1.50', interfaces), true);
  assert.equal(isLocalInterfaceAddress('10.0.0.2', interfaces), true);
  assert.equal(isLocalInterfaceAddress('127.0.0.1', interfaces), false);
  assert.equal(isLocalInterfaceAddress('192.168.1.51', interfaces), false);
});

test('LAN pilot: the seed writes only to the pilot database on the pilot server, as the owner', () => {
  const url = (user, host, database) => `postgresql://${user}:pw@${host}:5432/${database}`;
  assert.doesNotThrow(() => requireLanPilotDatabase(url('running_tracker_owner', 'postgres', pilotDatabase)));
  assert.throws(() => requireLanPilotDatabase(undefined), /required/u);
  assert.throws(() => requireLanPilotDatabase(url('running_tracker_runtime', 'postgres', pilotDatabase)), /running_tracker_owner/u);
  assert.throws(() => requireLanPilotDatabase(url('running_tracker_owner', '127.0.0.1', pilotDatabase)), /own Compose service/u);
  for (const database of ['running_tracker', 'running_tracker_test', 'running_tracker_load_test']) {
    assert.throws(() => requireLanPilotDatabase(url('running_tracker_owner', 'postgres', database)), /anywhere but/u, database);
  }
});

test('LAN pilot: every Compose call names the pilot project and its env file', () => {
  const args = composeArguments(paths);
  assert.deepEqual(args.slice(0, 5), ['compose', '--project-name', 'running-tracker-lan-pilot', '--file', 'infra/compose/docker-compose.lan-pilot.yml']);
  assert.equal(args.at(-1), paths.env);
  assert.equal(pilotVolume, 'running-tracker-lan-pilot_lan_pilot_postgres');
});

test('LAN pilot Compose: its own project, database and volume; PostgreSQL, init and API publish nothing', () => {
  const compose = read('infra/compose/docker-compose.lan-pilot.yml');
  assert.match(compose, new RegExp(`^name: ${pilotProject}$`, 'mu'));
  for (const name of ['postgres', 'init', 'api']) {
    assert.doesNotMatch(service(compose, name), /^\s+ports:/mu, `${name} must not publish a port`);
  }
  assert.match(service(compose, 'postgres'), /networks: \[data\]/u);
  assert.match(service(compose, 'init'), /networks: \[data\]/u);
  assert.match(service(compose, 'api'), /networks: \[data, app\]/u);
  assert.match(compose, /\n {2}data:\n {4}internal: true\n/u);
  assert.match(compose, /\n {2}app:\n {4}internal: true\n/u);
  assert.match(service(compose, 'postgres'), /POSTGRES_DB: running_tracker_lan_pilot/u);
  assert.match(service(compose, 'postgres'), /- lan_pilot_postgres:\/var\/lib\/postgresql\/data/u);
  // Nothing may point at the development stack: its database names, volume, port or compose files.
  assert.doesNotMatch(compose, /running_tracker_test|running_tracker_postgres|5433|docker-compose\.(?:yml|transport|production)/u);
  assert.doesNotMatch(compose, /postgres(?:ql)?:\/\/[^\s]*:[^\s]*@/u, 'no credential is written in the compose file');
  for (const image of compose.matchAll(/image: (running-tracker-[\w-]+):([\w.-]+)/gu)) {
    assert.equal(image[2], 'lan-pilot', `${image[1]} must use its own tag, not overwrite another profile's image`);
  }
  assert.match(service(compose, 'init'), /bootstrap-database\.mjs && node scripts\/migrate\.mjs && node scripts\/lan-pilot-seed\.mjs/u);
});

test('LAN pilot Compose: the API takes the one pilot origin, Secure cookies, only the demo people and no AI', () => {
  const api = service(read('infra/compose/docker-compose.lan-pilot.yml'), 'api');
  assert.match(api, /APP_ENV: development/u);
  assert.match(api, /ALLOWED_ORIGINS: \$\{PILOT_ORIGIN:\?/u);
  assert.match(api, /SESSION_COOKIE_SECURE: "true"/u);
  assert.match(api, /LOCAL_AUTH_ENABLED: "true"/u);
  assert.match(api, new RegExp(`LOCAL_AUTH_USER_IDS: ${demoIds.runner},${demoIds.coach}\n`, 'u'));
  assert.match(api, /RUN_SEARCH_AI_ENABLED: "false"/u);
  assert.match(api, /WEEKLY_INSIGHTS_PROVIDER: "off"/u);
  assert.doesNotMatch(api, /OPENAI|OLLAMA|METRICS_/u);
  assert.match(api, /DATABASE_URL_FILE: \/run\/secrets\/runtime_database_url/u);
});

test('demo people: one transaction of idempotent inserts, rolled back on failure', async () => {
  const statements = [];
  const client = { query: async (sql) => void statements.push(sql.trim().split(/\s+/u).slice(0, 3).join(' ')) };
  await seedDemoPeople(client);
  assert.deepEqual(statements, ['BEGIN', 'INSERT INTO users', 'INSERT INTO organizations', 'INSERT INTO memberships', 'COMMIT']);

  const failing = [];
  const broken = {
    query: async (sql) => {
      failing.push(sql.trim().split(/\s+/u)[0]);
      if (sql.includes('organizations')) throw new Error('boom');
    },
  };
  await assert.rejects(seedDemoPeople(broken), /boom/u);
  assert.deepEqual(failing, ['BEGIN', 'INSERT', 'INSERT', 'ROLLBACK']);
});

test('LAN pilot Compose: only the proxy publishes, only on the configured address and port, with only the server certificate', () => {
  const compose = read('infra/compose/docker-compose.lan-pilot.yml');
  const proxy = service(compose, 'proxy');
  const published = [...compose.matchAll(/^\s+ports:\n((?:\s+- .*\n)+)/gmu)].map((match) => match[1].trim());
  assert.deepEqual(published, [
    '- "${PILOT_BIND_ADDRESS:?PILOT_BIND_ADDRESS is required; run npm run pilot:configure}:${PILOT_PORT:?PILOT_PORT is required}:443"',
  ]);
  const directives = compose.replaceAll(/^\s*#.*\n/gmu, '');
  assert.doesNotMatch(directives, /0\.0\.0\.0|127\.0\.0\.1:8443|:80"/u);
  assert.match(proxy, /target: lan-pilot/u);
  assert.match(proxy, /PILOT_HOST: \$\{PILOT_HOST:\?/u);
  assert.match(proxy, /networks: \[app, edge\]/u);
  assert.match(proxy, /source: \$\{PILOT_TLS_DIR:\?[^}]*\}\n\s+target: \/etc\/nginx\/tls\n\s+read_only: true/u);
  assert.equal(proxy.match(/source:/gu).length, 1, 'the proxy mounts exactly one host directory');
  assert.doesNotMatch(compose, /tls\/ca|ca-key|\.local\/tls/u, 'the authority and the transport certificate are never mounted');
  assert.match(proxy, /cap_drop: \[ALL\]/u);
});

test('LAN pilot TLS: the authority is constrained to exactly this pilot; the server certificate meets the Apple rules', () => {
  const byAddress = parsePilotArguments(['--address', '192.168.1.50']);
  const byName = parsePilotArguments(['--address', '192.168.1.50', '--hostname', 'pc.local']);
  assert.equal(nameConstraints(byAddress), 'critical,permitted;IP:192.168.1.50/255.255.255.255,permitted;DNS:lan-pilot.invalid');
  assert.equal(nameConstraints(byName), 'critical,permitted;IP:192.168.1.50/255.255.255.255,permitted;DNS:pc.local');
  assert.equal(subjectAltName(byAddress), 'IP:192.168.1.50');
  assert.equal(subjectAltName(byName), 'IP:192.168.1.50,DNS:pc.local');

  const ca = renderCaConfig(byAddress, { label: '2026-11-09 abcdef' });
  assert.match(ca, /^basicConstraints = critical,CA:TRUE,pathlen:0$/mu);
  assert.match(ca, /^keyUsage = critical,keyCertSign,cRLSign$/mu);
  assert.match(ca, /^nameConstraints = critical,permitted;IP:192\.168\.1\.50\/255\.255\.255\.255,/mu);
  assert.match(ca, /^CN = Running Tracker LAN pilot CA 2026-11-09 abcdef$/mu);
  assert.doesNotMatch(renderCaConfig(byAddress, { constrained: false, label: 'x' }), /nameConstraints/u);

  const server = renderServerConfig(byName);
  assert.match(server, /^basicConstraints = critical,CA:FALSE$/mu);
  assert.match(server, /^extendedKeyUsage = serverAuth$/mu);
  assert.match(server, /^subjectAltName = IP:192\.168\.1\.50,DNS:pc\.local$/mu);
  // A host-like common name would be checked against the DNS constraint by OpenSSL and refused.
  assert.match(server, /^CN = Running Tracker LAN pilot server$/mu);

  const steps = opensslSteps(byName);
  assert.deepEqual(steps.map((step) => step[0]), ['req', 'req', 'x509', 'verify']);
  assert.ok(steps[0].includes('rsa:3072') && steps[1].includes('rsa:2048'));
  assert.ok(steps.slice(0, 3).every((step) => step.includes('-sha256')));
  assert.equal(steps[0][steps[0].indexOf('-days') + 1], String(caValidityDays));
  assert.equal(steps[2][steps[2].indexOf('-days') + 1], String(serverValidityDays));
  assert.ok(serverValidityDays <= 397 && caValidityDays <= 397);
  assert.deepEqual(steps[3].slice(0, 4), ['verify', '-x509_strict', '-purpose', 'sslserver']);
  assert.ok(steps[3].includes('-verify_ip') && steps[3].includes('pc.local'));
  // Every path is inside the one mounted directory.
  assert.ok(steps.flat().filter((arg) => arg.startsWith('/')).every((arg) => arg.startsWith('/tls/')));
});

test('LAN pilot TLS: output stays under .local/lan-pilot, nothing is overwritten, and a failed run keeps nothing', () => {
  const parent = mkdtempSync(join(tmpdir(), 'lan-pilot-tls-'));
  try {
    const tlsPaths = pilotPaths(parent);
    const files = certificateFiles(tlsPaths);
    for (const path of Object.values(files)) {
      assert.ok(path.startsWith(join(parent, '.local', 'lan-pilot')), path);
    }
    assert.ok(files.phone.startsWith(tlsPaths.phone) && files.phone.endsWith('.cer'));
    const settings = parsePilotArguments(['--address', '192.168.1.50']);

    // A failing OpenSSL step after some files were written: they are all removed again.
    const calls = [];
    assert.throws(
      () =>
        issuePilotCertificates({
          paths: tlsPaths,
          runOpenssl: (args) => {
            calls.push(args[0]);
            writeFileSync(files.caKey, 'written by the first step');
            writeFileSync(files.caCert, 'written by the first step');
            if (calls.length === 2) throw new Error('openssl req failed; nothing was kept');
          },
          settings,
        }),
      /nothing was kept/u,
    );
    assert.deepEqual(calls, ['req', 'req']);
    assert.deepEqual(existingCertificateFiles(tlsPaths), []);
    assert.equal(existsSync(join(tlsPaths.tls, 'work')), false, 'the work directory with the configs is removed');

    // An existing file (here the server key) is never overwritten, and OpenSSL is never started.
    mkdirSync(tlsPaths.server, { recursive: true });
    writeFileSync(files.serverKey, 'existing');
    assert.throws(
      () => issuePilotCertificates({ paths: tlsPaths, runOpenssl: () => assert.fail('must not run'), settings }),
      /Refusing to overwrite[\s\S]*server-key\.pem/u,
    );
    assert.equal(readFileSync(files.serverKey, 'utf8'), 'existing');
  } finally {
    rmSync(parent, { force: true, recursive: true });
  }
});

test('LAN pilot proxy: one configured host, 421 for any other, and the SSE and header policy of the deployment site', () => {
  const site = read('infra/proxy/lan-pilot-site.conf.template');
  const servers = site.split(/\nserver \{/u).slice(1);
  assert.equal(servers.length, 3);
  const [health, fallback, pilot] = servers;
  assert.match(health, /listen 80 default_server;/u);
  assert.match(health, /location \/ \{\n\s+return 404;/u);
  assert.doesNotMatch(health, /proxy_pass|root /u);
  assert.match(fallback, /listen 443 ssl default_server;/u);
  assert.match(fallback, /return 421;/u);
  assert.doesNotMatch(fallback, /proxy_pass|root |try_files/u, 'an unconfigured Host reaches neither the API nor the app');
  assert.match(pilot, /server_name \$\{PILOT_HOST\};/u);
  assert.ok(site.match(/\$\{[A-Z_]+\}/gu).every((name) => name === '${PILOT_HOST}'));
  for (const server of [fallback, pilot]) {
    assert.match(server, /ssl_certificate \/etc\/nginx\/tls\/server-cert\.pem;/u);
    assert.match(server, /ssl_protocols TLSv1\.2 TLSv1\.3;/u);
  }
  const start = pilot.indexOf('location ~ ^/api/orgs/');
  const live = pilot.slice(start, pilot.indexOf('\n  }', start));
  for (const directive of [
    'proxy_http_version 1.1;',
    'proxy_buffering off;',
    'proxy_cache off;',
    'proxy_next_upstream off;',
    'proxy_read_timeout 75s;',
    'gzip off;',
    'proxy_pass_header X-Accel-Buffering;',
  ]) {
    assert.ok(live.includes(directive), `SSE location lost ${directive}`);
  }
  for (const body of [...site.matchAll(/\n {2}location [^{]+\{([\s\S]*?)\n {2}\}/gu)].map((match) => match[1])) {
    if (/add_header|return 421/u.test(body)) assert.match(body, /include \/etc\/nginx\/snippets\/security-headers\.conf;/u, body);
  }
  assert.doesNotMatch(site, /access_log\s+(?!off;)|log_format|error_log/u, 'the site keeps the logs of the base configuration');
  assert.doesNotMatch(site, /Access-Control-Allow-Origin|proxy_ssl_verify off/u);
});

test('LAN pilot verification: certificate validation stays on, and the pilot browser test stays out of the normal suites', () => {
  const verifier = read('scripts/verify-lan-pilot.mjs');
  assert.match(verifier, /rejectUnauthorized: true/u);
  assert.doesNotMatch(verifier, /rejectUnauthorized: false|NODE_TLS_REJECT_UNAUTHORIZED|checkServerIdentity: \(\) => undefined/u);
  const browserConfig = read('tests/e2e/playwright.lan-pilot.config.ts');
  assert.match(browserConfig, /ignoreHTTPSErrors: false/u);
  // Only the one-key allow-list; never the switch that accepts every certificate.
  assert.doesNotMatch(browserConfig, /--ignore-certificate-errors['"`\s,]|ignoreHTTPSErrors: true/u);
  assert.match(browserConfig, /--ignore-certificate-errors-spki-list=\$\{pilot\.serverSpkiSha256\}/u);
  assert.doesNotMatch(browserConfig, /webServer/u, 'the pilot suite starts nothing; it tests the running pilot');
  assert.match(read('tests/e2e/playwright.config.ts'), /name: 'chromium', testIgnore: \/\[\\\\\/\]\(\?:oidc\|lan-pilot\)\[\\\\\/\]\//u);
  assert.match(read('tests/e2e/lan-pilot/pilot-browser.spec.ts'), /expect\(security\?\.issuer\)\.toBe\(pilot\.caCommonName\)/u);
});

test('LAN pilot image: its own stages, the deployment nginx configuration, and no change to the other images', () => {
  const dockerfile = read('infra/proxy/Dockerfile').replaceAll(/^#.*\n/gmu, '');
  const stage = (name) => {
    const start = dockerfile.search(new RegExp(`^FROM .* AS ${name}$`, 'mu'));
    assert.ok(start >= 0, `stage ${name} is missing`);
    const next = dockerfile.slice(start + 1).search(/^FROM /mu);
    return next < 0 ? dockerfile.slice(start) : dockerfile.slice(start, start + 1 + next);
  };
  const webPilot = stage('web-build-lan-pilot');
  assert.match(webPilot, /^FROM web-build AS web-build-lan-pilot$/mu);
  assert.match(webPilot, /^RUN VITE_LOCAL_DEMO_ENABLED=true npx vite build --mode lan-pilot --outDir dist-lan-pilot$/mu);
  // The flag is set for that one command only, never as image configuration the ordinary build could inherit.
  assert.doesNotMatch(dockerfile, /^(?:ENV|ARG) VITE_LOCAL_DEMO_ENABLED/mu);
  assert.doesNotMatch(stage('web-build'), /lan-pilot|VITE_LOCAL_DEMO_ENABLED/u);
  const pilot = stage('lan-pilot');
  assert.match(pilot, /^COPY infra\/proxy\/nginx\.production\.conf \/etc\/nginx\/nginx\.conf$/mu);
  assert.match(pilot, /^COPY infra\/proxy\/security-headers\.conf \/etc\/nginx\/snippets\/security-headers\.conf$/mu);
  assert.match(pilot, /^COPY infra\/proxy\/lan-pilot-site\.conf\.template \/etc\/nginx\/templates\/site\.conf\.template$/mu);
  assert.match(pilot, /^COPY --from=web-build-lan-pilot \/app\/apps\/web\/dist-lan-pilot \/usr\/share\/nginx\/html$/mu);
  for (const name of ['production', 'transport']) {
    assert.match(stage(name), /^COPY --from=web-build \/app\/apps\/web\/dist \/usr\/share\/nginx\/html$/mu, name);
    assert.doesNotMatch(stage(name), /lan-pilot/u, name);
  }
  assert.equal([...dockerfile.matchAll(/^FROM .* AS (\S+)$/gmu)].at(-1)[1], 'transport');
});

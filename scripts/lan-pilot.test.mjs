import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
    assert.match(service(compose, name), /networks: \[data\]/u, `${name} must stay on the internal data network`);
  }
  assert.match(compose, /\n {2}data:\n {4}internal: true\n/u);
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

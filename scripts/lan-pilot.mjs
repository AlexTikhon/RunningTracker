// The iPhone LAN pilot's commands (docs/runbooks/iphone-lan-pilot.md):
//   npm run pilot:configure -- --address <private IPv4 of this computer> [--hostname <name.local>] [--port 8443]
//   npm run pilot:tls [-- --without-name-constraints]
//   npm run pilot:up | pilot:status | pilot:down [-- --delete-data]
// Everything it writes is under .local/lan-pilot/ (ignored by git). It never edits .env, the firewall or a trust store,
// and it only ever addresses its own Compose project.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
  composeArguments,
  isLocalInterfaceAddress,
  parsePilotArguments,
  parsePilotEnv,
  pilotDatabase,
  pilotPaths,
  renderPilotEnv,
} from './lan-pilot-config.mjs';
import { certificateFiles, issuePilotCertificates } from './lan-pilot-tls.mjs';
import { buildProductionSecrets, writeProductionSecrets } from './production-secrets.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const paths = pilotPaths(repositoryRoot);
const secretNames = Object.keys(buildProductionSecrets({ database: pilotDatabase, randomBytes }));
const pilotProxyImage = 'running-tracker-proxy:lan-pilot';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function docker(args) {
  const result = spawnSync('docker', args, { cwd: repositoryRoot, stdio: 'inherit' });
  if (result.error) fail(`Could not run docker: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function readSettings() {
  if (!existsSync(paths.env)) fail('No pilot configuration. Run npm run pilot:configure -- --address <this computer\'s LAN address> first.');
  return parsePilotEnv(readFileSync(paths.env, 'utf8'));
}

function requireSecrets() {
  const missing = secretNames.filter((name) => !existsSync(join(paths.secrets, name)));
  if (missing.length > 0) fail(`The pilot's secret set is incomplete (missing ${missing.join(', ')}). Run npm run pilot:configure again.`);
}

function configure(argv) {
  const settings = parsePilotArguments(argv);
  if (!isLocalInterfaceAddress(settings.bindAddress, networkInterfaces())) {
    fail(
      `${settings.bindAddress} is not an address of this computer. Use the IPv4 address of the Wi-Fi adapter that ` +
        'the phone shares (ipconfig, "Wireless LAN adapter Wi-Fi", "IPv4 Address").',
    );
  }
  mkdirSync(paths.directory, { recursive: true });
  if (existsSync(paths.env)) {
    const existing = parsePilotEnv(readFileSync(paths.env, 'utf8'));
    if (existing.origin !== settings.origin || existing.bindAddress !== settings.bindAddress) {
      fail(
        `The pilot is already configured for ${existing.origin} (bound to ${existing.bindAddress}). Its certificate and ` +
          'allowed origin belong to that address. To change it: npm run pilot:down, delete .local/lan-pilot/pilot.env ' +
          'and .local/lan-pilot/tls, then configure again (see the runbook).',
      );
    }
    console.info(`Unchanged: ${paths.env} already holds ${settings.origin}.`);
  } else {
    writeFileSync(paths.env, renderPilotEnv(settings, paths));
    console.info(`Wrote ${paths.env}: ${settings.origin}, bound to ${settings.bindAddress} only.`);
  }

  const present = secretNames.filter((name) => existsSync(join(paths.secrets, name)));
  if (present.length === secretNames.length) {
    console.info(`Kept the existing secret set in ${paths.secrets}.`);
  } else if (present.length === 0) {
    writeProductionSecrets(paths.secrets, { database: pilotDatabase, randomBytes });
    console.info(`Wrote random database passwords and a cursor key to ${paths.secrets} (the pilot's own, never reused).`);
  } else {
    fail(`${paths.secrets} holds an incomplete secret set (${present.join(', ')}). Delete the directory, then configure again.`);
  }
  console.info('Next: npm run pilot:up');
}

function tls(argv) {
  const settings = readSettings();
  const constrained = !argv.includes('--without-name-constraints');
  const unknown = argv.filter((value) => value !== '--without-name-constraints');
  if (unknown.length > 0) fail(`Unknown argument ${unknown[0]}`);
  // OpenSSL comes from the pilot proxy image, so nothing is installed on this computer.
  docker([...composeArguments(paths), 'build', 'proxy']);
  const summary = issuePilotCertificates({
    constrained,
    paths,
    runOpenssl: (args) => {
      const result = spawnSync(
        'docker',
        ['run', '--rm', '--network', 'none', '--entrypoint', 'openssl', '--volume', `${paths.tls}:/tls`, pilotProxyImage, ...args],
        { cwd: repositoryRoot, stdio: 'inherit' },
      );
      if (result.error || result.status !== 0) throw new Error(`openssl ${args[0]} failed; nothing was kept`);
    },
    settings,
  });
  console.info('');
  console.info(`Pilot certificate authority: ${summary.caSubject}`);
  console.info(`  SHA-256 fingerprint: ${summary.caFingerprint256}`);
  console.info(`  valid until ${summary.caValidTo}; ${constrained ? `limited to ${summary.serverSubjectAltName}` : 'WITHOUT name constraints (fallback)'}`);
  console.info(`Server certificate for ${summary.serverSubjectAltName}, valid until ${summary.serverValidTo}`);
  console.info('');
  console.info(`For the phone (public certificate only): ${summary.phoneFile}`);
  console.info(`Keep private, never send: ${certificateFiles(paths).caKey}`);
  console.info('Install and trust it on the phone as the runbook describes, comparing the fingerprint above. Next: npm run pilot:up');
}

function up() {
  const settings = readSettings();
  requireSecrets();
  const files = certificateFiles(paths);
  if (!existsSync(files.serverCert) || !existsSync(files.serverKey)) fail('No pilot server certificate. Run npm run pilot:tls first.');
  docker([...composeArguments(paths), 'up', '--detach', '--build', '--wait', '--wait-timeout', '300']);
  console.info(`The LAN pilot is running for ${settings.origin}. Synthetic demo data only.`);
}

function down(argv) {
  readSettings();
  const deleteData = argv.includes('--delete-data');
  const unknown = argv.filter((value) => value !== '--delete-data');
  if (unknown.length > 0) fail(`Unknown argument ${unknown[0]}`);
  docker([...composeArguments(paths), 'down', ...(deleteData ? ['--volumes'] : [])]);
  console.info(deleteData ? 'Stopped the pilot and deleted its database volume.' : 'Stopped the pilot; its database volume is kept.');
}

const [command, ...argv] = process.argv.slice(2);
try {
  switch (command) {
    case 'configure':
      configure(argv);
      break;
    case 'tls':
      tls(argv);
      break;
    case 'up':
      up();
      break;
    case 'down':
      down(argv);
      break;
    case 'status':
      readSettings();
      docker([...composeArguments(paths), 'ps', '--all']);
      break;
    default:
      fail('Usage: node scripts/lan-pilot.mjs configure|tls|up|down|status (see docs/runbooks/iphone-lan-pilot.md)');
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

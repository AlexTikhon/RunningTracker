// Shared, side-effect-free parts of the iPhone LAN pilot (docs/runbooks/iphone-lan-pilot.md): its fixed names, the
// validation of the one private address it may publish on, the local configuration file, and the guards that keep its
// one-shot init job on its own database. Everything it writes lives under .local/lan-pilot/, which git ignores.
import { join } from 'node:path';

/** A Compose project of its own: its containers, network and volume never share a name with the development stack. */
export const pilotProject = 'running-tracker-lan-pilot';
/** The pilot's own database name, so a misrouted connection fails instead of reading another database. */
export const pilotDatabase = 'running_tracker_lan_pilot';
/** The pilot's PostgreSQL volume as Docker names it (project prefix + the Compose volume key). */
export const pilotVolume = `${pilotProject}_lan_pilot_postgres`;
export const pilotComposeFile = 'infra/compose/docker-compose.lan-pilot.yml';
export const defaultPilotPort = 8443;

// Names a person may give the pilot besides its address: special-use or private suffixes only, so the pilot's
// certificate authority can never be made to cover a public domain name.
const privateNameSuffixes = ['.local', '.home.arpa', '.internal', '.lan'];

export function pilotPaths(repositoryRoot) {
  const directory = join(repositoryRoot, '.local', 'lan-pilot');
  const tls = join(directory, 'tls');
  return {
    ca: join(tls, 'ca'),
    directory,
    env: join(directory, 'pilot.env'),
    phone: join(directory, 'phone'),
    secrets: join(directory, 'secrets'),
    server: join(tls, 'server'),
    tls,
  };
}

/** The four octets of a dotted-quad IPv4 address, or null. No leading zeros, no shorthand forms. */
export function parseIpv4(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/u.test(value)) return null;
  const octets = value.split('.').map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** RFC 1918 space only: 10/8, 172.16/12, 192.168/16. Loopback, link-local, CGNAT and public addresses are not. */
export function isPrivateIpv4(octets) {
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function requirePrivateAddress(value) {
  const octets = parseIpv4(value);
  if (!octets) {
    throw new Error(`--address must be an IPv4 address such as 192.168.1.50 (got ${JSON.stringify(value)})`);
  }
  if (!isPrivateIpv4(octets)) {
    throw new Error(
      `--address ${value} is not a private LAN address (10.x, 172.16-31.x or 192.168.x). The pilot never listens on ` +
        'every interface, on loopback or on a public address.',
    );
  }
  const last = octets[3];
  if (last === 0 || last === 255) {
    throw new Error(`--address ${value} looks like a network or broadcast address; use this computer's own address`);
  }
  return value;
}

export function requirePrivateHostname(value) {
  const name = typeof value === 'string' ? value.toLowerCase() : '';
  const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/u;
  if (name.length === 0 || name.length > 253 || !name.split('.').every((part) => label.test(part))) {
    throw new Error(`--hostname must be a DNS name such as my-pc.local (got ${JSON.stringify(value)})`);
  }
  if (parseIpv4(name)) throw new Error('--hostname must be a name; pass an address with --address');
  if (!privateNameSuffixes.some((suffix) => name.endsWith(suffix) && name.length > suffix.length)) {
    throw new Error(`--hostname must end in ${privateNameSuffixes.join(', ')}: the pilot never names a public domain`);
  }
  return name;
}

export function requirePilotPort(value) {
  const port = /^[0-9]{1,5}$/u.test(String(value)) ? Number(value) : Number.NaN;
  if (port !== 443 && !(port >= 1024 && port <= 65_535)) {
    throw new Error(`--port must be 443 or an integer from 1024 to 65535 (got ${JSON.stringify(value)})`);
  }
  return port;
}

/** `--address <ip> [--hostname <name>] [--port <n>]`; anything else is refused. */
export function parsePilotArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--address', '--hostname', '--port'].includes(flag)) throw new Error(`Unknown argument ${String(flag)}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    if (Object.hasOwn(values, flag)) throw new Error(`${flag} was given twice`);
    values[flag] = value;
  }
  if (values['--address'] === undefined) throw new Error('--address is required: the private LAN address of this computer');
  return pilotSettings({
    address: values['--address'],
    hostname: values['--hostname'] ?? null,
    port: values['--port'] ?? defaultPilotPort,
  });
}

/**
 * The validated identity of one pilot: the address Docker binds (never 0.0.0.0), the host the browser uses (the name if
 * one was given, else the address), and the one origin the API accepts, exactly as Safari sends it.
 */
export function pilotSettings({ address, hostname, port }) {
  const bindAddress = requirePrivateAddress(address);
  const name = hostname === null || hostname === undefined || hostname === '' ? null : requirePrivateHostname(hostname);
  const pilotPort = requirePilotPort(port);
  const host = name ?? bindAddress;
  return Object.freeze({
    bindAddress,
    host,
    hostname: name,
    origin: pilotPort === 443 ? `https://${host}` : `https://${host}:${pilotPort}`,
    port: pilotPort,
  });
}

/** True when `address` is assigned to one of this computer's non-internal IPv4 interfaces (os.networkInterfaces()). */
export function isLocalInterfaceAddress(address, interfaces) {
  return Object.values(interfaces)
    .flat()
    .some((entry) => entry && !entry.internal && (entry.family === 'IPv4' || entry.family === 4) && entry.address === address);
}

const posixPath = (path) => path.replaceAll('\\', '/');

/** The Compose --env-file. Absolute forward-slash paths, so Docker Desktop on Windows mounts the right directories. */
export function renderPilotEnv(settings, paths) {
  return [
    '# Written by `npm run pilot:configure`. Local to this computer; git ignores .local/.',
    '# Synthetic demo data only: see docs/runbooks/iphone-lan-pilot.md.',
    `PILOT_BIND_ADDRESS=${settings.bindAddress}`,
    `PILOT_HOSTNAME=${settings.hostname ?? ''}`,
    `PILOT_HOST=${settings.host}`,
    `PILOT_PORT=${settings.port}`,
    `PILOT_ORIGIN=${settings.origin}`,
    `PILOT_SECRETS_DIR=${posixPath(paths.secrets)}`,
    `PILOT_TLS_DIR=${posixPath(paths.server)}`,
    '',
  ].join('\n');
}

/** Reads the file back and validates it again: a hand-edited file gets the same checks as the command line. */
export function parsePilotEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(`pilot.env: cannot read the line ${JSON.stringify(line)}`);
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const settings = pilotSettings({
    address: values.PILOT_BIND_ADDRESS,
    hostname: values.PILOT_HOSTNAME,
    port: values.PILOT_PORT,
  });
  if (values.PILOT_HOST !== settings.host || values.PILOT_ORIGIN !== settings.origin) {
    throw new Error('pilot.env: PILOT_HOST and PILOT_ORIGIN do not match the address, name and port; run pilot:configure again');
  }
  return settings;
}

export function composeArguments(paths) {
  return ['compose', '--project-name', pilotProject, '--file', pilotComposeFile, '--env-file', paths.env];
}

/** The init job seeds as the table owner, so it may write only to the pilot's database on the pilot's server. */
export function requireLanPilotDatabase(databaseUrl) {
  if (!databaseUrl) throw new Error('MIGRATION_DATABASE_URL is required');
  const url = new URL(databaseUrl);
  if (decodeURIComponent(url.username) !== 'running_tracker_owner') {
    throw new Error('MIGRATION_DATABASE_URL must authenticate as running_tracker_owner');
  }
  if (url.hostname !== 'postgres') {
    throw new Error("Refusing to seed: the LAN pilot seeds only its own Compose service 'postgres'");
  }
  if (decodeURIComponent(url.pathname.slice(1)) !== pilotDatabase) {
    throw new Error(`Refusing to seed demo data anywhere but the database ${pilotDatabase}`);
  }
}

// Shared, side-effect-free parts of the local demo (docs/runbooks/demo.md): fixed identities, a
// deterministic simulated route, argument parsing and the guards that keep the demo local.

/** Fixed, obviously synthetic identifiers. They exist only in the plain development database. */
export const demoIds = Object.freeze({
  coach: 'dddddddd-dddd-4ddd-8ddd-dddddddd0002',
  organization: 'dddddddd-dddd-4ddd-8ddd-dddddddd0000',
  runner: 'dddddddd-dddd-4ddd-8ddd-dddddddd0001',
});

export const demoExternalIdentities = Object.freeze({
  coach: 'demo-coach',
  runner: 'demo-runner',
});

const pointIntervalMs = 2_000;
const stepMetres = 8; // 4 m/s, about 4:10 per kilometre
const radiusMetres = 80;
const metresPerDegreeLatitude = 111_320;
const centreLatitude = 52.2297;
const centreLongitude = 21.0122;
const maximumPoints = 5_000;
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * A runner circling a point at constant speed, one measurement every two seconds, with a fixed
 * small accuracy pattern. `recordedAt` is `startMs + index * 2 s`, so sending each point when its
 * time arrives keeps it inside the live-freshness window.
 */
export function demoRoute({ count, startMs }) {
  if (!Number.isInteger(count) || count < 1 || count > maximumPoints) {
    throw new RangeError(`count must be an integer from 1 to ${maximumPoints}`);
  }
  const angleStep = stepMetres / radiusMetres;
  const cosine = Math.cos((centreLatitude * Math.PI) / 180);
  return Array.from({ length: count }, (_, index) => {
    const angle = index * angleStep;
    const north = radiusMetres * Math.sin(angle);
    const east = radiusMetres * Math.cos(angle);
    return {
      accuracyM: 4 + (index % 3),
      latitude: round(centreLatitude + north / metresPerDegreeLatitude),
      longitude: round(centreLongitude + east / (metresPerDegreeLatitude * cosine)),
      recordedAt: new Date(startMs + index * pointIntervalMs).toISOString(),
      segmentId: 0,
      seq: String(index + 1),
    };
  });
}

function round(value) {
  return Math.round(value * 10_000_000) / 10_000_000;
}

function loopbackUrl(flag, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${flag} must be an http(s) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${flag} must be an http(s) URL`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${flag} must not contain credentials`);
  }
  if (!loopbackHosts.has(url.hostname)) {
    throw new Error(`${flag} must point at a loopback host: the demo never talks to a remote service`);
  }
  return url.origin;
}

export function parseDemoRunArguments(argv) {
  const parsed = { apiUrl: 'http://127.0.0.1:3000', origin: 'http://127.0.0.1:5173', points: 60 };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== '--points' && flag !== '--api-url' && flag !== '--origin') {
      throw new Error(`Unknown argument ${String(flag)}`);
    }
    if (value === undefined) {
      throw new Error(`${flag} needs a value`);
    }
    if (flag === '--points') {
      if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > maximumPoints) {
        throw new Error(`--points must be an integer from 1 to ${maximumPoints}`);
      }
      parsed.points = Number(value);
    } else if (flag === '--api-url') {
      parsed.apiUrl = loopbackUrl(flag, value);
    } else {
      parsed.origin = loopbackUrl(flag, value);
    }
  }
  return parsed;
}

const sessionCookieName = 'running_tracker_session';

/** The one `name=value` pair of the session cookie, from `Set-Cookie` header values. */
export function extractSessionCookie(setCookie) {
  const pairs = setCookie
    .map((header) => header.split(';', 1)[0].trim())
    .filter((pair) => pair.startsWith(`${sessionCookieName}=`) && pair.length > sessionCookieName.length + 1);
  if (pairs.length !== 1) {
    throw new Error('The response did not carry exactly one session cookie');
  }
  return pairs[0];
}

/** The seed writes as the table owner, so it is limited to the plain local development database. */
export function requireDevelopmentDatabase(databaseUrl) {
  if (!databaseUrl) {
    throw new Error('MIGRATION_DATABASE_URL is required. Copy .env.example to .env or set it explicitly.');
  }
  const url = new URL(databaseUrl);
  if (decodeURIComponent(url.username) !== 'running_tracker_owner') {
    throw new Error('MIGRATION_DATABASE_URL must authenticate as running_tracker_owner');
  }
  if (!loopbackHosts.has(url.hostname)) {
    throw new Error('Refusing to seed demo data into a database that is not on a loopback host');
  }
  if (url.pathname.slice(1) !== 'running_tracker') {
    throw new Error('Refusing to seed demo data anywhere but the database running_tracker');
  }
}

/** The load runner only ever talks to a dedicated database whose name ends in this suffix. */
export const loadRunnerDatabaseSuffixes = ['_load_test'] as const;

export const loadTargetVariables = [
  'LOAD_DATABASE_URL',
  'LOAD_RUNTIME_DATABASE_URL',
  'LOAD_MAINTENANCE_DATABASE_URL',
] as const;

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export interface DatabaseRole {
  connectionString: string;
  user: string;
}

export interface LoadTarget {
  database: string;
  host: string;
  maintenance: DatabaseRole;
  owner: DatabaseRole;
  port: string;
  runtime: DatabaseRole;
}

interface ParsedUrl {
  connectionString: string;
  database: string;
  host: string;
  port: string;
  user: string;
}

function parseRoleUrl(
  variable: string,
  connectionString: string | undefined,
  expectedUser: string,
  allowedSuffixes: readonly string[],
): ParsedUrl {
  // Messages name the variable only: connection strings carry passwords.
  if (!connectionString) {
    throw new Error(`${variable} is required`);
  }
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${variable} must be a valid PostgreSQL URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${variable} must use the postgres or postgresql protocol`);
  }
  if (['database', 'dbname', 'host', 'hostaddr', 'port', 'user'].some((name) => url.searchParams.has(name))) {
    throw new Error(`${variable} must not override connection identity in query parameters`);
  }
  let database: string;
  let user: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    user = decodeURIComponent(url.username);
  } catch {
    throw new Error(`${variable} contains invalid percent-encoding`);
  }
  if (user !== expectedUser) {
    throw new Error(`${variable} must authenticate as ${expectedUser}`);
  }
  if (!allowedSuffixes.some((suffix) => database.endsWith(suffix))) {
    throw new Error(`${variable} must name a dedicated database ending in ${allowedSuffixes.join(' or ')}`);
  }
  const host = url.hostname.toLowerCase();
  if (!loopbackHosts.has(host)) {
    throw new Error(`${variable} must point at a loopback host: the load runner never targets a remote database`);
  }
  return { connectionString, database, host, port: url.port || '5432', user };
}

/**
 * Validates the three role URLs of the dedicated load database. It fails closed: a missing variable, a
 * database outside the allowed suffixes, a non-loopback host, or URLs that disagree about the target are all
 * refusals, and no message contains a password.
 */
export function parseLoadTarget(
  environment: Readonly<Record<string, string | undefined>>,
  allowedSuffixes: readonly string[],
): LoadTarget {
  const owner = parseRoleUrl('LOAD_DATABASE_URL', environment.LOAD_DATABASE_URL, 'running_tracker_owner', allowedSuffixes);
  const runtime = parseRoleUrl(
    'LOAD_RUNTIME_DATABASE_URL',
    environment.LOAD_RUNTIME_DATABASE_URL,
    'running_tracker_runtime',
    allowedSuffixes,
  );
  const maintenance = parseRoleUrl(
    'LOAD_MAINTENANCE_DATABASE_URL',
    environment.LOAD_MAINTENANCE_DATABASE_URL,
    'running_tracker_maintenance',
    allowedSuffixes,
  );
  for (const other of [runtime, maintenance]) {
    if (other.host !== owner.host || other.port !== owner.port || other.database !== owner.database) {
      throw new Error('The owner, runtime, and maintenance URLs must name the same host, port, and database');
    }
  }
  return {
    database: owner.database,
    host: owner.host,
    maintenance: { connectionString: maintenance.connectionString, user: maintenance.user },
    owner: { connectionString: owner.connectionString, user: owner.user },
    port: owner.port,
    runtime: { connectionString: runtime.connectionString, user: runtime.user },
  };
}

export interface Queryable {
  query: (text: string) => Promise<{ rows: Record<string, string>[] }>;
}

/**
 * The URL says where a connection should land; this asks the live session where it did land (a proxy, a
 * server-side default, or an environment override could differ) before anything else touches it.
 */
export async function assertConnectedIdentity(
  client: Queryable,
  expected: { database: string; user: string },
  allowedSuffixes: readonly string[],
): Promise<void> {
  const result = await client.query('SELECT current_database() AS current_database, current_user AS current_user');
  const row = result.rows[0];
  if (!row) {
    throw new Error('The database did not report its identity');
  }
  if (row.current_database !== expected.database) {
    throw new Error('The connected database is not the one the URL named');
  }
  if (row.current_user !== expected.user) {
    throw new Error('The connected role is not the one the URL named');
  }
  if (!allowedSuffixes.some((suffix) => (row.current_database ?? '').endsWith(suffix))) {
    throw new Error(`The connected database does not end in ${allowedSuffixes.join(' or ')}`);
  }
}

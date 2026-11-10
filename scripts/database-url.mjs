// Connection-URL checks shared by the migration and bootstrap scripts (F05). They mirror the API configuration parser
// (apps/api/src/config/environment.ts): node-postgres lets query parameters override the user, host, port and database
// of a URL, so a check of the URL's authority alone would validate one login while pg connects as another. Those
// overrides are refused, and after connecting the scripts ask the server who and where they are before any statement
// that changes the schema.

const identityParameters = ['database', 'dbname', 'host', 'port', 'user'];

/**
 * Parses and checks one PostgreSQL URL. Returns the URL with its decoded user and database.
 * @param {string | undefined} value
 * @param {string} variableName
 * @param {{ expectedUser?: string, requirePassword?: boolean, requireTestDatabase?: boolean }} [options]
 */
export function parseDatabaseUrl(value, variableName, options = {}) {
  if (!value) {
    throw new Error(`${variableName} is required. Copy .env.example to .env or set it explicitly.`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(`${variableName} must use the postgres or postgresql protocol`);
  }
  const overrides = identityParameters.filter((name) => url.searchParams.has(name));
  if (overrides.length > 0) {
    throw new Error(`${variableName} must not override connection identity in query parameters (${overrides.join(', ')})`);
  }
  let user;
  let database;
  try {
    user = decodeURIComponent(url.username);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error(`${variableName} contains invalid percent-encoding`);
  }
  if (options.expectedUser !== undefined && user !== options.expectedUser) {
    throw new Error(`${variableName} must authenticate as ${options.expectedUser}`);
  }
  if (options.requirePassword && !url.password) {
    throw new Error(`${variableName} must include the role password for bootstrap`);
  }
  if (options.requireTestDatabase && !database.endsWith('_test')) {
    throw new Error(`${variableName} must target a database ending in _test`);
  }
  return { database, url, user };
}

/**
 * Asks the connected server for current_user and current_database() and refuses to go on unless both are the expected
 * ones. Run it before the first statement that creates or changes anything. An empty `user` (a URL without one, where
 * pg falls back to PGUSER) checks the database only.
 * @param {{ query: (text: string) => Promise<{ rows: Array<Record<string, unknown>> }> }} client
 * @param {{ database: string, user: string }} expected
 * @param {string} variableName
 */
export async function assertConnectedIdentity(client, expected, variableName) {
  const result = await client.query('SELECT current_user AS role_name, current_database() AS database_name');
  const row = result.rows[0] ?? {};
  const roleMatches = expected.user === '' || row.role_name === expected.user;
  if (!roleMatches || row.database_name !== expected.database) {
    throw new Error(
      `${variableName} connected as role ${String(row.role_name)} to database ${String(row.database_name)}, ` +
        `not as ${expected.user || 'the URL user'} to ${expected.database}; nothing was changed`,
    );
  }
}

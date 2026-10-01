/**
 * Fail-closed rules for the backup/restore drill. The drill creates, fills, restores into, and drops
 * databases, so every database it touches must be one it named itself and every connection must stay on
 * the local machine. Error messages name variables and rules only; they never contain a password.
 */

export const drillDatabasePrefix = 'running_tracker_restore_drill';

const maximumDatabaseNameLength = 63;
const drillNamePattern = /^running_tracker_restore_drill(?:_[a-z0-9]+)*$/u;
const suffixPattern = /^[a-z0-9]{1,24}$/u;
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const containerNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

export function assertDrillDatabaseName(name: string): void {
  if (
    name.length === 0 ||
    name.length > maximumDatabaseNameLength ||
    name.includes('\u0000') ||
    !drillNamePattern.test(name)
  ) {
    throw new Error(
      `The database name must be a restore drill database (${drillDatabasePrefix}, optionally followed by lowercase _suffix parts)`,
    );
  }
}

/** Every DROP DATABASE in the drill goes through this check. */
export function assertDatabaseMayBeDropped(name: string): void {
  try {
    assertDrillDatabaseName(name);
  } catch {
    throw new Error('Refusing to drop a database that is not a restore drill database');
  }
}

const applicationRoles = {
  maintenance: 'running_tracker_maintenance',
  owner: 'running_tracker_owner',
  runtime: 'running_tracker_runtime',
} as const;

const urlVariables = {
  admin: 'RESTORE_DRILL_ADMIN_URL',
  maintenance: 'RESTORE_DRILL_MAINTENANCE_URL',
  owner: 'RESTORE_DRILL_OWNER_URL',
  runtime: 'RESTORE_DRILL_RUNTIME_URL',
} as const;

export interface DrillConfiguration {
  admin: { password: string; user: string };
  dockerContainer: string | undefined;
  host: string;
  keyFile: string;
  maintenance: { password: string };
  owner: { password: string };
  port: string;
  runtime: { password: string };
}

interface ParsedUrl {
  database: string;
  host: string;
  password: string;
  port: string;
  user: string;
}

function parseUrl(variable: string, value: string | undefined): ParsedUrl {
  if (!value) {
    throw new Error(`${variable} is required`);
  }
  let url: URL;
  try {
    url = new URL(value);
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
  let password: string;
  let user: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    password = decodeURIComponent(url.password);
    user = decodeURIComponent(url.username);
  } catch {
    throw new Error(`${variable} contains invalid percent-encoding`);
  }
  const host = url.hostname.toLowerCase();
  if (!loopbackHosts.has(host)) {
    throw new Error(`${variable} must point at a loopback host: the restore drill never targets a remote database`);
  }
  return { database, host, password, port: url.port || '5432', user };
}

/** Validates the four connection URLs and the key file before the drill does anything. */
export function parseDrillConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): DrillConfiguration {
  const admin = parseUrl(urlVariables.admin, environment.RESTORE_DRILL_ADMIN_URL);
  if (Object.values(applicationRoles).includes(admin.user as (typeof applicationRoles)[keyof typeof applicationRoles])) {
    throw new Error(`${urlVariables.admin} must authenticate as the PostgreSQL administrator, not an application role`);
  }
  if (admin.database !== 'postgres') {
    throw new Error(`${urlVariables.admin} must name the server maintenance database postgres`);
  }

  const roles = {} as Record<keyof typeof applicationRoles, ParsedUrl>;
  for (const role of ['owner', 'runtime', 'maintenance'] as const) {
    const variable = urlVariables[role];
    const parsed = parseUrl(variable, environment[variable]);
    if (parsed.user !== applicationRoles[role]) {
      throw new Error(`${variable} must authenticate as ${applicationRoles[role]}`);
    }
    try {
      assertDrillDatabaseName(parsed.database);
    } catch {
      throw new Error(`${variable} must name a restore drill database (${drillDatabasePrefix}...)`);
    }
    if (parsed.host !== admin.host || parsed.port !== admin.port) {
      throw new Error(`${variable} and ${urlVariables.admin} must name the same host and port`);
    }
    roles[role] = parsed;
  }

  const keyFile = environment.BACKUP_ENCRYPTION_KEY_FILE;
  if (!keyFile) {
    throw new Error('BACKUP_ENCRYPTION_KEY_FILE is required');
  }
  const dockerContainer = environment.BACKUP_PG_DOCKER_CONTAINER || undefined;
  if (dockerContainer !== undefined && !containerNamePattern.test(dockerContainer)) {
    throw new Error('BACKUP_PG_DOCKER_CONTAINER must be a plain Docker container name or ID');
  }

  return {
    admin: { password: admin.password, user: admin.user },
    dockerContainer,
    host: admin.host,
    keyFile,
    maintenance: { password: roles.maintenance.password },
    owner: { password: roles.owner.password },
    port: admin.port,
    runtime: { password: roles.runtime.password },
  };
}

export interface DrillSide {
  adminUrl: string;
  database: string;
  maintenanceUrl: string;
  ownerUrl: string;
  runtimeUrl: string;
}

export interface DrillDatabases {
  /** The server's maintenance database, used only for CREATE/DROP DATABASE and catalog reads. */
  adminMaintenanceUrl: string;
  source: DrillSide;
  suffix: string;
  target: DrillSide;
}

function urlFor(
  configuration: DrillConfiguration,
  user: string,
  password: string,
  database: string,
): string {
  const host = configuration.host.includes(':') && !configuration.host.startsWith('[') ? `[${configuration.host}]` : configuration.host;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${configuration.port}/${encodeURIComponent(database)}`;
}

function sideFor(configuration: DrillConfiguration, database: string): DrillSide {
  assertDrillDatabaseName(database);
  return {
    adminUrl: urlFor(configuration, configuration.admin.user, configuration.admin.password, database),
    database,
    maintenanceUrl: urlFor(configuration, applicationRoles.maintenance, configuration.maintenance.password, database),
    ownerUrl: urlFor(configuration, applicationRoles.owner, configuration.owner.password, database),
    runtimeUrl: urlFor(configuration, applicationRoles.runtime, configuration.runtime.password, database),
  };
}

/** Names the source and target databases for one drill run. Both always carry the drill prefix. */
export function deriveDrillDatabases(configuration: DrillConfiguration, suffix: string): DrillDatabases {
  if (!suffixPattern.test(suffix)) {
    throw new Error('The drill suffix must be 1 to 24 lowercase letters or digits');
  }
  return {
    adminMaintenanceUrl: urlFor(configuration, configuration.admin.user, configuration.admin.password, 'postgres'),
    source: sideFor(configuration, `${drillDatabasePrefix}_${suffix}_source`),
    suffix,
    target: sideFor(configuration, `${drillDatabasePrefix}_${suffix}_target`),
  };
}

/**
 * The SDD requires a fixed order before a restored database may be returned to the application. This
 * tool performs the first ten steps; the last (restoring current memberships, shares and credentials,
 * P12.4) is deliberately never completed here, so the drill cannot declare the database open.
 */
export const recoverySteps = [
  'application_offline',
  'database_created',
  'roles_and_postgis_bootstrapped',
  'backup_restored',
  'migrations_applied',
  'migration_checksums_verified',
  'journal_copy_readonly',
  'deletions_reapplied',
  'deletion_outcomes_verified',
  'readiness_verified',
  'current_permissions_restored',
] as const;

export type RecoveryStep = (typeof recoverySteps)[number];

export interface RecoveryTracker {
  complete(step: RecoveryStep): void;
  completed(): RecoveryStep[];
  pending(): RecoveryStep[];
}

export function createRecoveryTracker(): RecoveryTracker {
  const done: RecoveryStep[] = [];
  return {
    complete(step) {
      const expected = recoverySteps[done.length];
      if (step !== expected) {
        throw new Error(`Recovery step ${step} is out of order: expected ${expected ?? 'none'}`);
      }
      done.push(step);
    },
    completed: () => [...done],
    pending: () => recoverySteps.slice(done.length),
  };
}

/** The only gate the drill has in front of "open the restored database to the application". */
export function assertRecoveryComplete(tracker: RecoveryTracker): void {
  const pending = tracker.pending();
  if (pending.length > 0) {
    throw new Error(
      `The application must not be opened before the recovery steps are complete; pending: ${pending.join(', ')}`,
    );
  }
}

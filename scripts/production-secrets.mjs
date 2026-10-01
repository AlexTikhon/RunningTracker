import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const database = 'running_tracker';
const host = 'postgres';

// The four database logins of the P02A separation. The administrator is the image's
// superuser and is mounted only into the one-shot bootstrap/migration job.
const databaseLogins = [
  { file: 'bootstrap-database-url', user: 'running_tracker_admin', reusesPostgresPassword: true },
  { file: 'migration-database-url', user: 'running_tracker_owner' },
  { file: 'runtime-database-url', user: 'running_tracker_runtime' },
  { file: 'maintenance-database-url', user: 'running_tracker_maintenance' },
];

// Rotated without touching the superuser: db-init re-applies these passwords on its next run.
const roleRotationFiles = ['migration-database-url', 'runtime-database-url', 'maintenance-database-url'];

function randomHex(randomBytes) {
  return randomBytes(32).toString('hex');
}

/**
 * Builds the production secret set as a `{ fileName: content }` map. Passwords are 256 random
 * bits as hex, so they need no URL escaping. `randomBytes` is injected for determinism in tests.
 */
export function buildProductionSecrets({ randomBytes }) {
  const secrets = { 'postgres-password': randomHex(randomBytes) };

  for (const { file, reusesPostgresPassword, user } of databaseLogins) {
    const password = reusesPostgresPassword ? secrets['postgres-password'] : randomHex(randomBytes);
    secrets[file] = `postgresql://${user}:${password}@${host}:5432/${database}`;
  }

  secrets['cursor-signing-key'] = randomBytes(32).toString('base64url');
  return secrets;
}

/**
 * Writes one file per secret into `directory` (mode 0700). Files are 0444: a container process
 * running as an unrelated uid must read a bind-mounted secret, so the directory, not the file,
 * is the access boundary on the host. Refuses to overwrite unless `force` is set, because
 * regenerating the set rotates every credential. `rotateRoles` instead replaces only the three
 * application logins in an existing set (see roleRotationFiles).
 */
export function writeProductionSecrets(
  directory,
  { force = false, randomBytes, rotateRoles = false },
) {
  const secrets = buildProductionSecrets({ randomBytes });
  const names = rotateRoles ? roleRotationFiles : Object.keys(secrets);

  if (rotateRoles) {
    // The administrator password is fixed when PostgreSQL first initializes its data directory, so
    // it, and the cursor key, must be kept; only the logins the bootstrap job re-applies rotate.
    const missing = Object.keys(secrets).filter((name) => !existsSync(join(directory, name)));
    if (missing.length > 0) {
      throw new Error(
        `cannot rotate: the existing secret set in ${directory} is incomplete (missing ${missing.join(', ')})`,
      );
    }
  } else {
    mkdirSync(directory, { mode: 0o700, recursive: true });
  }
  const existing = names.filter((name) => existsSync(join(directory, name)));
  if (existing.length > 0 && !force && !rotateRoles) {
    throw new Error(
      `${existing.join(', ')} already exists in ${directory}; regenerating rotates every credential, pass --force to do it`,
    );
  }

  for (const name of names) {
    const path = join(directory, name);
    if (existsSync(path)) {
      chmodSync(path, 0o600);
    }
    writeFileSync(path, `${secrets[name]}\n`, { mode: 0o600 });
    chmodSync(path, 0o444);
  }
  chmodSync(directory, 0o700);

  return names;
}

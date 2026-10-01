import { mkdir, open, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { systemClock, type Clock } from '../clock.js';
import { createBackup, readSourceFacts, writeBackupMetricsFile, type SourceFacts } from './backup-create.js';
import { createBackupDecryptor, verifyBackupFile } from './backup-envelope.js';
import { generateBackupKeyFile, loadBackupKey } from './backup-key.js';
import { defaultRetentionDays, pruneBackups } from './backup-store.js';
import { resolveOperatorPath } from './operator-paths.js';
import {
  createPgToolRunner,
  formatPgConnection,
  parsePgConnection,
  type PgConnection,
  type PgToolRunner,
} from './pg-tools.js';

const usage = [
  'Usage:',
  '  BACKUP_DATABASE_URL=... BACKUP_ENCRYPTION_KEY_FILE=... [BACKUP_PG_DOCKER_CONTAINER=...] npm run backup:create -- --out-dir <dir> [--metrics-file <file>]',
  '  BACKUP_ENCRYPTION_KEY_FILE=... npm run backup:verify -- --file <backup>',
  '  BACKUP_ENCRYPTION_KEY_FILE=... npm run backup:decrypt -- --file <backup> --out <new file for the pg_restore archive>',
  '  npm run backup:prune -- --dir <dir> [--retention-days 7] [--allow-remove-last]',
  '  npm run backup:keygen -- --out <absolute path of a new key file>',
].join('\n');

export type BackupArguments =
  | { command: 'create'; metricsFile?: string; outDir: string }
  | { allowRemoveLast: boolean; command: 'prune'; dir: string; retentionDays: number }
  | { command: 'keygen'; out: string }
  | { command: 'decrypt'; file: string; out: string }
  | { command: 'verify'; file: string };

export function parseBackupArguments(argv: readonly string[]): BackupArguments {
  const [command, ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    if (!flag.startsWith('--')) throw new Error(usage);
    if (flag === '--allow-remove-last') {
      flags.set(flag, true);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(usage);
    flags.set(flag, value);
    index += 1;
  }
  const take = (name: string, allowed: readonly string[]): string | undefined => {
    for (const key of flags.keys()) {
      if (!allowed.includes(key)) throw new Error(usage);
    }
    const value = flags.get(name);
    return typeof value === 'string' ? value : undefined;
  };

  if (command === 'create') {
    const outDir = take('--out-dir', ['--out-dir', '--metrics-file']);
    if (!outDir) throw new Error(usage);
    const metricsFile = take('--metrics-file', ['--out-dir', '--metrics-file']);
    return { command, ...(metricsFile ? { metricsFile } : {}), outDir };
  }
  if (command === 'verify') {
    const file = take('--file', ['--file']);
    if (!file) throw new Error(usage);
    return { command, file };
  }
  if (command === 'decrypt') {
    const file = take('--file', ['--file', '--out']);
    const out = take('--out', ['--file', '--out']);
    if (!file || !out) throw new Error(usage);
    return { command, file, out };
  }
  if (command === 'keygen') {
    const out = take('--out', ['--out']);
    if (!out) throw new Error(usage);
    return { command, out };
  }
  if (command === 'prune') {
    const allowed = ['--dir', '--retention-days', '--allow-remove-last'];
    const dir = take('--dir', allowed);
    const days = take('--retention-days', allowed);
    if (!dir) throw new Error(usage);
    if (days !== undefined && !/^\d{1,4}$/u.test(days)) throw new Error(usage);
    return {
      allowRemoveLast: flags.get('--allow-remove-last') === true,
      command,
      dir,
      retentionDays: days === undefined ? defaultRetentionDays : Number(days),
    };
  }
  throw new Error(usage);
}

export interface BackupCliDependencies {
  argv: readonly string[];
  clock?: Pick<Clock, 'utcNow'>;
  env: Readonly<Record<string, string | undefined>>;
  log?: (line: string) => void;
  readSourceFacts?: (connection: PgConnection) => Promise<SourceFacts>;
  runner?: PgToolRunner;
}

function isInside(child: string, parent: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path !== '' && !path.startsWith('..') && !isAbsolute(path) && !path.startsWith(`..${sep}`);
}

/**
 * Operator entry point for backups. It prints technical facts only: never the connection string, the
 * password, or any key material. Failures throw; the caller turns them into a non-zero exit code.
 */
export async function runBackupCli(dependencies: BackupCliDependencies): Promise<number> {
  const log = dependencies.log ?? ((line: string) => console.info(line));
  const parsed = parseBackupArguments(dependencies.argv);
  const clock = dependencies.clock ?? systemClock;

  if (parsed.command === 'keygen') {
    const { path } = await generateBackupKeyFile(resolveOperatorPath(dependencies.env, parsed.out));
    log(`backup key file created: ${path}`);
    log('Store it separately from the backups it protects; a backup directory that also holds the key is not an off-host design.');
    return 0;
  }

  if (parsed.command === 'prune') {
    const report = await pruneBackups(resolveOperatorPath(dependencies.env, parsed.dir), {
      allowRemoveLast: parsed.allowRemoveLast,
      now: clock.utcNow(),
      retentionDays: parsed.retentionDays,
    });
    log(`retention days: ${report.retentionDays}`);
    for (const name of report.removed) log(`removed: ${name}`);
    log(`kept: ${report.kept}`);
    if (report.keptLastBackup) {
      log('The newest backup is expired but was kept because it is the only one left; pass --allow-remove-last to remove it.');
    }
    return 0;
  }

  const key = await loadBackupKey(dependencies.env.BACKUP_ENCRYPTION_KEY_FILE);

  if (parsed.command === 'verify') {
    const { metadata, plaintextBytes } = await verifyBackupFile(resolveOperatorPath(dependencies.env, parsed.file), key);
    log('authenticated: yes');
    log(`format version: ${metadata.formatVersion}`);
    log(`algorithm: ${metadata.algorithm}`);
    log(`dump format: ${metadata.dump.format}`);
    log(`created at: ${metadata.createdAt}`);
    log(`source database: ${metadata.source.database}`);
    log(`postgresql: ${metadata.postgres.serverVersion}`);
    log(`postgis: ${metadata.postgres.postgisVersion ?? 'none'}`);
    log(`migrations: ${metadata.application.migrationCount} (last ${metadata.application.lastMigration ?? 'none'})`);
    log(`plaintext bytes: ${plaintextBytes}`);
    return 0;
  }

  if (parsed.command === 'decrypt') {
    const input = resolveOperatorPath(dependencies.env, parsed.file);
    const output = resolveOperatorPath(dependencies.env, parsed.out);
    // Authenticate the whole file first: nothing unauthenticated is ever written.
    const { plaintextBytes } = await verifyBackupFile(input, key);
    await mkdir(dirname(output), { recursive: true });
    let handle;
    try {
      handle = await open(output, 'wx', 0o600);
    } catch (error) {
      throw new Error(
        (error as NodeJS.ErrnoException).code === 'EEXIST'
          ? 'The output file already exists and is never overwritten'
          : 'The output file cannot be created',
        { cause: error },
      );
    }
    try {
      const { stream } = await createBackupDecryptor(input, key);
      await pipeline(stream, handle.createWriteStream());
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(output, { force: true });
      throw error;
    }
    log('authenticated: yes');
    log(`plaintext bytes: ${plaintextBytes}`);
    log(`written: ${output}`);
    log('The output is an unencrypted database dump: restrict access to it and delete it after the restore.');
    return 0;
  }

  const databaseUrl = dependencies.env.BACKUP_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('BACKUP_DATABASE_URL is required');
  }
  const connection = parsePgConnection(databaseUrl);
  const keyFile = dependencies.env.BACKUP_ENCRYPTION_KEY_FILE;
  const outDirectory = resolveOperatorPath(dependencies.env, parsed.outDir);
  if (keyFile && isInside(keyFile, outDirectory)) {
    throw new Error('The backup encryption key must not be stored in the backup directory');
  }
  const dockerContainer = dependencies.env.BACKUP_PG_DOCKER_CONTAINER || undefined;
  const runner =
    dependencies.runner ?? createPgToolRunner(dockerContainer ? { dockerContainer } : {});
  const created = await createBackup({
    clock,
    connection,
    directory: outDirectory,
    key,
    ...(dependencies.readSourceFacts
      ? { readSourceFacts: dependencies.readSourceFacts }
      : { readSourceFacts: (value: PgConnection) => readSourceFacts(formatPgConnection(value)) }),
    runner,
  });
  if (parsed.metricsFile) {
    await writeBackupMetricsFile(resolveOperatorPath(dependencies.env, parsed.metricsFile), {
      createdAt: new Date(created.createdAt),
      durationMs: created.durationMs,
      sizeBytes: created.sizeBytes,
    });
  }
  log(`backup created: ${created.fileName}`);
  log(`created at: ${created.createdAt}`);
  log(`size bytes: ${created.sizeBytes}`);
  log(`duration ms: ${created.durationMs}`);
  log('authenticated: yes (read back after writing)');
  return 0;
}

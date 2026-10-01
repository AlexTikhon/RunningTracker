import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { systemClock } from '../clock.js';
import { runRestoreDrill, type DrillReport } from './restore-drill.js';
import { createRestoreDrillOperations, dropLeftoverDrillDatabases, repositoryRoot } from './restore-drill-operations.js';
import { resolveOperatorPath } from './operator-paths.js';
import { renderDrillReportMarkdown } from './restore-drill-report.js';
import { parseDrillConfiguration } from './restore-safety.js';

const execFileAsync = promisify(execFile);

const usage =
  'Usage: npm run restore:drill -- [--suffix <lowercase letters/digits>] [--keep] [--current-schema] [--work-dir <dir>] [--report-md <file>] [--report-json <file>]\n' +
  '       npm run restore:drill -- --cleanup\n' +
  'Needs RESTORE_DRILL_ADMIN_URL, RESTORE_DRILL_OWNER_URL, RESTORE_DRILL_RUNTIME_URL, RESTORE_DRILL_MAINTENANCE_URL, ' +
  'BACKUP_ENCRYPTION_KEY_FILE and, to run the PostgreSQL tools in a container, BACKUP_PG_DOCKER_CONTAINER.';

export interface DrillArguments {
  cleanup: boolean;
  keep: boolean;
  reportJson?: string;
  reportMarkdown?: string;
  /** `previous` migrates the source one migration short of the repository, so the restore must catch up. */
  sourceSchema: 'current' | 'previous';
  suffix: string;
  workDirectory?: string;
}

function defaultSuffix(now: Date): string {
  return now
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/gu, '')
    .replace('T', 't');
}

export function parseDrillArguments(argv: readonly string[], now: Date): DrillArguments {
  let cleanup = false;
  let keep = false;
  let sourceSchema: DrillArguments['sourceSchema'] = 'previous';
  let suffix: string | undefined;
  let workDirectory: string | undefined;
  let reportMarkdown: string | undefined;
  let reportJson: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === '--cleanup') {
      cleanup = true;
      continue;
    }
    if (flag === '--keep') {
      keep = true;
      continue;
    }
    if (flag === '--current-schema') {
      sourceSchema = 'current';
      continue;
    }
    const value = argv[index + 1];
    if (!['--suffix', '--work-dir', '--report-md', '--report-json'].includes(flag) || value === undefined || value.startsWith('--')) {
      throw new Error(usage);
    }
    index += 1;
    if (flag === '--suffix') suffix = value;
    else if (flag === '--work-dir') workDirectory = value;
    else if (flag === '--report-md') reportMarkdown = value;
    else reportJson = value;
  }
  if (cleanup && (keep || sourceSchema === 'current' || suffix || workDirectory || reportMarkdown || reportJson)) {
    throw new Error(usage);
  }
  const chosen = suffix ?? defaultSuffix(now);
  if (!/^[a-z0-9]{1,24}$/u.test(chosen)) {
    throw new Error(`The suffix must be 1 to 24 lowercase letters or digits. ${usage}`);
  }
  return {
    cleanup,
    keep,
    ...(reportJson ? { reportJson } : {}),
    ...(reportMarkdown ? { reportMarkdown } : {}),
    sourceSchema,
    suffix: chosen,
    ...(workDirectory ? { workDirectory } : {}),
  };
}

async function applicationCommit(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repositoryRoot });
    const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: repositoryRoot });
    return `${stdout.trim()}${status.stdout.trim() ? ' (with uncommitted changes)' : ''}`;
  } catch {
    return 'unknown';
  }
}

export interface DrillCliDependencies {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  log?: (line: string) => void;
}

export async function runDrillCli(dependencies: DrillCliDependencies): Promise<number> {
  const log = dependencies.log ?? ((line: string) => console.info(line));
  const parsed = parseDrillArguments(dependencies.argv, systemClock.utcNow());
  const configuration = parseDrillConfiguration(dependencies.env);

  if (parsed.cleanup) {
    const dropped = await dropLeftoverDrillDatabases(configuration);
    for (const name of dropped) log(`dropped: ${name}`);
    log(`drill databases dropped: ${dropped.length}`);
    return 0;
  }

  const workDirectory = parsed.workDirectory
    ? resolveOperatorPath(dependencies.env, parsed.workDirectory)
    : join(repositoryRoot, '.local', 'restore-drill', parsed.suffix);
  const commands: string[] = [`npm run restore:drill -- ${dependencies.argv.join(' ')}`.trim()];
  const { operations } = createRestoreDrillOperations({
    configuration,
    onCommand: (command) => commands.push(command),
    sourceSchema: parsed.sourceSchema,
    suffix: parsed.suffix,
    workDirectory,
  });

  log(`restore drill ${parsed.suffix}: running (this takes about a minute)`);
  const { exitCode, report } = await runRestoreDrill({
    clock: systemClock,
    operations,
    options: { commands, commit: await applicationCommit(), keep: parsed.keep },
  });

  const markdown = renderDrillReportMarkdown(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const targets: [string, string][] = [
    [join(workDirectory, 'report.md'), markdown],
    [join(workDirectory, 'report.json'), json],
  ];
  if (parsed.reportMarkdown) targets.push([resolveOperatorPath(dependencies.env, parsed.reportMarkdown), markdown]);
  if (parsed.reportJson) targets.push([resolveOperatorPath(dependencies.env, parsed.reportJson), json]);
  for (const [path, contents] of targets) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
  }

  summarize(report, log);
  return exitCode;
}

function summarize(report: DrillReport, log: (line: string) => void): void {
  if (report.status === 'passed') {
    log('DRILL RESULT');
    log(`- measured local drill RTO: ${(report.rto.measuredMs / 1000).toFixed(1)} s`);
    log('- SDD target: <= 4 hours');
    log('- production RTO status: not established by this workstation drill');
    log(`- measured drill RPO exposure: ${(report.rpo.backupRecoveryPointMs / 1000).toFixed(1)} s (SDD target: <= 24 hours)`);
    log('- current permissions: restored and verified against the lost source (revoked shares and deactivated memberships)');
    log('- application access: closed (the drill never reopens the database; see docs/runbooks/backup-and-restore.md)');
  } else {
    log(`DRILL FAILED at ${report.failure?.step ?? 'unknown'}: ${report.failure?.message ?? ''}`);
    log('Both drill databases were kept. Drop them with: npm run restore:drill -- --cleanup');
  }
  log(`report written: ${report.cleanup === 'kept' || report.status === 'failed' ? 'databases kept' : 'databases dropped'}`);
}

import { reapplyOutcomes } from '../restore/reapply-deletions.js';
import type { DrillReport } from './restore-drill.js';

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) {
    const seconds = Math.round(ms / 100) / 10;
    return `${seconds} s`;
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 3600) {
    return `${Math.floor(totalSeconds / 60)} min ${totalSeconds % 60} s`;
  }
  return `${Math.floor(totalSeconds / 3600)} h ${Math.floor((totalSeconds % 3600) / 60)} min`;
}

function mebibytes(bytes: number): string {
  if (bytes < 1048576) return `${(Math.round((bytes / 1024) * 10) / 10).toString()} KiB`;
  return `${(Math.round((bytes / 1048576) * 10) / 10).toString()} MiB`;
}

function table(rows: readonly (readonly [string, string])[]): string {
  return ['| Item | Value |', '|---|---|', ...rows.map(([name, value]) => `| ${name} | ${value} |`)].join('\n');
}

function outcomeRows(run: NonNullable<DrillReport['journal']['firstPass']>): string {
  return reapplyOutcomes.map((name) => `${name}: ${run.outcomes[name]}`).join(', ');
}

/**
 * Human-readable drill report. Every number comes from the drill's own measurements. The wording keeps
 * local drill evidence apart from any production claim, and a failed drill never reads as a success.
 */
export function renderDrillReportMarkdown(report: DrillReport): string {
  const passed = report.status === 'passed';
  const environment = report.environment;
  const out: string[] = [];

  out.push('# P12.3 — Backup / restore drill report', '');
  out.push(
    `Generated: ${report.generatedAt}. Application commit: ${report.application.commit}. Result: **${passed ? 'passed' : 'failed'}**.`,
    '',
  );

  if (!passed) {
    out.push('## DRILL FAILED', '');
    out.push(
      `The drill stopped at step \`${report.failure?.step ?? 'unknown'}\`: ${report.failure?.message ?? 'no message'}`,
      '',
      'Nothing was reported as recovered, the restored application was not started, and both drill databases were kept for diagnosis (drop them with `npm run restore:drill -- --cleanup`).',
      '',
    );
  } else {
    out.push('## DRILL RESULT', '');
    out.push(`- measured local drill RTO: ${formatDuration(report.rto.measuredMs)}`);
    out.push('- SDD target: <= 4 hours');
    out.push('- production RTO status: not established by this workstation drill', '');
    out.push(
      `The isolated drill achieved an RPO exposure of ${formatDuration(report.rpo.backupRecoveryPointMs)}. Production RPO remains subject to the real backup schedule, storage durability, and target environment.`,
      '',
    );
  }

  out.push('## Checks', '');
  out.push('| Check | Result |', '|---|---|');
  for (const check of report.checks) {
    out.push(`| ${check.description} | ${check.passed ? 'pass' : 'FAIL'} |`);
  }
  if (report.checks.length === 0) out.push('| (no check was reached) | — |');
  out.push('');

  out.push('## Backup', '');
  out.push(
    table([
      ['backup format', report.backup.dumpFormat],
      ['envelope version', String(report.backup.envelopeVersion)],
      ['encryption algorithm', report.backup.algorithm],
      ['backup artifact size', mebibytes(report.backup.artifactBytes)],
      ['source database size', mebibytes(report.backup.sourceDatabaseBytes)],
      ['backup duration', formatDuration(report.backup.durationMs)],
      ['PostgreSQL / PostGIS', environment ? `PostgreSQL ${environment.postgres} / PostGIS ${environment.postgis}` : 'unknown'],
      ['client tools', environment ? `${environment.pgDump}; ${environment.pgRestore}; run ${environment.runnerMode === 'docker-exec' ? 'inside the database container (docker exec)' : 'locally'}` : 'unknown'],
    ]),
    '',
  );

  out.push('## Recovery timeline and measurements', '');
  out.push(
    table([
      ['backup_created_at', report.timeline.backupCreatedAt],
      ['deletions completed (after backup)', report.timeline.deletionsCompletedAt],
      ['journal exported', report.timeline.journalExportedAt],
      ['simulated_loss_at', report.timeline.simulatedLossAt],
      ['restore_started_at', report.timeline.restoreStartedAt],
      ['restore_completed_at', report.timeline.restoreCompletedAt],
      ['migration_completed_at', report.timeline.migrationCompletedAt],
      ['journal_reapply_started_at', report.timeline.journalReapplyStartedAt],
      ['journal_reapply_completed_at', report.timeline.journalReapplyCompletedAt],
      ['verification_completed_at', report.timeline.verificationCompletedAt],
      ['restore duration', formatDuration(report.durations.restoreMs)],
      ['migration duration', formatDuration(report.durations.migrationMs)],
      ['journal reapplication duration', formatDuration(report.durations.journalReapplyMs)],
      ['total recovery duration', formatDuration(report.durations.totalRecoveryMs)],
      [
        'measured drill RPO',
        `${formatDuration(report.rpo.backupRecoveryPointMs)} (simulated_loss_at − backup_created_at); SDD target <= 24 hours; within target in this drill: ${report.rpo.withinTarget ? 'yes' : 'NO'}`,
      ],
      [
        'measured drill RTO',
        `${formatDuration(report.rto.measuredMs)} (loss to verification complete); SDD target <= 4 hours; within target in this drill: ${report.rto.withinTarget ? 'yes' : 'NO'}`,
      ],
    ]),
    '',
  );

  out.push('## Migrations', '');
  const first = report.migration.firstRun;
  const second = report.migration.secondRun;
  const behind = report.migration.backupBehindBy;
  if (behind !== null) {
    out.push(
      behind === 0
        ? 'The backup was taken at the current schema of this repository (0 migrations behind).'
        : `The backup was ${behind} migration${behind === 1 ? '' : 's'} behind this repository: its source database was migrated with the latest ${behind} migration file${behind === 1 ? '' : 's'} withheld, using the unchanged migration runner.`,
      '',
    );
  }
  out.push(
    `The current migration runner ran after the restore: ${first ? `${first.applied} applied, ${first.skipped} skipped` : 'not reached'}. A second run was ${second ? `${second.applied === 0 ? 'a checksum-only no-op' : 'NOT a no-op'} (${second.applied} applied, ${second.skipped} skipped)` : 'not reached'}.`,
    '',
  );

  out.push('## Deletion journal reapplication', '');
  const exported = report.journal.exported;
  out.push(
    table([
      ['journal files', exported ? String(exported.files) : 'not reached'],
      ['journal entries', exported ? String(exported.entries) : 'not reached'],
      ['recovery copy read-only enforced by the file system', report.journal.recoveryCopyReadOnlyEnforced === null ? 'not reached' : report.journal.recoveryCopyReadOnlyEnforced ? 'yes' : 'no (content digest verified unchanged instead)'],
      ['first pass outcomes', report.journal.firstPass ? outcomeRows(report.journal.firstPass) : 'not reached'],
      ['second pass outcomes (idempotency)', report.journal.secondPass ? outcomeRows(report.journal.secondPass) : 'not reached'],
    ]),
    '',
  );
  out.push(
    'Fixture runs are labelled A, B, C and D; no identifier is printed. A: owner deletion after the backup. B: annual retention deletion after the backup (effective clock = real time; the fixture run finished 400 days earlier). C: untouched survivor. D: created and deleted after the backup, so the backup never contained it and only its tombstone is restored.',
    '',
  );

  out.push('## Roles and security', '');
  if (report.roles.length === 0) {
    out.push('Not reached.', '');
  } else {
    out.push('| Role | superuser | BYPASSRLS | CREATEDB | CREATEROLE |', '|---|---|---|---|---|');
    for (const role of report.roles) {
      out.push(`| ${role.name} | ${role.superuser} | ${role.bypassRls} | ${role.canCreateDatabase} | ${role.canCreateRole} |`);
    }
    out.push('');
  }

  out.push('## Recovery sequence and application access', '');
  out.push(`Completed in order: ${report.recovery.completedSteps.join(', ') || 'none'}.`, '');
  out.push(`Pending: ${report.recovery.pendingSteps.join(', ') || 'none'}.`, '');
  out.push(
    'Application access: closed. The restored database revokes CONNECT from the runtime and maintenance logins and no application process was started against it. Restoring current memberships, shares, credentials and revoked grants is P12.4; until it exists and has run, the database must not be opened to the application, so this drill never declares it safe for access.',
    '',
  );

  if (passed) {
    out.push('## VERIFIED IN LOCAL DRILL', '');
    out.push(
      '- A real pg_dump custom-format archive of a real PostgreSQL/PostGIS database was encrypted (AES-256-GCM, key from a separate file), written atomically, and read back and authenticated.',
      '- The archive was restored with pg_restore into a fresh, isolated database with the existing role model, then the current migration runner ran, and a second run was a checksum-only no-op.',
      '- Runs A and B existed in the backup with their points, summary and share. Their deletions (an owner deletion and an annual retention deletion) happened after the backup and were exported by the existing journal exporter.',
      '- After `restore:reapply-deletions` from a read-only copy of the journal, A and B had no run, point, summary or share rows, every deleted run had a tombstone of at least one year, and the archive revision advanced exactly once per deleted run. D received its tombstone. The surviving run C was unchanged.',
      '- A second reapplication was idempotent: only marker_present outcomes, and an identical database state.',
      '- The three application roles are not superuser and have no BYPASSRLS, CREATEDB or CREATEROLE.',
      '- Failure paths fail closed: wrong key, corrupted or truncated backup, malformed journal, migration checksum mismatch, and an out-of-order recovery step are covered by automated tests.',
      '',
    );
  }

  out.push('## NOT VERIFIED / REQUIRES REAL TARGET ENVIRONMENT', '');
  out.push(
    '- Production RPO. The backup here was taken seconds before the simulated loss; the real figure depends on the backup schedule actually running daily, the storage it writes to, and monitoring of backup age.',
    '- Production RTO. The measured time is one small database on one workstation with the database tools in a local container. It says nothing about the size, hardware, network or staffing of a real recovery.',
    '- That backups and the deletion journal are really off-host, durable, and in a different failure domain than the database. Here both are local directories.',
    '- Encryption key custody. The key was a local file. Storing it separately from the backups, backing it up, rotating it and recovering it are operator decisions that this repository does not solve.',
    '- Restoring current memberships, shares, credentials and revoked grants (P12.4). A restored backup can still contain access that was revoked after it was taken.',
    '- Production sign-in (P12.1): no identity provider is selected, so no end-to-end login was exercised.',
    '- Deletions that were committed but not yet exported when a node is lost (journal recovery point, ADR-0037), and a mount that accepts writes but is not durable.',
    '- Daily scheduling and 7-day retention running unattended on a host: the commands exist and are tested; nothing here ran on a schedule.',
    '',
  );

  out.push('## Commands', '');
  out.push('```text', ...report.commands, '```', '');
  return out.join('\n');
}

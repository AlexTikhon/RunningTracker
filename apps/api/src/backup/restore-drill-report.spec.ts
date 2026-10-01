import { describe, expect, it } from 'vitest';

import type { DrillReport } from './restore-drill.js';
import { formatDuration, renderDrillReportMarkdown } from './restore-drill-report.js';

function passedReport(): DrillReport {
  return {
    application: { commit: 'abc1234 (with uncommitted changes)' },
    backup: {
      algorithm: 'aes-256-gcm',
      artifactBytes: 2_400_000,
      createdAt: '2026-10-01T10:00:00.000Z',
      dumpFormat: 'pg_dump-custom',
      durationMs: 1800,
      envelopeVersion: 1,
      plaintextBytes: 2_399_900,
      sourceDatabaseBytes: 12_000_000,
    },
    checks: [
      { description: 'The restored database matches the database at backup time', id: 'restored-matches-backup', passed: true },
      { description: 'Deleted runs are absent', id: 'deleted-runs-absent-everywhere', passed: true },
    ],
    cleanup: 'dropped',
    commands: ['docker exec -i -e PGPASSWORD pg-1 pg_dump --format=custom --no-password', 'node scripts/migrate.mjs'],
    durations: { journalReapplyMs: 250, migrationMs: 900, restoreMs: 4200, totalRecoveryMs: 9100 },
    environment: {
      node: 'v24.11.1',
      pgDump: 'pg_dump (PostgreSQL) 17.5',
      pgRestore: 'pg_restore (PostgreSQL) 17.5',
      postgis: '3.5.2',
      postgres: '17.5',
      runnerMode: 'docker-exec',
    },
    generatedAt: '2026-10-01T10:05:00.000Z',
    journal: {
      exported: { entries: 3, files: 1, manifestDigest: 'abc' },
      firstPass: { entries: 3, files: 1, outcomes: { deleted: 2, expired: 0, marker_present: 0, marker_restored: 1, skipped_newer_run: 0, skipped_unknown_membership: 0, skipped_unknown_organization: 0 } },
      recoveryCopyReadOnlyEnforced: true,
      secondPass: { entries: 3, files: 1, outcomes: { deleted: 0, expired: 0, marker_present: 3, marker_restored: 0, skipped_newer_run: 0, skipped_unknown_membership: 0, skipped_unknown_organization: 0 } },
    },
    migration: { backupBehindBy: 1, firstRun: { applied: 1, skipped: 19 }, secondRun: { applied: 0, skipped: 20 } },
    recovery: {
      applicationAccess: 'closed',
      completedSteps: [
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
      ],
      pendingSteps: ['current_permissions_restored'],
    },
    roles: [
      { bypassRls: false, canCreateDatabase: false, canCreateRole: false, name: 'running_tracker_owner', superuser: false },
    ],
    rpo: { backupRecoveryPointMs: 300_000, targetMs: 86_400_000, withinTarget: true },
    rto: { measuredMs: 9100, targetMs: 14_400_000, withinTarget: true },
    schemaVersion: 1,
    status: 'passed',
    timeline: {
      backupCreatedAt: '2026-10-01T10:00:00.000Z',
      deletionsCompletedAt: '2026-10-01T10:02:00.000Z',
      journalExportedAt: '2026-10-01T10:02:05.000Z',
      journalReapplyCompletedAt: '2026-10-01T10:05:08.000Z',
      journalReapplyStartedAt: '2026-10-01T10:05:07.000Z',
      migrationCompletedAt: '2026-10-01T10:05:05.000Z',
      recoveryStartedAt: '2026-10-01T10:05:00.000Z',
      restoreCompletedAt: '2026-10-01T10:05:04.000Z',
      restoreStartedAt: '2026-10-01T10:05:01.000Z',
      simulatedLossAt: '2026-10-01T10:05:00.000Z',
      verificationCompletedAt: '2026-10-01T10:05:09.000Z',
    },
  };
}

describe('duration formatting', () => {
  it('uses units a person can read', () => {
    expect(formatDuration(250)).toBe('250 ms');
    expect(formatDuration(9100)).toBe('9.1 s');
    expect(formatDuration(185_000)).toBe('3 min 5 s');
    expect(formatDuration(3_725_000)).toBe('1 h 2 min');
    expect(formatDuration(0)).toBe('0 ms');
  });
});

describe('drill report', () => {
  it('states the drill result with the exact required wording and no production claim', () => {
    const text = renderDrillReportMarkdown(passedReport());

    expect(text).toContain('DRILL RESULT');
    expect(text).toContain('- measured local drill RTO: 9.1 s');
    expect(text).toContain('- SDD target: <= 4 hours');
    expect(text).toContain('- production RTO status: not established by this workstation drill');
    expect(text).toContain(
      'The isolated drill achieved an RPO exposure of 5 min 0 s. Production RPO remains subject to the real backup schedule, storage durability, and target environment.',
    );
    expect(text).not.toMatch(/Production RPO is 24 hours/iu);
    expect(text).not.toMatch(/production RPO (?:is|was) (?:achieved|met)/iu);
    expect(text).not.toMatch(/production RTO (?:is|was) (?:achieved|met)/iu);
  });

  it('separates what the local drill verified from what needs a real environment', () => {
    const text = renderDrillReportMarkdown(passedReport());
    const verified = text.indexOf('VERIFIED IN LOCAL DRILL');
    const notVerified = text.indexOf('NOT VERIFIED / REQUIRES REAL TARGET ENVIRONMENT');
    expect(verified).toBeGreaterThan(0);
    expect(notVerified).toBeGreaterThan(verified);
    const limits = text.slice(notVerified);
    for (const phrase of ['off-host', 'production RPO', 'production RTO', 'P12.4', 'key', 'P12.1']) {
      expect(limits.toLowerCase(), phrase).toContain(phrase.toLowerCase());
    }
  });

  it('reports every required measurement', () => {
    const text = renderDrillReportMarkdown(passedReport());
    for (const phrase of [
      'pg_dump-custom',
      'aes-256-gcm',
      '2.3 MiB',
      '11.4 MiB',
      'PostgreSQL 17.5',
      'PostGIS 3.5.2',
      'abc1234',
      'backup duration',
      'restore duration',
      'migration duration',
      'journal entries',
      'journal reapplication duration',
      'total recovery duration',
      'measured drill RPO',
      'measured drill RTO',
      'running_tracker_owner',
      'marker_present',
      'deleted',
    ]) {
      expect(text, phrase).toContain(phrase);
    }
    for (const command of passedReport().commands) {
      expect(text).toContain(command);
    }
  });

  it('states how far behind the repository the restored backup was and what the migration runner did', () => {
    const text = renderDrillReportMarkdown(passedReport());
    expect(text).toContain('The backup was 1 migration behind this repository');
    expect(text).toContain('1 applied, 19 skipped');
    expect(text).toContain('a checksum-only no-op (0 applied, 20 skipped)');
  });

  it('says plainly that the application was not opened and that P12.4 is pending', () => {
    const text = renderDrillReportMarkdown(passedReport());
    expect(text).toContain('Application access: closed');
    expect(text).toContain('current_permissions_restored');
    expect(text).toMatch(/P12\.4/u);
    expect(text).not.toMatch(/safe for application access/iu);
  });

  it('renders a failed drill as failed, with the step and message, and no success claim', () => {
    const report = passedReport();
    report.status = 'failed';
    report.failure = { message: 'Recovery verification failed: tombstones-present', step: 'verify-deletion-outcomes' };
    report.checks[1]!.passed = false;
    const text = renderDrillReportMarkdown(report);

    expect(text).toContain('DRILL FAILED');
    expect(text).toContain('verify-deletion-outcomes');
    expect(text).toContain('tombstones-present');
    expect(text).toContain('FAIL');
    expect(text).not.toContain('VERIFIED IN LOCAL DRILL');
    expect(text).not.toMatch(/drill passed/iu);
  });

  it('contains no connection string, password, key, or run identifier', () => {
    const text = renderDrillReportMarkdown(passedReport());
    expect(text).not.toMatch(/postgres(ql)?:\/\//u);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/u);
    expect(text).not.toMatch(/PGPASSWORD=\S/u);
  });
});

import { describe, expect, it } from 'vitest';

import {
  evaluateRecovery,
  runRestoreDrill,
  type DatabaseState,
  type DrillOperations,
  type ReapplyRun,
  type RunLabelState,
} from './restore-drill.js';
import { recoverySteps } from './restore-safety.js';

const absent: RunLabelState = { points: 0, run: false, shares: 0, summaries: 0, tombstone: null };
function present(points = 3): RunLabelState {
  return { points, run: true, shares: 1, summaries: 1, tombstone: null };
}
function tombstoned(): RunLabelState {
  return {
    ...absent,
    tombstone: { deletedAt: '2026-10-01T10:05:00.000Z', expiresAt: '2027-10-01T10:05:00.000Z' },
  };
}

const counts = {
  memberships: 2,
  organizations: 1,
  run_deletion_journal: 0,
  run_points: 9,
  run_shares: 3,
  run_summaries: 3,
  run_tombstones: 0,
  runs: 3,
  users: 2,
};

const atBackup: DatabaseState = {
  archiveRevision: '0',
  counts,
  runs: { A: present(), B: present(), C: present(), D: absent },
  survivorDigest: 'digest-c',
};
const restored: DatabaseState = structuredClone(atBackup);
const afterFirst: DatabaseState = {
  archiveRevision: '2',
  counts: { ...counts, run_deletion_journal: 2, run_points: 3, run_shares: 1, run_summaries: 1, run_tombstones: 3, runs: 1 },
  runs: { A: tombstoned(), B: tombstoned(), C: present(), D: tombstoned() },
  survivorDigest: 'digest-c',
};

const outcomes = (overrides: Partial<ReapplyRun['outcomes']>): ReapplyRun['outcomes'] => ({
  deleted: 0,
  expired: 0,
  marker_present: 0,
  marker_restored: 0,
  skipped_newer_run: 0,
  skipped_unknown_membership: 0,
  skipped_unknown_organization: 0,
  ...overrides,
});
const firstRun: ReapplyRun = { entries: 3, files: 1, outcomes: outcomes({ deleted: 2, marker_restored: 1 }) };
const secondRun: ReapplyRun = { entries: 3, files: 1, outcomes: outcomes({ marker_present: 3 }) };

function evaluate(overrides: Partial<Parameters<typeof evaluateRecovery>[0]> = {}) {
  return evaluateRecovery({
    afterFirst,
    afterSecond: structuredClone(afterFirst),
    atBackup,
    first: firstRun,
    restored,
    second: secondRun,
    ...overrides,
  });
}

describe('recovery evaluation', () => {
  it('passes when the backup restores exactly, deletions are reapplied once, and the second pass changes nothing', () => {
    const checks = evaluate();
    expect(checks.filter((check) => !check.passed)).toEqual([]);
    expect(checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        'restored-matches-backup',
        'deleted-runs-existed-in-backup',
        'first-pass-outcomes',
        'deleted-runs-absent-everywhere',
        'tombstones-present',
        'tombstone-expiry-at-least-one-year',
        'archive-revision-advanced-per-deletion',
        'survivor-untouched',
        'second-pass-idempotent',
        'second-pass-changes-nothing',
      ]),
    );
  });

  it('fails when the restored database differs from the database at backup time', () => {
    const wrong = structuredClone(restored);
    wrong.counts.run_points = 8;
    expect(evaluate({ restored: wrong }).find((check) => check.id === 'restored-matches-backup')?.passed).toBe(false);
  });

  it('fails when a deleted run is not in the backup, because the drill would prove nothing', () => {
    const wrong = structuredClone(restored);
    wrong.runs.A = absent;
    expect(evaluate({ restored: wrong }).find((check) => check.id === 'deleted-runs-existed-in-backup')?.passed).toBe(false);
  });

  it('fails when a deleted run keeps any row after reapplication (resurrection)', () => {
    for (const field of ['run', 'points', 'summaries', 'shares'] as const) {
      const resurrected = structuredClone(afterFirst);
      if (field === 'run') resurrected.runs.B.run = true;
      else resurrected.runs.B[field] = 1;
      const checks = evaluate({ afterFirst: resurrected, afterSecond: structuredClone(resurrected) });
      expect(checks.find((check) => check.id === 'deleted-runs-absent-everywhere')?.passed, field).toBe(false);
    }
  });

  it('fails when a tombstone is missing or expires in less than a year', () => {
    const missing = structuredClone(afterFirst);
    missing.runs.A.tombstone = null;
    expect(evaluate({ afterFirst: missing, afterSecond: structuredClone(missing) }).find((check) => check.id === 'tombstones-present')?.passed).toBe(false);

    const short = structuredClone(afterFirst);
    short.runs.A.tombstone = { deletedAt: '2026-10-01T10:05:00.000Z', expiresAt: '2027-09-01T00:00:00.000Z' };
    expect(
      evaluate({ afterFirst: short, afterSecond: structuredClone(short) }).find(
        (check) => check.id === 'tombstone-expiry-at-least-one-year',
      )?.passed,
    ).toBe(false);
  });

  it('fails when the archive revision advances other than once per deleted run', () => {
    const wrong = { ...afterFirst, archiveRevision: '3' };
    expect(
      evaluate({ afterFirst: wrong, afterSecond: structuredClone(wrong) }).find(
        (check) => check.id === 'archive-revision-advanced-per-deletion',
      )?.passed,
    ).toBe(false);
  });

  it('fails when the surviving run changed', () => {
    const wrong = structuredClone(afterFirst);
    wrong.survivorDigest = 'tampered';
    expect(evaluate({ afterFirst: wrong, afterSecond: structuredClone(wrong) }).find((check) => check.id === 'survivor-untouched')?.passed).toBe(false);
  });

  it('fails when the first pass reports unexpected outcomes', () => {
    const wrong = { ...firstRun, outcomes: outcomes({ deleted: 1, skipped_newer_run: 1, marker_restored: 1 }) };
    expect(evaluate({ first: wrong }).find((check) => check.id === 'first-pass-outcomes')?.passed).toBe(false);
  });

  it('fails when the second pass repeats a deletion or alters any state', () => {
    const repeated = { ...secondRun, outcomes: outcomes({ deleted: 1, marker_present: 2 }) };
    expect(evaluate({ second: repeated }).find((check) => check.id === 'second-pass-idempotent')?.passed).toBe(false);

    const changed = structuredClone(afterFirst);
    changed.archiveRevision = '3';
    expect(evaluate({ afterSecond: changed }).find((check) => check.id === 'second-pass-changes-nothing')?.passed).toBe(false);
  });

  it('never contains an identifier in a check description or detail', () => {
    for (const check of evaluate()) {
      expect(JSON.stringify(check)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
    }
  });
});

interface Harness {
  calls: string[];
  operations: DrillOperations;
}

function harness(fail?: { at: keyof DrillOperations; error?: Error }): Harness {
  const calls: string[] = [];
  const step =
    <T>(name: keyof DrillOperations, value: T) =>
    (): Promise<T> => {
      calls.push(name);
      if (fail?.at === name) return Promise.reject(fail.error ?? new Error(`${name} failed`));
      return Promise.resolve(value);
    };
  let migrateRuns = 0;
  const operations: DrillOperations = {
    assertApplicationOffline: step('assertApplicationOffline', undefined),
    bootstrapTarget: step('bootstrapTarget', undefined),
    cleanup: step('cleanup', undefined),
    copyJournalReadOnly: step('copyJournalReadOnly', { entries: 3, files: 1, manifestDigest: 'm1', readOnlyEnforced: true }),
    createSourceDatabase: step('createSourceDatabase', { migrationsBehind: 1 }),
    createTargetDatabase: step('createTargetDatabase', undefined),
    deleteAfterBackup: step('deleteAfterBackup', { deletedAt: ['2026-10-01T10:05:00.000Z'] }),
    exportJournal: step('exportJournal', { entries: 3, files: 1, manifestDigest: 'm1' }),
    inspectSource: step('inspectSource', { databaseBytes: 1000, state: atBackup }),
    inspectTarget: (() => {
      const states = [restored, afterFirst, afterFirst];
      let index = 0;
      return () => {
        calls.push('inspectTarget');
        if (fail?.at === 'inspectTarget') return Promise.reject(new Error('inspectTarget failed'));
        return Promise.resolve(structuredClone(states[Math.min(index++, 2)]!));
      };
    })(),
    migrate: () => {
      calls.push('migrate');
      if (fail?.at === 'migrate') return Promise.reject(fail.error ?? new Error('migrate failed'));
      migrateRuns += 1;
      // The restored backup is one migration older than the repository: only the first run applies it.
      return Promise.resolve(migrateRuns === 1 ? { applied: 1, skipped: 19 } : { applied: 0, skipped: 20 });
    },
    prepare: step('prepare', {
      node: 'v24',
      pgDump: 'pg_dump (PostgreSQL) 17.5',
      pgRestore: 'pg_restore (PostgreSQL) 17.5',
      postgis: '3.5.2',
      postgres: '17.5',
      runnerMode: 'docker-exec' as const,
    }),
    reapplyDeletions: (() => {
      const runs = [firstRun, secondRun];
      let index = 0;
      return () => {
        calls.push('reapplyDeletions');
        if (fail?.at === 'reapplyDeletions') return Promise.reject(fail.error ?? new Error('reapplyDeletions failed'));
        return Promise.resolve(runs[Math.min(index++, 1)]!);
      };
    })(),
    restoreBackup: step('restoreBackup', undefined),
    seedScenario: step('seedScenario', undefined),
    simulateSourceLoss: step('simulateSourceLoss', undefined),
    takeBackup: step('takeBackup', {
      artifactBytes: 5000,
      createdAt: '2026-10-01T10:00:00.000Z',
      durationMs: 1500,
      plaintextBytes: 4000,
    }),
    verifyBackupArtifact: step('verifyBackupArtifact', undefined),
    verifyJournalCopy: step('verifyJournalCopy', { manifestDigest: 'm1' }),
    verifyReadiness: step('verifyReadiness', {
      checks: [{ description: 'roles are not privileged', id: 'roles', passed: true }],
      roles: [],
    }),
  };
  return { calls, operations };
}

function fakeClock(startIso = '2026-10-01T10:30:00.000Z') {
  let monotonic = 0;
  const start = Date.parse(startIso);
  return {
    monotonicNow: () => (monotonic += 1000),
    utcNow: () => new Date(start + monotonic),
  };
}

describe('restore drill orchestration', () => {
  const options = { commands: [], commit: 'abc1234', keep: false };

  it('performs the SDD order and only then reports the database as still closed to the application', async () => {
    const { calls, operations } = harness();
    const result = await runRestoreDrill({ clock: fakeClock(), operations, options });

    expect(result.exitCode).toBe(0);
    expect(result.report.status).toBe('passed');
    expect(calls).toEqual([
      'prepare',
      'createSourceDatabase',
      'seedScenario',
      'inspectSource',
      'takeBackup',
      'deleteAfterBackup',
      'exportJournal',
      'copyJournalReadOnly',
      'simulateSourceLoss',
      'assertApplicationOffline',
      'createTargetDatabase',
      'bootstrapTarget',
      'verifyBackupArtifact',
      'restoreBackup',
      'migrate',
      'migrate',
      'verifyJournalCopy',
      'inspectTarget',
      'reapplyDeletions',
      'inspectTarget',
      'reapplyDeletions',
      'inspectTarget',
      'verifyReadiness',
      'cleanup',
    ]);
    expect(result.report.recovery.completedSteps).toEqual(recoverySteps.slice(0, -1));
    expect(result.report.recovery.pendingSteps).toEqual(['current_permissions_restored']);
    expect(result.report.recovery.applicationAccess).toBe('closed');
  });

  it('computes the drill recovery point and recovery time from the recorded instants', async () => {
    const { operations } = harness();
    const { report } = await runRestoreDrill({ clock: fakeClock(), operations, options });

    const loss = Date.parse(report.timeline.simulatedLossAt);
    const backup = Date.parse(report.timeline.backupCreatedAt);
    expect(report.rpo.backupRecoveryPointMs).toBe(loss - backup);
    expect(report.rpo.targetMs).toBe(24 * 3600 * 1000);
    expect(report.rpo.withinTarget).toBe(true);
    expect(report.rto.targetMs).toBe(4 * 3600 * 1000);
    expect(report.rto.withinTarget).toBe(true);
    expect(report.rto.measuredMs).toBe(report.durations.totalRecoveryMs);
    expect(report.durations.totalRecoveryMs).toBeGreaterThan(report.durations.restoreMs);
    expect(report.durations.restoreMs).toBeGreaterThan(0);
    expect(report.durations.journalReapplyMs).toBeGreaterThan(0);
    for (const key of [
      'restoreStartedAt',
      'restoreCompletedAt',
      'migrationCompletedAt',
      'journalReapplyStartedAt',
      'journalReapplyCompletedAt',
      'verificationCompletedAt',
    ] as const) {
      expect(Date.parse(report.timeline[key]), key).toBeGreaterThan(loss);
    }
  });

  it('keeps the databases and fails the drill when the recovery point exceeds 24 hours', async () => {
    const { calls, operations } = harness();
    operations.takeBackup = () =>
      Promise.resolve({
        artifactBytes: 1,
        createdAt: '2026-09-29T10:00:00.000Z',
        durationMs: 1,
        plaintextBytes: 1,
      });

    const result = await runRestoreDrill({ clock: fakeClock(), operations, options });

    expect(result.exitCode).toBe(1);
    expect(result.report.status).toBe('failed');
    expect(result.report.rpo.withinTarget).toBe(false);
    expect(calls).not.toContain('cleanup');
  });

  it.each([
    ['verifyBackupArtifact', 'decryption'],
    ['restoreBackup', 'pg_restore'],
    ['reapplyDeletions', 'journal'],
    ['verifyReadiness', 'role'],
    ['inspectTarget', 'verification'],
  ] as const)('fails closed with a non-zero exit code and keeps both databases when %s fails (%s)', async (...[at]) => {
    const { calls, operations } = harness({ at });
    const result = await runRestoreDrill({ clock: fakeClock(), operations, options });

    expect(result.exitCode).toBe(1);
    expect(result.report.status).toBe('failed');
    expect(result.report.failure?.step).toBeTruthy();
    expect(result.report.failure?.message).toContain(`${at} failed`);
    expect(calls).not.toContain('cleanup');
    expect(result.report.recovery.applicationAccess).toBe('closed');
  });

  it('aborts at a migration checksum mismatch and never reapplies deletions or opens anything', async () => {
    const { calls, operations } = harness({
      at: 'migrate',
      error: new Error('Applied migration 0003_run_points_summaries_rls.sql has changed'),
    });
    const result = await runRestoreDrill({ clock: fakeClock(), operations, options });

    expect(result.exitCode).toBe(1);
    expect(result.report.failure?.message).toContain('has changed');
    expect(calls).not.toContain('reapplyDeletions');
    expect(calls).not.toContain('verifyReadiness');
    expect(calls).not.toContain('cleanup');
    expect(result.report.recovery.completedSteps).toEqual(recoverySteps.slice(0, 4));
  });

  it('aborts when the second migration run is not a no-op', async () => {
    const { calls, operations } = harness();
    operations.migrate = () => {
      calls.push('migrate');
      return Promise.resolve({ applied: 1, skipped: 19 });
    };

    const result = await runRestoreDrill({ clock: fakeClock(), operations, options });

    expect(result.exitCode).toBe(1);
    expect(result.report.failure?.message).toContain('second migration run');
    expect(calls).not.toContain('reapplyDeletions');
  });

  it('aborts when restoring the older backup applies a different number of migrations than the source was behind', async () => {
    const { calls, operations } = harness();
    operations.createSourceDatabase = () => Promise.resolve({ migrationsBehind: 2 });

    const result = await runRestoreDrill({ clock: fakeClock(), operations, options });

    expect(result.exitCode).toBe(1);
    expect(result.report.failure?.message).toContain('migrations');
    expect(calls).not.toContain('reapplyDeletions');
    expect(result.report.migration.backupBehindBy).toBe(2);
  });

  it('records how far behind the repository the restored backup was', async () => {
    const { operations } = harness();
    const { report } = await runRestoreDrill({ clock: fakeClock(), operations, options });
    expect(report.migration).toEqual({
      backupBehindBy: 1,
      firstRun: { applied: 1, skipped: 19 },
      secondRun: { applied: 0, skipped: 20 },
    });
  });

  it('aborts when the recovery copy of the journal differs from what was exported', async () => {
    const { calls, operations } = harness();
    operations.verifyJournalCopy = () => Promise.resolve({ manifestDigest: 'different' });

    const result = await runRestoreDrill({ clock: fakeClock(), operations, options });

    expect(result.exitCode).toBe(1);
    expect(result.report.failure?.message).toContain('journal');
    expect(calls).not.toContain('reapplyDeletions');
  });

  it('aborts before the restore when a deletion did not happen after the backup', async () => {
    const { calls, operations } = harness();
    operations.deleteAfterBackup = () => Promise.resolve({ deletedAt: ['2026-10-01T09:59:59.000Z'] });

    const result = await runRestoreDrill({ clock: fakeClock(), operations, options });

    expect(result.exitCode).toBe(1);
    expect(result.report.failure?.message).toContain('after the backup');
    expect(calls).not.toContain('createTargetDatabase');
  });

  it('fails when the evaluation finds a resurrected run, and never reports success', async () => {
    const { calls, operations } = harness();
    const resurrected = structuredClone(afterFirst);
    resurrected.runs.A.run = true;
    let inspections = 0;
    operations.inspectTarget = () => {
      calls.push('inspectTarget');
      inspections += 1;
      return Promise.resolve(structuredClone(inspections === 1 ? restored : resurrected));
    };

    const result = await runRestoreDrill({ clock: fakeClock(), operations, options });

    expect(result.exitCode).toBe(1);
    expect(result.report.status).toBe('failed');
    expect(result.report.failure?.message).toContain('deleted-runs-absent-everywhere');
  });

  it('keeps the databases on success when asked, and refuses to open the application before every step is done', async () => {
    const { calls, operations } = harness();
    const result = await runRestoreDrill({ clock: fakeClock(), operations, options: { ...options, keep: true } });

    expect(result.exitCode).toBe(0);
    expect(calls).not.toContain('cleanup');
    expect(result.report.recovery.applicationAccess).toBe('closed');
  });

  it('contains no connection string, password, key, or run identifier', async () => {
    const { operations } = harness();
    const { report } = await runRestoreDrill({ clock: fakeClock(), operations, options });
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/postgres(ql)?:\/\//u);
    expect(text).not.toMatch(/password|secret/iu);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/u);
  });
});

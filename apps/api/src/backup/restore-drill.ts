import type { Clock } from '../clock.js';
import type { ReapplyAccessOutcome } from '../restore/reapply-access.js';
import type { ReapplyOutcome } from '../restore/reapply-deletions.js';
import { createRecoveryTracker, recoverySteps, type RecoveryStep } from './restore-safety.js';

export const rpoTargetMs = 24 * 60 * 60 * 1000;
export const rtoTargetMs = 4 * 60 * 60 * 1000;
const oneYearMs = 365 * 24 * 60 * 60 * 1000;

/** The fixture runs of the deterministic scenario. Reports use these labels, never identifiers. */
export type RunLabel = 'A' | 'B' | 'C' | 'D';
export const deletedRunLabels = ['A', 'B', 'D'] as const;

export interface RunLabelState {
  points: number;
  run: boolean;
  shares: number;
  summaries: number;
  tombstone: { deletedAt: string; expiresAt: string } | null;
}

export const countedTables = [
  'memberships',
  'organizations',
  'run_deletion_journal',
  'run_points',
  'run_shares',
  'run_summaries',
  'run_tombstones',
  'runs',
  'users',
] as const;

export interface DatabaseState {
  archiveRevision: string;
  counts: Record<(typeof countedTables)[number], number>;
  runs: Record<RunLabel, RunLabelState>;
  /** Digest over the surviving run's raw points, so PostGIS data fidelity is compared, not just counts. */
  survivorDigest: string;
}

export interface ReapplyRun {
  entries: number;
  files: number;
  outcomes: Record<ReapplyOutcome, number>;
}

export interface Check {
  description: string;
  id: string;
  passed: boolean;
}

/** The fixture people of the access scenario. Reports use these labels, never identifiers. */
export const userLabels = ['owner', 'grantee', 'granteeTwo', 'leaver', 'keeper'] as const;
export type UserLabel = (typeof userLabels)[number];

export interface ShareState {
  history: boolean;
  live: boolean;
}

/**
 * The access facts of the scenario: whether each person's membership is active (null: no membership
 * row), the share each holds on the surviving run C (null: none), and whether each can actually read run C
 * when queried as the application's runtime role under row-level security.
 */
export interface AccessState {
  memberships: Record<UserLabel, boolean | null>;
  readsSurvivor: Record<UserLabel, boolean>;
  shares: Record<UserLabel, ShareState | null>;
}

export interface AccessSnapshot {
  /** Rows waiting in the database's own access-restriction outbox. */
  outboxRows: number;
  state: AccessState;
}

export interface ReapplyAccessRun {
  entries: number;
  files: number;
  outcomes: Record<ReapplyAccessOutcome, number>;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface RecoveryEvaluationInput {
  afterFirst: DatabaseState;
  afterSecond: DatabaseState;
  atBackup: DatabaseState;
  first: ReapplyRun;
  restored: DatabaseState;
  second: ReapplyRun;
}

/**
 * Pure comparison of the database before the backup, after restore + migrations, and after each
 * reapplication pass. Every check is a boolean with a fixed description: no identifier, payload, or
 * coordinate can enter the result.
 */
export function evaluateRecovery(input: RecoveryEvaluationInput): Check[] {
  const { afterFirst, afterSecond, atBackup, first, restored, second } = input;
  const checks: Check[] = [];
  const add = (id: string, description: string, passed: boolean): void => {
    checks.push({ description, id, passed });
  };

  add(
    'restored-matches-backup',
    'The restored database (after migrations, before reapplication) has the same row counts, archive revision and surviving-run data as the database at backup time',
    deepEqual(restored.counts, atBackup.counts) &&
      restored.archiveRevision === atBackup.archiveRevision &&
      restored.survivorDigest === atBackup.survivorDigest,
  );
  add(
    'deleted-runs-existed-in-backup',
    'Runs A and B exist in the restored backup with their points, summary and share, and have no tombstone: the backup really contains data deleted later',
    (['A', 'B'] as const).every((label) => {
      const state = restored.runs[label];
      return state.run && state.points > 0 && state.summaries > 0 && state.shares > 0 && state.tombstone === null;
    }) && !restored.runs.D.run,
  );

  const expectedDeleted = 2;
  const expectedMarkers = 1;
  const outcomeOthers = Object.entries(first.outcomes)
    .filter(([name]) => name !== 'deleted' && name !== 'marker_restored')
    .every(([, count]) => count === 0);
  add(
    'first-pass-outcomes',
    'The first reapplication deleted the two resurrected runs, restored the marker of the run that never reached the backup, and reported no other outcome',
    first.outcomes.deleted === expectedDeleted &&
      first.outcomes.marker_restored === expectedMarkers &&
      outcomeOthers &&
      first.entries === expectedDeleted + expectedMarkers,
  );

  add(
    'deleted-runs-absent-everywhere',
    'After reapplication, deleted runs have no runs, run_points, run_summaries or run_shares rows',
    deletedRunLabels.every((label) => {
      const state = afterFirst.runs[label];
      return !state.run && state.points === 0 && state.summaries === 0 && state.shares === 0;
    }),
  );
  add(
    'tombstones-present',
    'After reapplication, every deleted run has a tombstone',
    deletedRunLabels.every((label) => afterFirst.runs[label].tombstone !== null),
  );
  add(
    'tombstone-expiry-at-least-one-year',
    'No tombstone expires earlier than one year after its deletion instant',
    deletedRunLabels.every((label) => {
      const tombstone = afterFirst.runs[label].tombstone;
      return (
        tombstone !== null &&
        Date.parse(tombstone.expiresAt) - Date.parse(tombstone.deletedAt) >= oneYearMs
      );
    }),
  );
  add(
    'archive-revision-advanced-per-deletion',
    'The archive revision advanced exactly once per run that was actually deleted, and not for a restored marker',
    BigInt(afterFirst.archiveRevision) - BigInt(restored.archiveRevision) === BigInt(first.outcomes.deleted),
  );
  const pointsRemoved = restored.runs.A.points + restored.runs.B.points;
  const sharesRemoved = restored.runs.A.shares + restored.runs.B.shares;
  const summariesRemoved = restored.runs.A.summaries + restored.runs.B.summaries;
  add(
    'survivor-untouched',
    'The surviving run is unchanged and the table counts moved only by the deleted runs',
    afterFirst.runs.C.run &&
      deepEqual(afterFirst.runs.C, restored.runs.C) &&
      afterFirst.survivorDigest === restored.survivorDigest &&
      afterFirst.counts.runs === restored.counts.runs - expectedDeleted &&
      afterFirst.counts.run_points === restored.counts.run_points - pointsRemoved &&
      afterFirst.counts.run_shares === restored.counts.run_shares - sharesRemoved &&
      afterFirst.counts.run_summaries === restored.counts.run_summaries - summariesRemoved &&
      afterFirst.counts.run_tombstones === restored.counts.run_tombstones + expectedDeleted + expectedMarkers,
  );

  const secondOthers = Object.entries(second.outcomes)
    .filter(([name]) => name !== 'marker_present')
    .every(([, count]) => count === 0);
  add(
    'second-pass-idempotent',
    'The second reapplication changed nothing: every entry reported marker_present and none was deleted again',
    secondOthers && second.outcomes.marker_present === second.entries && second.entries === first.entries,
  );
  add(
    'second-pass-changes-nothing',
    'The database state after the second reapplication is identical to the state after the first: same rows, tombstone expiry, archive revision and journal',
    deepEqual(afterSecond, afterFirst),
  );
  return checks;
}

function ordered(state: AccessState): unknown {
  return userLabels.map((label) => {
    const held = state.shares[label];
    return [label, state.memberships[label], held === null ? null : [held.history, held.live], state.readsSurvivor[label]];
  });
}

const share = (history: boolean, live: boolean): ShareState => ({ history, live });

/** What the backup holds in the scenario: everyone still has the access they were given. */
const staleAccess: AccessState = {
  memberships: { grantee: true, granteeTwo: true, keeper: true, leaver: true, owner: true },
  readsSurvivor: { grantee: true, granteeTwo: true, keeper: true, leaver: true, owner: true },
  shares: {
    grantee: share(true, false),
    granteeTwo: share(true, true),
    keeper: share(true, false),
    leaver: share(true, false),
    owner: null,
  },
};

/**
 * What the source held when it was lost, and what recovery must reproduce: one share revoked, one
 * narrowed so that the history grant is gone, one member deactivated, one person left untouched.
 */
const currentAccess: AccessState = {
  memberships: { grantee: true, granteeTwo: true, keeper: true, leaver: false, owner: true },
  readsSurvivor: { grantee: false, granteeTwo: false, keeper: true, leaver: false, owner: true },
  shares: {
    grantee: null,
    granteeTwo: share(false, true),
    keeper: share(true, false),
    leaver: share(true, false),
    owner: null,
  },
};

/** The journal of the scenario: two cascade revocations of deleted runs' shares and the three restrictions. */
const expectedAccessEntries = 5;
const expectedAccessApplied = 3;
const expectedAccessAlreadyApplied = 2;

export interface AccessEvaluationInput {
  afterDeletions: AccessSnapshot;
  afterFirst: AccessSnapshot;
  afterSecond: AccessSnapshot;
  first: ReapplyAccessRun;
  restored: AccessSnapshot;
  second: ReapplyAccessRun;
  source: AccessSnapshot;
}

function noMorePermissive(after: AccessState, before: AccessState): boolean {
  return userLabels.every((label) => {
    const afterShare = after.shares[label];
    const beforeShare = before.shares[label];
    const shareOk =
      afterShare === null ||
      (beforeShare !== null &&
        (!afterShare.history || beforeShare.history) &&
        (!afterShare.live || beforeShare.live));
    const membershipOk = after.memberships[label] !== true || before.memberships[label] === true;
    const readOk = !after.readsSurvivor[label] || before.readsSurvivor[label];
    return shareOk && membershipOk && readOk;
  });
}

/**
 * Pure comparison of the permissions at the lost source, in the restored backup, and after each access
 * reapplication pass. Fixed descriptions only: no identifier can enter the result.
 */
export function evaluateAccessRecovery(input: AccessEvaluationInput): Check[] {
  const { afterDeletions, afterFirst, afterSecond, first, restored, second, source } = input;
  const checks: Check[] = [];
  const add = (id: string, description: string, passed: boolean): void => {
    checks.push({ description, id, passed });
  };
  const same = (left: AccessState, right: AccessState): boolean => deepEqual(ordered(left), ordered(right));

  add(
    'source-access-restricted',
    'Just before the loss, the source had one share revoked, one narrowed to no history grant and one member deactivated, and those three people could no longer read the surviving run',
    same(source.state, currentAccess),
  );
  add(
    'stale-access-in-backup',
    'The restored backup still holds all of that access: every membership active, every share present and wide, and everyone able to read the surviving run',
    same(restored.state, staleAccess),
  );
  add(
    'access-first-pass-outcomes',
    "The first access reapplication processed the five journaled restrictions: three changed the restored data, two (cascade removals of deleted runs' shares) were already in effect, and nothing was skipped",
    first.entries === expectedAccessEntries &&
      first.outcomes.applied === expectedAccessApplied &&
      first.outcomes.already_applied === expectedAccessAlreadyApplied &&
      first.outcomes.skipped_unknown_organization === 0,
  );
  add(
    'restrictions-applied',
    'After reapplication the revoked share is gone, the narrowed share has no history grant, the deactivated member is inactive, and those people cannot read the surviving run, while the owner and the untouched reader still can',
    same(afterFirst.state, currentAccess),
  );
  add(
    'recovered-access-matches-source',
    'The permissions of the recovered database equal the permissions the lost source held',
    same(afterFirst.state, source.state),
  );
  add(
    'no-access-added',
    'Recovery added no access: no membership was activated, no share created or widened, and nobody can read what they could not read in the restored backup',
    noMorePermissive(afterFirst.state, restored.state),
  );
  add(
    'applied-restrictions-journaled-again',
    "Each restriction that reapplication changed was recorded again in the recovered database's own outbox, so the history stays continuous",
    afterFirst.outboxRows - afterDeletions.outboxRows === first.outcomes.applied,
  );
  add(
    'access-second-pass-idempotent',
    'The second access reapplication changed nothing: every entry reported already_applied',
    second.entries === first.entries &&
      second.outcomes.already_applied === second.entries &&
      second.outcomes.applied === 0 &&
      second.outcomes.skipped_unknown_organization === 0,
  );
  add(
    'access-second-pass-changes-nothing',
    'The permissions and the outbox after the second pass are identical to those after the first',
    same(afterSecond.state, afterFirst.state) && afterSecond.outboxRows === afterFirst.outboxRows,
  );
  return checks;
}

export interface EnvironmentFacts {
  node: string;
  pgDump: string;
  pgRestore: string;
  postgis: string;
  postgres: string;
  runnerMode: 'docker-exec' | 'local';
}

export interface BackupFacts {
  artifactBytes: number;
  createdAt: string;
  durationMs: number;
  plaintextBytes: number;
}

export interface JournalFacts {
  /** Entries of the access-restriction journal files (the deletion journal's are `entries`). */
  accessEntries: number;
  entries: number;
  files: number;
  manifestDigest: string;
}

export interface MigrationRun {
  applied: number;
  skipped: number;
}

export interface RoleFacts {
  bypassRls: boolean;
  canCreateDatabase: boolean;
  canCreateRole: boolean;
  name: string;
  superuser: boolean;
}

/** Everything with side effects. The orchestrator only sequences, times, and judges what these return. */
export interface DrillOperations {
  assertApplicationOffline(): Promise<void>;
  bootstrapTarget(): Promise<void>;
  cleanup(): Promise<void>;
  copyJournalReadOnly(): Promise<JournalFacts & { readOnlyEnforced: boolean }>;
  /** Creates and migrates the source. It may stop `migrationsBehind` migrations short of the repository. */
  createSourceDatabase(): Promise<{ migrationsBehind: number }>;
  createTargetDatabase(): Promise<void>;
  deleteAfterBackup(): Promise<{ deletedAt: string[] }>;
  exportJournal(): Promise<JournalFacts>;
  inspectAccess(side: 'source' | 'target'): Promise<AccessSnapshot>;
  inspectSource(): Promise<{ databaseBytes: number; state: DatabaseState }>;
  inspectTarget(): Promise<DatabaseState>;
  migrate(): Promise<MigrationRun>;
  prepare(): Promise<EnvironmentFacts>;
  reapplyAccess(): Promise<ReapplyAccessRun>;
  reapplyDeletions(): Promise<ReapplyRun>;
  restoreBackup(): Promise<void>;
  /** Revokes, narrows and deactivates access after the backup, through the application's own paths. */
  restrictAccessAfterBackup(): Promise<void>;
  seedScenario(): Promise<void>;
  simulateSourceLoss(): Promise<void>;
  takeBackup(): Promise<BackupFacts>;
  /** Migrates the source to the repository's schema: a release deployed between the backup and the loss. */
  upgradeSourceSchema(): Promise<MigrationRun>;
  verifyBackupArtifact(): Promise<void>;
  verifyJournalCopy(): Promise<{ manifestDigest: string }>;
  verifyReadiness(): Promise<{ checks: Check[]; roles: RoleFacts[] }>;
}

export interface DrillReport {
  access: {
    effectiveAccess: Record<'recovered' | 'restored' | 'source', Record<UserLabel, boolean>> | null;
    exportedEntries: number | null;
    firstPass: ReapplyAccessRun | null;
    secondPass: ReapplyAccessRun | null;
  };
  application: { commit: string };
  backup: BackupFacts & { algorithm: 'aes-256-gcm'; dumpFormat: 'pg_dump-custom'; envelopeVersion: 1; sourceDatabaseBytes: number };
  checks: Check[];
  cleanup: 'dropped' | 'failed' | 'kept' | 'not-run';
  commands: string[];
  durations: {
    journalReapplyMs: number;
    migrationMs: number;
    restoreMs: number;
    totalRecoveryMs: number;
  };
  environment: EnvironmentFacts | null;
  failure?: { message: string; step: string };
  generatedAt: string;
  journal: { exported: JournalFacts | null; firstPass: ReapplyRun | null; recoveryCopyReadOnlyEnforced: boolean | null; secondPass: ReapplyRun | null };
  migration: { backupBehindBy: number | null; firstRun: MigrationRun | null; secondRun: MigrationRun | null };
  recovery: {
    applicationAccess: 'closed';
    completedSteps: RecoveryStep[];
    pendingSteps: RecoveryStep[];
  };
  roles: RoleFacts[];
  rpo: { backupRecoveryPointMs: number; targetMs: number; withinTarget: boolean };
  rto: { measuredMs: number; targetMs: number; withinTarget: boolean };
  schemaVersion: 1;
  status: 'failed' | 'passed';
  timeline: {
    backupCreatedAt: string;
    deletionsCompletedAt: string;
    journalExportedAt: string;
    journalReapplyCompletedAt: string;
    journalReapplyStartedAt: string;
    migrationCompletedAt: string;
    recoveryStartedAt: string;
    restoreCompletedAt: string;
    restoreStartedAt: string;
    simulatedLossAt: string;
    verificationCompletedAt: string;
  };
}

export interface DrillOptions {
  commands: readonly string[];
  commit: string;
  keep: boolean;
}

export interface DrillResult {
  exitCode: 0 | 1;
  report: DrillReport;
}

function scrubMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'The drill failed';
  return message.replace(/postgres(?:ql)?:\/\/\S+/gu, '[connection string]').slice(0, 2000);
}

/**
 * Runs the drill in the SDD order: backup, deletions and access restrictions after it, journal export, simulated loss, restore
 * into a fresh isolated database, migrations, deletion reapplication, verification. Any failure stops the
 * drill, keeps every database for diagnosis, and returns a failed report with exit code 1. The last SDD
 * step (current permissions restored, P12.4) completes only after the access restrictions were reapplied
 * and verified against the permissions of the lost source. Even then the drill never reopens the
 * restored database to the application, so the report always says it is still closed.
 */
export async function runRestoreDrill(input: {
  clock: Pick<Clock, 'monotonicNow' | 'utcNow'>;
  operations: DrillOperations;
  options: DrillOptions;
}): Promise<DrillResult> {
  const { clock, operations, options } = input;
  const tracker = createRecoveryTracker();
  const mark = (): { at: string; t: number } => {
    const t = clock.monotonicNow();
    return { at: clock.utcNow().toISOString(), t };
  };

  let step = 'prepare';
  let environment: EnvironmentFacts | null = null;
  let backup: BackupFacts | null = null;
  let sourceDatabaseBytes = 0;
  let exported: JournalFacts | null = null;
  let copyReadOnly: boolean | null = null;
  let migrationsBehind: number | null = null;
  let firstMigration: MigrationRun | null = null;
  let secondMigration: MigrationRun | null = null;
  let firstPass: ReapplyRun | null = null;
  let secondPass: ReapplyRun | null = null;
  let firstAccessPass: ReapplyAccessRun | null = null;
  let secondAccessPass: ReapplyAccessRun | null = null;
  let effectiveAccess: DrillReport['access']['effectiveAccess'] = null;
  let roles: RoleFacts[] = [];
  let checks: Check[] = [];
  let cleanup: DrillReport['cleanup'];
  let failure: DrillReport['failure'];

  const empty = '';
  const timeline = {
    backupCreatedAt: empty,
    deletionsCompletedAt: empty,
    journalExportedAt: empty,
    journalReapplyCompletedAt: empty,
    journalReapplyStartedAt: empty,
    migrationCompletedAt: empty,
    recoveryStartedAt: empty,
    restoreCompletedAt: empty,
    restoreStartedAt: empty,
    simulatedLossAt: empty,
    verificationCompletedAt: empty,
  };
  const monotonic = {
    journalReapplyCompleted: 0,
    journalReapplyStarted: 0,
    migrationCompleted: 0,
    recoveryStarted: 0,
    restoreCompleted: 0,
    restoreStarted: 0,
    verificationCompleted: 0,
  };

  try {
    environment = await operations.prepare();

    step = 'create-source-database';
    migrationsBehind = (await operations.createSourceDatabase()).migrationsBehind;
    step = 'seed-scenario';
    await operations.seedScenario();
    step = 'inspect-source';
    const source = await operations.inspectSource();
    sourceDatabaseBytes = source.databaseBytes;

    step = 'take-backup';
    backup = await operations.takeBackup();
    timeline.backupCreatedAt = backup.createdAt;

    step = 'upgrade-source-schema';
    await operations.upgradeSourceSchema();

    step = 'delete-after-backup';
    const deletions = await operations.deleteAfterBackup();
    timeline.deletionsCompletedAt = clock.utcNow().toISOString();
    if (
      deletions.deletedAt.length === 0 ||
      deletions.deletedAt.some((instant) => !(Date.parse(instant) > Date.parse(backup!.createdAt)))
    ) {
      throw new Error('Every deletion must happen after the backup instant, and none was recorded');
    }

    step = 'restrict-access-after-backup';
    await operations.restrictAccessAfterBackup();

    step = 'export-journal';
    exported = await operations.exportJournal();
    timeline.journalExportedAt = clock.utcNow().toISOString();
    step = 'copy-journal';
    const copy = await operations.copyJournalReadOnly();
    copyReadOnly = copy.readOnlyEnforced;
    if (
      copy.manifestDigest !== exported.manifestDigest ||
      copy.entries !== exported.entries ||
      copy.accessEntries !== exported.accessEntries
    ) {
      throw new Error('The recovery copy of the journal differs from the exported journal');
    }

    step = 'inspect-source-access';
    const sourceAccess = await operations.inspectAccess('source');

    step = 'simulate-loss';
    await operations.simulateSourceLoss();
    const loss = mark();
    timeline.simulatedLossAt = loss.at;
    const started = mark();
    timeline.recoveryStartedAt = started.at;
    monotonic.recoveryStarted = started.t;

    step = 'application-offline';
    await operations.assertApplicationOffline();
    tracker.complete('application_offline');
    step = 'create-target-database';
    await operations.createTargetDatabase();
    tracker.complete('database_created');
    step = 'bootstrap-target';
    await operations.bootstrapTarget();
    tracker.complete('roles_and_postgis_bootstrapped');

    step = 'verify-backup-artifact';
    await operations.verifyBackupArtifact();
    step = 'restore-backup';
    const restoreStart = mark();
    timeline.restoreStartedAt = restoreStart.at;
    monotonic.restoreStarted = restoreStart.t;
    await operations.restoreBackup();
    const restoreEnd = mark();
    timeline.restoreCompletedAt = restoreEnd.at;
    monotonic.restoreCompleted = restoreEnd.t;
    tracker.complete('backup_restored');

    step = 'migrate';
    firstMigration = await operations.migrate();
    const migrated = mark();
    timeline.migrationCompletedAt = migrated.at;
    monotonic.migrationCompleted = migrated.t;
    if (firstMigration.applied !== migrationsBehind) {
      throw new Error(
        `Restoring the backup applied ${firstMigration.applied} migrations, but the source was ${migrationsBehind} behind the repository`,
      );
    }
    tracker.complete('migrations_applied');
    step = 'verify-migration-checksums';
    secondMigration = await operations.migrate();
    if (secondMigration.applied !== 0) {
      throw new Error('The second migration run applied a migration; it must be a checksum-only no-op');
    }
    tracker.complete('migration_checksums_verified');

    step = 'verify-journal-copy';
    const verifiedCopy = await operations.verifyJournalCopy();
    if (verifiedCopy.manifestDigest !== exported.manifestDigest) {
      throw new Error('The recovery journal changed before reapplication');
    }
    tracker.complete('journal_copy_readonly');

    step = 'inspect-restored';
    const restored = await operations.inspectTarget();
    step = 'inspect-restored-access';
    const restoredAccess = await operations.inspectAccess('target');

    step = 'reapply-deletions';
    const reapplyStart = mark();
    timeline.journalReapplyStartedAt = reapplyStart.at;
    monotonic.journalReapplyStarted = reapplyStart.t;
    firstPass = await operations.reapplyDeletions();
    const reapplyEnd = mark();
    timeline.journalReapplyCompletedAt = reapplyEnd.at;
    monotonic.journalReapplyCompleted = reapplyEnd.t;
    tracker.complete('deletions_reapplied');

    step = 'inspect-after-first-reapply';
    const afterFirst = await operations.inspectTarget();
    step = 'reapply-deletions-second-pass';
    secondPass = await operations.reapplyDeletions();
    step = 'inspect-after-second-reapply';
    const afterSecond = await operations.inspectTarget();

    step = 'verify-deletion-outcomes';
    checks = evaluateRecovery({
      afterFirst,
      afterSecond,
      atBackup: source.state,
      first: firstPass,
      restored,
      second: secondPass,
    });
    const failed = checks.filter((check) => !check.passed);
    if (failed.length > 0) {
      throw new Error(`Recovery verification failed: ${failed.map((check) => check.id).join(', ')}`);
    }
    tracker.complete('deletion_outcomes_verified');

    step = 'inspect-access-after-deletions';
    const accessAfterDeletions = await operations.inspectAccess('target');
    step = 'reapply-access';
    firstAccessPass = await operations.reapplyAccess();
    tracker.complete('access_restrictions_reapplied');
    step = 'inspect-access-after-first-reapply';
    const accessAfterFirst = await operations.inspectAccess('target');
    step = 'reapply-access-second-pass';
    secondAccessPass = await operations.reapplyAccess();
    step = 'inspect-access-after-second-reapply';
    const accessAfterSecond = await operations.inspectAccess('target');

    step = 'verify-access-outcomes';
    const accessChecks = evaluateAccessRecovery({
      afterDeletions: accessAfterDeletions,
      afterFirst: accessAfterFirst,
      afterSecond: accessAfterSecond,
      first: firstAccessPass,
      restored: restoredAccess,
      second: secondAccessPass,
      source: sourceAccess,
    });
    checks = [...checks, ...accessChecks];
    effectiveAccess = {
      recovered: accessAfterFirst.state.readsSurvivor,
      restored: restoredAccess.state.readsSurvivor,
      source: sourceAccess.state.readsSurvivor,
    };
    const accessFailed = accessChecks.filter((check) => !check.passed);
    if (accessFailed.length > 0) {
      throw new Error(`Access recovery verification failed: ${accessFailed.map((check) => check.id).join(', ')}`);
    }
    tracker.complete('access_outcomes_verified');

    step = 'verify-readiness';
    const readiness = await operations.verifyReadiness();
    roles = readiness.roles;
    checks = [...checks, ...readiness.checks];
    const readinessFailed = readiness.checks.filter((check) => !check.passed);
    if (readinessFailed.length > 0) {
      throw new Error(`Readiness verification failed: ${readinessFailed.map((check) => check.id).join(', ')}`);
    }
    tracker.complete('readiness_verified');
    tracker.complete('current_permissions_restored');
    const verified = mark();
    timeline.verificationCompletedAt = verified.at;
    monotonic.verificationCompleted = verified.t;

    step = 'targets';
    const recoveryPoint = Date.parse(timeline.simulatedLossAt) - Date.parse(timeline.backupCreatedAt);
    const recoveryMs = monotonic.verificationCompleted - monotonic.recoveryStarted;
    if (recoveryPoint > rpoTargetMs) {
      throw new Error('The drill recovery point exceeds the 24-hour target');
    }
    if (recoveryMs > rtoTargetMs) {
      throw new Error('The measured drill recovery time exceeds the 4-hour target');
    }
  } catch (error) {
    failure = { message: scrubMessage(error), step };
  }

  if (failure === undefined) {
    if (options.keep) {
      cleanup = 'kept';
    } else {
      try {
        await operations.cleanup();
        cleanup = 'dropped';
      } catch {
        cleanup = 'failed';
      }
    }
  } else {
    cleanup = 'kept';
  }

  const backupRecoveryPointMs =
    timeline.simulatedLossAt && timeline.backupCreatedAt
      ? Date.parse(timeline.simulatedLossAt) - Date.parse(timeline.backupCreatedAt)
      : 0;
  const totalRecoveryMs =
    monotonic.verificationCompleted > 0 ? monotonic.verificationCompleted - monotonic.recoveryStarted : 0;
  const diff = (end: number, start: number): number => (end > 0 && start > 0 ? end - start : 0);

  const report: DrillReport = {
    access: {
      effectiveAccess,
      exportedEntries: exported?.accessEntries ?? null,
      firstPass: firstAccessPass,
      secondPass: secondAccessPass,
    },
    application: { commit: options.commit },
    backup: {
      algorithm: 'aes-256-gcm',
      artifactBytes: backup?.artifactBytes ?? 0,
      createdAt: backup?.createdAt ?? '',
      dumpFormat: 'pg_dump-custom',
      durationMs: backup?.durationMs ?? 0,
      envelopeVersion: 1,
      plaintextBytes: backup?.plaintextBytes ?? 0,
      sourceDatabaseBytes,
    },
    checks,
    cleanup,
    commands: [...options.commands],
    durations: {
      journalReapplyMs: diff(monotonic.journalReapplyCompleted, monotonic.journalReapplyStarted),
      migrationMs: diff(monotonic.migrationCompleted, monotonic.restoreCompleted),
      restoreMs: diff(monotonic.restoreCompleted, monotonic.restoreStarted),
      totalRecoveryMs,
    },
    environment,
    ...(failure ? { failure } : {}),
    generatedAt: clock.utcNow().toISOString(),
    journal: {
      exported,
      firstPass,
      recoveryCopyReadOnlyEnforced: copyReadOnly,
      secondPass,
    },
    migration: { backupBehindBy: migrationsBehind, firstRun: firstMigration, secondRun: secondMigration },
    recovery: {
      applicationAccess: 'closed',
      completedSteps: tracker.completed(),
      pendingSteps: tracker.pending(),
    },
    roles,
    rpo: {
      backupRecoveryPointMs,
      targetMs: rpoTargetMs,
      withinTarget: backupRecoveryPointMs > 0 && backupRecoveryPointMs <= rpoTargetMs,
    },
    rto: {
      measuredMs: totalRecoveryMs,
      targetMs: rtoTargetMs,
      withinTarget: totalRecoveryMs > 0 && totalRecoveryMs <= rtoTargetMs,
    },
    schemaVersion: 1,
    status: failure ? 'failed' : 'passed',
    timeline,
  };
  return { exitCode: failure ? 1 : 0, report };
}

export { recoverySteps };

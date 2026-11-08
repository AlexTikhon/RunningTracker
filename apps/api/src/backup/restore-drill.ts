import type { Clock } from '../clock.js';
import type { ReapplyAccessOutcome } from '../restore/reapply-access.js';
import type { ReapplyOutcome } from '../restore/reapply-deletions.js';
import type { ReapplyErasureOutcome } from '../restore/reapply-erasures.js';
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

/**
 * The fixture activities of the erasure scenario (ADR-0073): E is in the backup and its owner deletes it after the
 * backup; F is in the backup and untouched.
 */
export type ActivityLabel = 'E' | 'F';

/**
 * The fixture check-in days of the same scenario (ADR-0074): G is in the backup and its owner deletes it after the
 * backup; H is in the backup and untouched.
 */
export type DailyMetricLabel = 'G' | 'H';

/**
 * The fixture movement days of the same scenario (ADR-0078): M is in the backup and its owner deletes it after the
 * backup; N is in the backup and untouched. Movement is not an insight source, so no insight depends on them.
 */
export type DailyMovementLabel = 'M' | 'N';

/**
 * The fixture weekly insights of the same scenario (ADR-0076), all in the backup: one for the week of activity E, one for
 * the week of check-in day G, and one for a week without any erased record. The replay must delete the first two (the
 * derived data of the erased records) and leave the third as it was.
 */
export type InsightLabel = 'activityWeek' | 'checkInWeek' | 'survivorWeek';

/** The number of owner-only records the scenario deletes after the backup: activity E, check-in day G and movement day M. */
export const ERASURES_AFTER_BACKUP = 3;

export interface ActivityState {
  /** Rows waiting in the restored database's own erasure-ledger outbox. */
  outboxRows: number;
  present: Record<ActivityLabel, boolean>;
  presentDays: Record<DailyMetricLabel, boolean>;
  presentInsights: Record<InsightLabel, boolean>;
  presentMovementDays: Record<DailyMovementLabel, boolean>;
  /** Digest over the surviving activity's row, so its content is compared, not just its presence. */
  survivorDigest: string;
  /** Digest over the surviving day's row. */
  survivorDayDigest: string;
  /** Digest over the surviving insight's row. */
  survivorInsightDigest: string;
  /** Digest over the surviving movement day's row. */
  survivorMovementDigest: string;
}

export interface ReapplyErasureRun {
  entries: number;
  files: number;
  outcomes: Record<ReapplyErasureOutcome, number>;
}

/** What the restore-time session clearing found and did (ADR-0080). Counts only. */
export interface SessionClearRun {
  cleared: number;
  remaining: number;
  /** Session rows in the restored database before clearing; application backups carry none. */
  restoredRows: number;
  /** Session rows the source held when the backup was taken; null when its schema had no session table yet. */
  sourceRowsAtBackup: number | null;
}

/** A restored database must authenticate no session from before the restore, revoked or not. */
export function evaluateSessionRecovery(run: SessionClearRun): Check[] {
  return [
    {
      description:
        run.sourceRowsAtBackup === null
          ? 'The backup predates the session table, so the restored database held no session rows'
          : `The backup carried no session rows although the source held ${run.sourceRowsAtBackup} at backup time (pg_dump --exclude-table-data)`,
      id: 'sessions-not-in-backup',
      passed: run.restoredRows === 0 && (run.sourceRowsAtBackup === null || run.sourceRowsAtBackup > 0),
    },
    {
      description: 'restore:clear-sessions left no stored session: every earlier session cookie is refused and everyone signs in again',
      id: 'sessions-cleared-before-reopening',
      passed: run.remaining === 0,
    },
  ];
}

export interface ErasureEvaluationInput {
  afterFirst: ActivityState;
  afterSecond: ActivityState;
  first: ReapplyErasureRun;
  restored: ActivityState;
  second: ReapplyErasureRun;
}

/**
 * Pure comparison of the activities, check-in days and movement days in the restored database before and after each
 * erasure replay.
 */
export function evaluateErasureRecovery(input: ErasureEvaluationInput): Check[] {
  const { afterFirst, afterSecond, first, restored, second } = input;
  const checks: Check[] = [];
  const add = (id: string, description: string, passed: boolean): void => {
    checks.push({ description, id, passed });
  };
  const othersZero = (run: ReapplyErasureRun, keep: ReapplyErasureOutcome) =>
    Object.entries(run.outcomes).every(([name, count]) => name === keep || count === 0);

  add(
    'erased-activity-existed-in-backup',
    'Activity E, deleted after the backup, and the surviving activity F are both in the restored backup: the backup really contains health data deleted later',
    restored.present.E && restored.present.F,
  );
  add(
    'erased-daily-metric-existed-in-backup',
    'Check-in day G, deleted after the backup, and the surviving day H are both in the restored backup',
    restored.presentDays.G && restored.presentDays.H,
  );
  add(
    'erased-daily-movement-existed-in-backup',
    'Movement day M, deleted after the backup, and the surviving movement day N are both in the restored backup',
    restored.presentMovementDays.M && restored.presentMovementDays.N,
  );
  add(
    'erasure-first-pass-outcomes',
    'The first erasure replay erased exactly the activity, the check-in day and the movement day deleted after the backup and reported no other outcome',
    first.entries === ERASURES_AFTER_BACKUP &&
      first.outcomes.erased === ERASURES_AFTER_BACKUP &&
      othersZero(first, 'erased'),
  );
  add(
    'erased-activity-absent',
    'After the replay, activity E is gone from the restored database',
    !afterFirst.present.E,
  );
  add(
    'erased-daily-metric-absent',
    'After the replay, check-in day G is gone from the restored database',
    !afterFirst.presentDays.G,
  );
  add(
    'erased-daily-movement-absent',
    'After the replay, movement day M is gone from the restored database',
    !afterFirst.presentMovementDays.M,
  );
  add(
    'surviving-activity-untouched',
    'The surviving activity F is present and unchanged',
    afterFirst.present.F && afterFirst.survivorDigest === restored.survivorDigest,
  );
  add(
    'surviving-daily-metric-untouched',
    'The surviving check-in day H is present and unchanged',
    afterFirst.presentDays.H && afterFirst.survivorDayDigest === restored.survivorDayDigest,
  );
  add(
    'surviving-daily-movement-untouched',
    'The surviving movement day N is present and unchanged',
    afterFirst.presentMovementDays.N && afterFirst.survivorMovementDigest === restored.survivorMovementDigest,
  );
  add(
    'derived-insights-existed-in-backup',
    'The weekly insights of the weeks of E and G, and of a week without erased records, are all in the restored backup (ADR-0076)',
    restored.presentInsights.activityWeek && restored.presentInsights.checkInWeek && restored.presentInsights.survivorWeek,
  );
  add(
    'derived-insights-erased',
    'After the replay, the weekly insights of the weeks that contain the erased activity and check-in day are gone',
    !afterFirst.presentInsights.activityWeek && !afterFirst.presentInsights.checkInWeek,
  );
  add(
    'surviving-insight-untouched',
    "Another person's weekly insight, of a week without erased records, is present and unchanged",
    afterFirst.presentInsights.survivorWeek && afterFirst.survivorInsightDigest === restored.survivorInsightDigest,
  );
  add(
    'erasure-journaled-again',
    'The replayed erasure was journaled again on the recovered node, so it is exported from there too',
    afterFirst.outboxRows === restored.outboxRows + first.outcomes.erased,
  );
  add(
    'erasure-second-pass-idempotent',
    'The second erasure replay changed nothing: every entry reported absent',
    second.entries === first.entries && second.outcomes.absent === second.entries && othersZero(second, 'absent'),
  );
  add(
    'erasure-second-pass-changes-nothing',
    'The activities, the check-in days, the movement days, the weekly insights and the erasure outbox after the second replay are identical to those after the first',
    deepEqual(afterSecond, afterFirst),
  );
  return checks;
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
  /** Entries of the erasure ledger files (ADR-0073). */
  erasureEntries: number;
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

/** Sessions and locks on the drill databases when a step failed: names, states, waits and ages, never query text. */
export interface DrillDiagnostics {
  sessions: {
    application: string;
    backendType: string | null;
    blockedBy: number;
    database: string;
    role: string;
    state: string;
    stateAgeSeconds: number | null;
    transactionAgeSeconds: number | null;
    waitEvent: string | null;
    waitEventType: string | null;
  }[];
  ungrantedLocks: { count: number; lockType: string; mode: string }[];
}

/** Every operation must settle within this time, or the drill fails at that step with diagnostics (5 minutes). */
export const DEFAULT_STEP_TIMEOUT_MS = 5 * 60_000;
/** Collecting diagnostics after a failure may take this long. */
const DIAGNOSTICS_TIMEOUT_MS = 15_000;

export class DrillStepTimeoutError extends Error {
  public constructor(operation: string, timeoutMs: number) {
    super(`The drill operation ${operation} did not settle within ${timeoutMs} ms`);
    this.name = 'DrillStepTimeoutError';
  }
}

function settleWithin<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DrillStepTimeoutError(operation, timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/** The same operations, each bounded by `timeoutMs`. A late operation keeps running, but the drill does not wait on it. */
export function withStepDeadlines(operations: DrillOperations, timeoutMs: number): DrillOperations {
  const bounded = {} as Record<string, unknown>;
  for (const name of Object.keys(operations) as (keyof DrillOperations)[]) {
    const operation = Reflect.get(operations, name) as ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (typeof operation !== 'function') continue;
    bounded[name] = (...args: unknown[]) => settleWithin(Promise.resolve(operation.apply(operations, args)), timeoutMs, name);
  }
  return bounded as unknown as DrillOperations;
}

/** Everything with side effects. The orchestrator only sequences, times, and judges what these return. */
export interface DrillOperations {
  assertApplicationOffline(): Promise<void>;
  bootstrapTarget(): Promise<void>;
  cleanup(): Promise<void>;
  /** Clears every stored session in the restored database with restore:clear-sessions (ADR-0080). */
  clearSessions(): Promise<SessionClearRun>;
  /** PostgreSQL sessions and locks on the drill databases, read after a failure. */
  diagnose?(): Promise<DrillDiagnostics>;
  copyJournalReadOnly(): Promise<JournalFacts & { readOnlyEnforced: boolean }>;
  /** Creates and migrates the source. It may stop `migrationsBehind` migrations short of the repository. */
  createSourceDatabase(): Promise<{ migrationsBehind: number }>;
  createTargetDatabase(): Promise<void>;
  deleteAfterBackup(): Promise<{ deletedAt: string[] }>;
  exportJournal(): Promise<JournalFacts>;
  inspectAccess(side: 'source' | 'target'): Promise<AccessSnapshot>;
  /** The fixture activities and the erasure outbox of the restored database. */
  inspectActivities(): Promise<ActivityState>;
  inspectSource(): Promise<{ databaseBytes: number; state: DatabaseState }>;
  inspectTarget(): Promise<DatabaseState>;
  migrate(): Promise<MigrationRun>;
  prepare(): Promise<EnvironmentFacts>;
  reapplyAccess(): Promise<ReapplyAccessRun>;
  reapplyDeletions(): Promise<ReapplyRun>;
  /** Replays the exported erasure ledger with restore:reapply-erasures (ADR-0073). */
  reapplyErasures(): Promise<ReapplyErasureRun>;
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
  erasures: { exportedEntries: number | null; firstPass: ReapplyErasureRun | null; secondPass: ReapplyErasureRun | null };
  failure?: { diagnostics?: DrillDiagnostics; message: string; step: string; timedOut?: boolean };
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
  sessions: SessionClearRun | null;
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
  /** Upper bound of each drill operation (default DEFAULT_STEP_TIMEOUT_MS). */
  stepTimeoutMs?: number;
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
 * into a fresh isolated database, migrations, deletion reapplication, access reapplication, erasure replay (ADR-0073),
 * verification. Any failure stops the
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
  const { clock, options } = input;
  const unbounded = input.operations;
  const operations = withStepDeadlines(unbounded, options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
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
  let firstErasurePass: ReapplyErasureRun | null = null;
  let secondErasurePass: ReapplyErasureRun | null = null;
  let sessions: SessionClearRun | null = null;
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
      copy.accessEntries !== exported.accessEntries ||
      copy.erasureEntries !== exported.erasureEntries
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
    step = 'inspect-restored-activities';
    const restoredActivities = await operations.inspectActivities();

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

    // Erasures of owner-only health records (ADR-0073), from the same read-only journal copy.
    step = 'reapply-erasures';
    firstErasurePass = await operations.reapplyErasures();
    tracker.complete('erasures_reapplied');
    step = 'inspect-activities-after-first-replay';
    const activitiesAfterFirst = await operations.inspectActivities();
    step = 'reapply-erasures-second-pass';
    secondErasurePass = await operations.reapplyErasures();
    step = 'inspect-activities-after-second-replay';
    const activitiesAfterSecond = await operations.inspectActivities();

    step = 'verify-erasure-outcomes';
    const erasureChecks = evaluateErasureRecovery({
      afterFirst: activitiesAfterFirst,
      afterSecond: activitiesAfterSecond,
      first: firstErasurePass,
      restored: restoredActivities,
      second: secondErasurePass,
    });
    checks = [...checks, ...erasureChecks];
    const erasureFailed = erasureChecks.filter((check) => !check.passed);
    if (erasureFailed.length > 0) {
      throw new Error(`Erasure recovery verification failed: ${erasureFailed.map((check) => check.id).join(', ')}`);
    }
    tracker.complete('erasure_outcomes_verified');

    // ADR-0080: no session from before the restore may authenticate once the database is reopened.
    step = 'clear-sessions';
    sessions = await operations.clearSessions();
    const sessionChecks = evaluateSessionRecovery(sessions);
    checks = [...checks, ...sessionChecks];
    const sessionsFailed = sessionChecks.filter((check) => !check.passed);
    if (sessionsFailed.length > 0) {
      throw new Error(`Session clearing verification failed: ${sessionsFailed.map((check) => check.id).join(', ')}`);
    }
    tracker.complete('sessions_cleared');

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
    failure = { message: scrubMessage(error), step, ...(error instanceof DrillStepTimeoutError ? { timedOut: true } : {}) };
    // Where it stopped and what PostgreSQL was doing then: observed evidence for a stuck or failed step.
    if (unbounded.diagnose) {
      try {
        failure.diagnostics = await settleWithin(unbounded.diagnose(), DIAGNOSTICS_TIMEOUT_MS, 'diagnose');
      } catch {
        // Diagnostics are best effort; the failure itself is already recorded.
      }
    }
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
    erasures: {
      exportedEntries: exported?.erasureEntries ?? null,
      firstPass: firstErasurePass,
      secondPass: secondErasurePass,
    },
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
    sessions,
    status: failure ? 'failed' : 'passed',
    timeline,
  };
  return { exitCode: failure ? 1 : 0, report };
}

export { recoverySteps };

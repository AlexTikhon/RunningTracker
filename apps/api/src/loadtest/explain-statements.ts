import { renderArchiveTileSql } from '../archive/archive-service.js';
import { liveStateSql } from '../live/live-state.js';
import { publishCandidateSql } from '../maintenance/run-summary-publication.js';
import {
  insertPointsSql,
  listRunsSql,
  liveTrackChangesSql,
  liveTrackSnapshotSql,
  rawPointsPageSql,
} from '../runs/run-service.js';
import { geographyAnchors, ingestionBatchSize, type DatasetPlan, type PlannedRun } from './dataset-plan.js';
import { lonLatToTile } from './load-scenario.js';

const dayMs = 24 * 60 * 60 * 1_000;
const pageLimit = 1_000;
/** The claim function is asked to scan the same number of candidates as the worker asks for. */
const claimScanLimit = 1_000;
const tileZooms = [9, 11, 13] as const;
/** Where a deep page starts, as a share of the run's raw points. */
const deepPageShare = 0.7;

export type StatementGroup =
  | 'ingest'
  | 'live-changes'
  | 'live-snapshot'
  | 'live-state'
  | 'raw-history'
  | 'rls-baseline'
  | 'run-list'
  | 'summary'
  | 'tile';

/** Values only the database can supply when the statement runs. */
export type DynamicValues = 'ingest-batch' | 'publish-candidate';

/**
 * The real service call whose response size is measured next to the plan, so JSON/MVT bytes are reported
 * separately from SQL time. Only first pages carry one: a deep page has the same shape and size.
 */
export type ResponseSpec =
  | { kind: 'live-changes'; afterRevision: string; limit: number; runId: string }
  | { kind: 'live-snapshot'; limit: number; runId: string }
  | { kind: 'live-state' }
  | { kind: 'raw-history'; limit: number; runId: string }
  | { kind: 'run-list'; from: string; limit: number; to: string }
  | { kind: 'tile'; from: string; to: string; x: number; y: number; z: number };

export interface ExplainTenant {
  orgId: string;
  userId: string;
  /** Declared exactly as the production caller of the statement declares it. */
  visibilityScope?: 'live';
}

export interface ExplainStatement {
  description: string;
  /** Set when the parameters depend on database state read just before the statement runs. */
  dynamicValues?: DynamicValues;
  group: StatementGroup;
  /** `rollback` statements change data and are always rolled back. */
  mode: 'read' | 'rollback';
  name: string;
  /** The seeded finished state, or the state in which each member's newest run is recording. */
  needs: 'active-runs' | 'seeded';
  response?: ResponseSpec;
  /** `owner` runs without tenant context and is not subject to row-level security: a baseline, never a product path. */
  role: 'maintenance' | 'owner' | 'runtime';
  sql: string;
  staticValues?: readonly unknown[];
  tenant: ExplainTenant | null;
}

export interface ActivatedRun {
  id: string;
  userIndex: number;
}

export interface ExplainPlan {
  /** The runs temporarily switched to `recording`; the collector restores every one of them. */
  activation: { organizationId: string; runs: ActivatedRun[] };
  statements: ExplainStatement[];
}

export interface ExplainPlanOptions {
  now: Date;
}

function newestRunPerMember(dataset: DatasetPlan): PlannedRun[] {
  const newest = new Map<number, PlannedRun>();
  for (const run of dataset.runs) {
    const current = newest.get(run.userIndex);
    if (!current || Date.parse(run.startedAt) > Date.parse(current.startedAt)) {
      newest.set(run.userIndex, run);
    }
  }
  return [...newest.values()].toSorted((left, right) => left.userIndex - right.userIndex);
}

export function planExplainStatements(dataset: DatasetPlan, options: ExplainPlanOptions): ExplainPlan {
  const orgId = dataset.organizationId;
  const owner = dataset.users[0];
  const coach = dataset.users.findLast(({ role }) => role === 'coach');
  const run = dataset.runs[0];
  if (!owner || !coach || !run) {
    throw new Error('The dataset needs a first member, a coach, and at least one run to plan measurements');
  }
  if (!run.hasRaw) {
    throw new Error('The first planned run has no raw points, so raw-history statements would be empty');
  }

  const ownerTenant: ExplainTenant = { orgId, userId: owner.id };
  const coachTenant: ExplainTenant = { orgId, userId: coach.id };
  const windowTo = new Date(options.now.getTime() + 60 * 60 * 1_000).toISOString();
  const windowFrom = new Date(options.now.getTime() + 60 * 60 * 1_000 - 366 * dayMs).toISOString();
  const deepSeq = Math.floor(run.pointCount * deepPageShare);
  const previousRevision = String(run.dataRevision - 1);
  const statements: ExplainStatement[] = [];

  for (const anchor of geographyAnchors) {
    for (const z of tileZooms) {
      const count = 2 ** z;
      const center = lonLatToTile(anchor.longitude, anchor.latitude, z);
      // Longitude 180 maps to column 2^z, which wraps to column 0 exactly as the burst planner does.
      const x = ((center.x % count) + count) % count;
      const y = Math.min(count - 1, Math.max(0, center.y));
      statements.push({
        description: `Archive tile at the centre of the ${anchor.name} region, zoom ${z}`,
        group: 'tile',
        mode: 'read',
        name: `tile/${anchor.name}/z${z}`,
        needs: 'seeded',
        response: { from: windowFrom, kind: 'tile', to: windowTo, x, y, z },
        role: 'runtime',
        sql: renderArchiveTileSql,
        staticValues: [orgId, z, x, y, windowFrom, windowTo],
        tenant: coachTenant,
      });
    }
  }

  // The same scan as the table owner (no row-level security) and as a coach under RLS. The difference is the
  // cost of the policy predicates, isolated from geometry, windows, and serialization.
  const rlsScans = [
    { name: 'run-summaries', sql: 'SELECT count(*) FROM run_summaries WHERE org_id = $1 AND display_geom IS NOT NULL', values: [orgId] },
    { name: 'runs', sql: 'SELECT count(*) FROM runs WHERE org_id = $1', values: [orgId] },
    { name: 'run-points', sql: 'SELECT count(*), max(seq) FROM run_points WHERE org_id = $1 AND run_id = $2', values: [orgId, run.id] },
  ] as const;
  for (const scan of rlsScans) {
    for (const role of ['owner', 'runtime'] as const) {
      statements.push({
        description: `Count scan of ${scan.name} as the ${role === 'owner' ? 'table owner (no RLS)' : 'coach (RLS)'}`,
        group: 'rls-baseline',
        mode: 'read',
        name: `rls-baseline/${scan.name}/${role}`,
        needs: 'seeded',
        role,
        sql: scan.sql,
        staticValues: scan.values,
        tenant: role === 'owner' ? null : coachTenant,
      });
    }
  }

  statements.push(
    {
      description: 'First page of the archive run list as a coach who sees every runner',
      group: 'run-list',
      mode: 'read',
      name: 'run-list/coach-page',
      needs: 'seeded',
      response: { from: windowFrom, kind: 'run-list', limit: 100, to: windowTo },
      role: 'runtime',
      sql: listRunsSql,
      staticValues: [orgId, windowFrom, windowTo, null, null, 101],
      tenant: coachTenant,
    },
    {
      description: 'First page of raw point history of the largest recent run',
      group: 'raw-history',
      mode: 'read',
      name: 'raw-history/first-page',
      needs: 'seeded',
      response: { kind: 'raw-history', limit: pageLimit, runId: run.id },
      role: 'runtime',
      sql: rawPointsPageSql,
      staticValues: [orgId, run.id, null, null, pageLimit + 1],
      tenant: coachTenant,
    },
    {
      description: `Raw point history page after seq ${deepSeq}`,
      group: 'raw-history',
      mode: 'read',
      name: 'raw-history/deep-page',
      needs: 'seeded',
      role: 'runtime',
      sql: rawPointsPageSql,
      staticValues: [orgId, run.id, null, deepSeq, pageLimit + 1],
      tenant: coachTenant,
    },
    {
      description: 'First page of a live-track snapshot of the largest recent run',
      group: 'live-snapshot',
      mode: 'read',
      name: 'live-snapshot/first-page',
      needs: 'seeded',
      response: { kind: 'live-snapshot', limit: pageLimit, runId: run.id },
      role: 'runtime',
      sql: liveTrackSnapshotSql,
      staticValues: [orgId, run.id, null, null, pageLimit + 1],
      tenant: coachTenant,
    },
    {
      description: `Live-track snapshot page after seq ${deepSeq}`,
      group: 'live-snapshot',
      mode: 'read',
      name: 'live-snapshot/deep-page',
      needs: 'seeded',
      role: 'runtime',
      sql: liveTrackSnapshotSql,
      staticValues: [orgId, run.id, null, deepSeq, pageLimit + 1],
      tenant: coachTenant,
    },
    {
      description: 'Live-track changes after the revision just before the newest batch',
      group: 'live-changes',
      mode: 'read',
      name: 'live-changes/one-batch',
      needs: 'seeded',
      response: { afterRevision: previousRevision, kind: 'live-changes', limit: pageLimit, runId: run.id },
      role: 'runtime',
      sql: liveTrackChangesSql,
      staticValues: [orgId, run.id, previousRevision, null, null, pageLimit + 1],
      tenant: coachTenant,
    },
    {
      description: 'Claim scan for a stale summary when every finished run already has a current one',
      group: 'summary',
      mode: 'rollback',
      name: 'summary/claim-stale-idle',
      needs: 'seeded',
      role: 'maintenance',
      sql: 'SELECT org_id, run_id, source_revision, algorithm_version FROM app_private.claim_stale_run_summary($1)',
      staticValues: [claimScanLimit],
      tenant: null,
    },
    {
      description: 'Recalculate, simplify, and publish the summary of the largest recent run (rolled back)',
      dynamicValues: 'publish-candidate',
      group: 'summary',
      mode: 'rollback',
      name: 'summary/publish-current-run',
      needs: 'seeded',
      role: 'maintenance',
      sql: publishCandidateSql,
      staticValues: [orgId, run.id, String(run.dataRevision)],
      tenant: null,
    },
    {
      description: 'Live-state poll of one coach subscription while every member has a recording run',
      group: 'live-state',
      mode: 'read',
      name: 'live-state/ten-active-runs',
      needs: 'active-runs',
      response: { kind: 'live-state' },
      role: 'runtime',
      sql: liveStateSql,
      staticValues: [orgId],
      tenant: { ...coachTenant, visibilityScope: 'live' },
    },
    {
      description: `Insert of ${ingestionBatchSize} new points into a recording run (rolled back)`,
      dynamicValues: 'ingest-batch',
      group: 'ingest',
      mode: 'rollback',
      name: 'ingest/batch-of-100',
      needs: 'active-runs',
      role: 'runtime',
      sql: insertPointsSql,
      staticValues: [orgId, run.id],
      tenant: ownerTenant,
    },
  );

  return {
    activation: {
      organizationId: orgId,
      runs: newestRunPerMember(dataset).map(({ id, userIndex }) => ({ id, userIndex })),
    },
    statements,
  };
}

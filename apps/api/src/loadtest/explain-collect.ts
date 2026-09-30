import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Pool, PoolClient } from 'pg';

import { postgisArchiveTilePipeline, setArchiveTileStatementTimeout } from '../archive/archive-service.js';
import { systemClock } from '../clock.js';
import { withTenantTransaction } from '../database/tenant-transaction.js';
import { readLiveState } from '../live/live-state.js';
import { LiveTrackCursorCodec } from '../runs/live-track-cursor.js';
import {
  listRuns,
  readLiveTrackChanges,
  readLiveTrackSnapshot,
  readRunPoints,
} from '../runs/run-service.js';
import { ingestionBatchSize, pointIntervalMs } from './dataset-plan.js';
import { summarizePlan, type PlanSummary } from './explain-plan.js';
import type { ExplainPlan, ExplainStatement, ResponseSpec } from './explain-statements.js';

export interface ExplainCollectorDependencies {
  /** Keep the raw first EXPLAIN document of each statement; it can contain literal parameter values. */
  keepPlans?: boolean;
  maintenancePool: Pool;
  /** Called before each statement; awaited, so a caller can observe or cancel between statements. */
  onProgress?: (name: string) => void | Promise<void>;
  ownerPool: Pool;
  plan: ExplainPlan;
  /** How many times each statement is explained; the first is the first execution after the previous one ended. */
  repetitions: number;
  runtimePool: Pool;
  signal?: AbortSignal;
}

export interface ResponseMeasurement {
  bytes: number;
  /** One entry per repetition: the whole service call, SQL included. */
  elapsedMs: number[];
  /** JSON.stringify time per repetition; empty for a binary tile. */
  serializeMs: number[];
}

/** SQLSTATE and error class only: a database message can quote parameter values. */
export interface StatementFailure {
  code: string | null;
  errorClass: string;
}

export interface StatementMeasurement {
  description: string;
  error: StatementFailure | null;
  executedAs: string | null;
  executions: PlanSummary[];
  group: string;
  mode: 'read' | 'rollback';
  name: string;
  needs: 'active-runs' | 'seeded';
  /** The raw EXPLAIN document of the first execution; null unless requested. */
  plan: unknown;
  response: ResponseMeasurement | null;
  role: 'maintenance' | 'owner' | 'runtime';
}

export interface ExplainCollection {
  activatedRuns: number;
  statements: StatementMeasurement[];
}

const explainPrefix = 'EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)';
/** A stress-size summary calculation runs for tens of seconds; this only stops a stuck statement. */
const explainStatementTimeout = '600s';

function failureOf(error: unknown): StatementFailure {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null;
  return { code, errorClass: error instanceof Error ? error.constructor.name : 'NonError' };
}

async function rollbackQuietly(client: PoolClient): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return false;
  } catch {
    return true;
  }
}

async function resolveValues(client: PoolClient, statement: ExplainStatement): Promise<readonly unknown[]> {
  const known = statement.staticValues ?? [];
  if (statement.dynamicValues === 'publish-candidate') {
    const version = await client.query<{ version: string }>(
      'SELECT app_private.current_track_algorithm_version() AS version',
    );
    return [...known, version.rows[0]?.version, new Date().toISOString()];
  }
  if (statement.dynamicValues === 'ingest-batch') {
    const [orgId, runId] = known;
    const tail = await client.query<{ last_seq: string; latitude: number; longitude: number }>(
      `SELECT seq::text AS last_seq, ST_X(geom) AS longitude, ST_Y(geom) AS latitude
       FROM run_points WHERE org_id = $1 AND run_id = $2 ORDER BY seq DESC LIMIT 1`,
      [orgId, runId],
    );
    const last = tail.rows[0];
    if (!last) {
      throw new Error('The recording run has no points to continue from');
    }
    // The same run revision bump the service performs before it inserts.
    const revision = await client.query<{ data_revision: string }>(
      'UPDATE runs SET data_revision = data_revision + 1 WHERE org_id = $1 AND id = $2 RETURNING data_revision::text',
      [orgId, runId],
    );
    const nextSeq = BigInt(last.last_seq) + 1n;
    const startMs = Date.now();
    const indexes = Array.from({ length: ingestionBatchSize }, (_, index) => index);
    return [
      orgId,
      runId,
      indexes.map((index) => (nextSeq + BigInt(index)).toString()),
      indexes.map(() => 0),
      indexes.map((index) => new Date(startMs + index * pointIntervalMs).toISOString()),
      indexes.map((index) => last.longitude + (index + 1) * 0.000_01),
      indexes.map((index) => last.latitude + (index + 1) * 0.000_01),
      indexes.map(() => 8),
      new Date(startMs).toISOString(),
      revision.rows[0]?.data_revision,
    ];
  }
  return known;
}

async function explainOnce(
  deps: ExplainCollectorDependencies,
  statement: ExplainStatement,
): Promise<{ document: unknown; executedAs: string; summary: PlanSummary }> {
  const pool = { maintenance: deps.maintenancePool, owner: deps.ownerPool, runtime: deps.runtimePool }[statement.role];
  const client = await pool.connect();
  try {
    await client.query(statement.mode === 'read' ? 'BEGIN READ ONLY' : 'BEGIN');
    if (statement.tenant) {
      await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)", [
        statement.tenant.userId,
        statement.tenant.orgId,
      ]);
    }
    await client.query(`SET LOCAL statement_timeout = '${explainStatementTimeout}'`);
    const identity = await client.query<{ current_user: string }>('SELECT current_user AS current_user');
    const values = await resolveValues(client, statement);
    const result = await client.query<{ 'QUERY PLAN': unknown }>({
      text: `${explainPrefix} ${statement.sql}`,
      values: [...values],
    });
    const document = result.rows[0]?.['QUERY PLAN'];
    return { document, executedAs: identity.rows[0]?.current_user ?? 'unknown', summary: summarizePlan(document) };
  } finally {
    // Every measured statement, including the writes, ends in ROLLBACK.
    const destroy = await rollbackQuietly(client);
    client.release(destroy);
  }
}

function serialized(value: unknown): { bytes: number; ms: number } {
  const started = performance.now();
  const json = JSON.stringify(value);
  const ms = performance.now() - started;
  return { bytes: Buffer.byteLength(json), ms };
}

async function callService(
  spec: ResponseSpec,
  statement: ExplainStatement,
  client: PoolClient,
  codec: LiveTrackCursorCodec,
): Promise<{ bytes: number; serializeMs: number | null }> {
  const tenant = statement.tenant;
  if (!tenant) {
    throw new Error('A response measurement needs a tenant');
  }
  const session = { userId: tenant.userId };
  switch (spec.kind) {
    case 'run-list': {
      const value = await listRuns(client, tenant.orgId, { from: spec.from, limit: spec.limit, to: spec.to });
      const { bytes, ms } = serialized(value);
      return { bytes, serializeMs: ms };
    }
    case 'raw-history': {
      const value = await readRunPoints(client, tenant.orgId, spec.runId, { limit: spec.limit });
      const { bytes, ms } = serialized(value);
      return { bytes, serializeMs: ms };
    }
    case 'live-snapshot': {
      const value = await readLiveTrackSnapshot(client, session, tenant.orgId, spec.runId, { limit: spec.limit }, codec);
      const { bytes, ms } = serialized(value);
      return { bytes, serializeMs: ms };
    }
    case 'live-changes': {
      const value = await readLiveTrackChanges(
        client,
        session,
        tenant.orgId,
        spec.runId,
        { afterRevision: spec.afterRevision, limit: spec.limit },
        codec,
      );
      const { bytes, ms } = serialized(value);
      return { bytes, serializeMs: ms };
    }
    case 'live-state': {
      const value = await readLiveState(client, tenant.orgId);
      const { bytes, ms } = serialized(value);
      return { bytes, serializeMs: ms };
    }
    case 'tile': {
      await setArchiveTileStatementTimeout(client);
      const tile = await postgisArchiveTilePipeline.render(client, {
        path: { orgId: tenant.orgId, x: spec.x, y: spec.y, z: spec.z },
        query: { from: spec.from, revision: '0', to: spec.to },
      });
      return { bytes: tile.length, serializeMs: null };
    }
  }
}

async function measureResponse(
  deps: ExplainCollectorDependencies,
  statement: ExplainStatement,
  spec: ResponseSpec,
  codec: LiveTrackCursorCodec,
): Promise<ResponseMeasurement> {
  const tenant = statement.tenant;
  if (!tenant) {
    throw new Error('A response measurement needs a tenant');
  }
  const measurement: ResponseMeasurement = { bytes: 0, elapsedMs: [], serializeMs: [] };
  for (let repetition = 0; repetition < deps.repetitions; repetition += 1) {
    deps.signal?.throwIfAborted();
    await withTenantTransaction(deps.runtimePool, tenant, async (client) => {
      const started = performance.now();
      const outcome = await callService(spec, statement, client, codec);
      measurement.elapsedMs.push(performance.now() - started);
      measurement.bytes = outcome.bytes;
      if (outcome.serializeMs !== null) {
        measurement.serializeMs.push(outcome.serializeMs);
      }
    });
  }
  return measurement;
}

async function measureStatement(
  deps: ExplainCollectorDependencies,
  statement: ExplainStatement,
  codec: LiveTrackCursorCodec,
): Promise<StatementMeasurement> {
  const measurement: StatementMeasurement = {
    description: statement.description,
    error: null,
    executedAs: null,
    executions: [],
    group: statement.group,
    mode: statement.mode,
    name: statement.name,
    needs: statement.needs,
    plan: null,
    response: null,
    role: statement.role,
  };
  try {
    for (let repetition = 0; repetition < deps.repetitions; repetition += 1) {
      deps.signal?.throwIfAborted();
      const outcome = await explainOnce(deps, statement);
      measurement.executedAs = outcome.executedAs;
      if (repetition === 0 && deps.keepPlans) {
        measurement.plan = outcome.document;
      }
      measurement.executions.push(outcome.summary);
    }
    if (statement.response) {
      measurement.response = await measureResponse(deps, statement, statement.response, codec);
    }
  } catch (error) {
    if (deps.signal?.aborted) {
      throw error;
    }
    measurement.error = failureOf(error);
  }
  return measurement;
}

interface SavedRun {
  finishedAt: string;
  id: string;
}

/**
 * The live-state and ingest statements need recording runs, and the seeded dataset has none. Each member's
 * newest run is switched to `recording` for the duration and put back with its exact `finished_at` text.
 */
async function activateRuns(
  ownerPool: Pool,
  activation: ExplainPlan['activation'],
): Promise<() => Promise<void>> {
  const ids = activation.runs.map(({ id }) => id);
  const client = await ownerPool.connect();
  let saved: SavedRun[];
  try {
    await client.query('BEGIN');
    const before = await client.query<{ finished_at: string | null; id: string; status: string }>(
      'SELECT id, status, finished_at::text AS finished_at FROM runs WHERE org_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE',
      [activation.organizationId, ids],
    );
    if (before.rows.length !== ids.length || before.rows.some((row) => row.status !== 'finished' || !row.finished_at)) {
      throw new Error('The runs to activate are not all finished; the database is not the planned dataset');
    }
    saved = before.rows.map((row) => ({ finishedAt: row.finished_at as string, id: row.id }));
    await client.query(
      `UPDATE runs SET status = 'recording', finished_at = NULL WHERE org_id = $1 AND id = ANY($2::uuid[])`,
      [activation.organizationId, ids],
    );
    await client.query('COMMIT');
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }

  return async () => {
    const restoring = await ownerPool.connect();
    try {
      const result = await restoring.query(
        `UPDATE runs SET status = 'finished', finished_at = saved.finished_at::timestamptz
         FROM unnest($2::uuid[], $3::text[]) AS saved(id, finished_at)
         WHERE runs.org_id = $1 AND runs.id = saved.id`,
        [activation.organizationId, saved.map(({ id }) => id), saved.map(({ finishedAt }) => finishedAt)],
      );
      if (result.rowCount !== saved.length) {
        throw new Error('Not every activated run could be restored; reseed the load dataset');
      }
    } finally {
      restoring.release();
    }
  };
}

/**
 * Runs each planned statement under its own role and tenant context as EXPLAIN (ANALYZE, BUFFERS, WAL), always
 * inside a transaction that is rolled back, and measures the real service response beside it. A failing
 * statement is recorded by SQLSTATE and class and does not stop the others; cancellation does.
 */
export async function collectExplain(deps: ExplainCollectorDependencies): Promise<ExplainCollection> {
  if (!Number.isInteger(deps.repetitions) || deps.repetitions < 1) {
    throw new Error('repetitions must be a positive integer');
  }
  const codec = new LiveTrackCursorCodec({
    clock: systemClock,
    signingKey: randomBytes(32).toString('base64url'),
  });
  const measurements = new Map<string, StatementMeasurement>();

  async function runGroup(statements: readonly ExplainStatement[]): Promise<void> {
    for (const statement of statements) {
      deps.signal?.throwIfAborted();
      await deps.onProgress?.(statement.name);
      deps.signal?.throwIfAborted();
      measurements.set(statement.name, await measureStatement(deps, statement, codec));
    }
  }

  const seeded = deps.plan.statements.filter(({ needs }) => needs === 'seeded');
  const active = deps.plan.statements.filter(({ needs }) => needs === 'active-runs');
  await runGroup(seeded);

  let activatedRuns = 0;
  if (active.length > 0) {
    const restore = await activateRuns(deps.ownerPool, deps.plan.activation);
    activatedRuns = deps.plan.activation.runs.length;
    const outcome = await runGroup(active).then(
      () => ({ failed: false as const }),
      (error: unknown) => ({ error, failed: true as const }),
    );
    // The fixture is restored whether or not the measurements succeeded.
    const restored = await restore().then(
      () => ({ failed: false as const }),
      (error: unknown) => ({ error, failed: true as const }),
    );
    if (outcome.failed) {
      // The measurement failure is what the caller sees; a failed restore must not be silent either.
      if (restored.failed) {
        console.error(restored.error instanceof Error ? restored.error.message : 'The fixture restore failed');
      }
      throw outcome.error;
    }
    if (restored.failed) {
      throw restored.error;
    }
  }

  return {
    activatedRuns,
    statements: deps.plan.statements.flatMap(({ name }) => {
      const measurement = measurements.get(name);
      return measurement ? [measurement] : [];
    }),
  };
}

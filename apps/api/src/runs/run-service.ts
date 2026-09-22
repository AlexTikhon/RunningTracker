import {
  runCommandResponseSchema,
  runViewSchema,
  type CreateRunRequest,
  type RunCommandRequest,
  type RunCommandResponse,
  type RunCommandType,
  type RunStatus,
  type RunView,
} from '@running-tracker/contracts';
import type { PoolClient } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import type { Clock } from '../clock.js';
import { ApiError } from '../http/errors.js';

interface RunRow {
  creation_payload_matches: boolean;
  control_revision: string;
  data_revision: string;
  finished_at: Date | null;
  raw_state: 'available' | 'purging' | 'purged';
  run_id: string;
  started_at: string;
  status: RunStatus;
  summary_algorithm_version: string | null;
  summary_distance_m: number | null;
  summary_observed_duration_s: number | null;
  summary_quality_stats: unknown;
  summary_source_revision: string | null;
}

interface LockedRunRow {
  control_revision: string;
  data_revision: string;
  finished_at: Date | null;
  status: RunStatus;
}

interface StoredCommandRow {
  payload_matches: boolean;
  response: unknown;
}

interface PostgresErrorLike {
  code?: unknown;
  constraint?: unknown;
}

export interface CreateRunResult {
  created: boolean;
  run: RunView;
}

const runViewSelect = `
  SELECT run.id AS run_id,
         run.status,
         to_char(
           run.started_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) AS started_at,
         run.started_at = $4::timestamptz AS creation_payload_matches,
         run.finished_at,
         run.data_revision,
         run.control_revision,
         run.raw_state,
         summary.source_revision AS summary_source_revision,
         summary.algorithm_version AS summary_algorithm_version,
         summary.distance_m AS summary_distance_m,
         summary.observed_duration_s AS summary_observed_duration_s,
         summary.quality_stats AS summary_quality_stats
  FROM runs AS run
  LEFT JOIN run_summaries AS summary
    ON summary.org_id = run.org_id AND summary.run_id = run.id
  WHERE run.org_id = $1 AND run.id = $2 AND run.user_id = $3`;

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as PostgresErrorLike;
  return candidate.code === '23505' && candidate.constraint === constraint;
}

function transportTimestamp(value: string): string {
  const matched = /^(.*\.)(\d{6})Z$/u.exec(value);
  if (!matched) {
    throw new Error('PostgreSQL returned an unexpected UTC timestamp representation');
  }
  const fraction = matched[2]!.replace(/0+$/u, '').padEnd(3, '0');
  return `${matched[1]}${fraction}Z`;
}

function canonicalCommandPayload(command: RunCommandRequest): {
  expectedControlRevision: string;
  type: RunCommandType;
} {
  return {
    expectedControlRevision: BigInt(command.expectedControlRevision).toString(),
    type: command.type,
  };
}

function mapRunView(row: RunRow): RunView {
  const summary =
    row.summary_source_revision === null ||
    row.summary_algorithm_version === null ||
    row.summary_distance_m === null ||
    row.summary_observed_duration_s === null ||
    row.summary_quality_stats === null
      ? null
      : {
          algorithmVersion: row.summary_algorithm_version,
          distanceM: row.summary_distance_m,
          observedDurationS: row.summary_observed_duration_s,
          qualityStats: row.summary_quality_stats,
          sourceRevision: row.summary_source_revision,
        };

  return runViewSchema.parse({
    controlRevision: row.control_revision,
    dataRevision: row.data_revision,
    finishedAt: row.finished_at?.toISOString() ?? null,
    rawState: row.raw_state,
    runId: row.run_id,
    startedAt: transportTimestamp(row.started_at),
    status: row.status,
    summary,
  });
}

async function isTombstoned(
  client: PoolClient,
  orgId: string,
  runId: string,
): Promise<boolean> {
  const result = await client.query(
    'SELECT 1 FROM run_tombstones WHERE org_id = $1 AND run_id = $2',
    [orgId, runId],
  );
  return result.rowCount === 1;
}

async function throwMissingRun(client: PoolClient, orgId: string, runId: string): Promise<never> {
  if (await isTombstoned(client, orgId, runId)) {
    throw new ApiError(410, 'RUN_DELETED', 'The run has been deleted');
  }
  throw new ApiError(404, 'RUN_NOT_FOUND', 'The run does not exist or is not accessible');
}

async function readOwnedRun(
  client: PoolClient,
  orgId: string,
  runId: string,
  userId: string,
  startedAt: string,
): Promise<{ creationPayloadMatches: boolean; run: RunView } | undefined> {
  const result = await client.query<RunRow>(runViewSelect, [orgId, runId, userId, startedAt]);
  const row = result.rows[0];
  return row
    ? { creationPayloadMatches: row.creation_payload_matches, run: mapRunView(row) }
    : undefined;
}

export function nextRunStatus(current: RunStatus, command: RunCommandType): RunStatus | undefined {
  if (command === 'finish') {
    return current === 'finished' ? undefined : 'finished';
  }
  if (current === 'recording' && command === 'pause') {
    return 'paused';
  }
  if (current === 'paused' && command === 'resume') {
    return 'recording';
  }
  return undefined;
}

export async function createRun(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  runId: string,
  request: CreateRunRequest,
  clock: Clock,
): Promise<CreateRunResult> {
  const startedAt = request.startedAt;
  const existing = await readOwnedRun(client, orgId, runId, session.userId, startedAt);
  if (existing) {
    if (!existing.creationPayloadMatches) {
      throw new ApiError(409, 'ACTIVE_RUN_EXISTS', 'The run ID is already bound to a different creation payload');
    }
    return { created: false, run: existing.run };
  }

  if (await isTombstoned(client, orgId, runId)) {
    throw new ApiError(410, 'RUN_DELETED', 'The run has been deleted');
  }

  let inserted: boolean;
  try {
    const result = await client.query(
      `INSERT INTO runs (org_id, id, user_id, started_at, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, id) DO NOTHING
       RETURNING id`,
      [orgId, runId, session.userId, startedAt, clock.utcNow().toISOString()],
    );
    inserted = result.rowCount === 1;
  } catch (error) {
    if (isUniqueViolation(error, 'runs_one_active_per_user_idx')) {
      throw new ApiError(409, 'ACTIVE_RUN_EXISTS', 'The current identity already has an active run');
    }
    throw error;
  }

  const existingAfterInsert = await readOwnedRun(client, orgId, runId, session.userId, startedAt);
  if (!existingAfterInsert) {
    return throwMissingRun(client, orgId, runId);
  }
  if (!existingAfterInsert.creationPayloadMatches) {
    throw new ApiError(409, 'ACTIVE_RUN_EXISTS', 'The run ID is already bound to a different creation payload');
  }
  return { created: inserted, run: existingAfterInsert.run };
}

export async function applyRunCommand(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  runId: string,
  command: RunCommandRequest,
  clock: Clock,
): Promise<RunCommandResponse> {
  const normalizedCommandId = command.commandId.toLowerCase();
  const payload = canonicalCommandPayload(command);
  const locked = await client.query<LockedRunRow>(
    `SELECT status, finished_at, data_revision, control_revision
     FROM runs
     WHERE org_id = $1 AND id = $2 AND user_id = $3
     FOR UPDATE`,
    [orgId, runId, session.userId],
  );
  const run = locked.rows[0];
  if (!run) {
    return throwMissingRun(client, orgId, runId);
  }

  const duplicate = await client.query<StoredCommandRow>(
    `SELECT canonical_payload = $4::jsonb AS payload_matches, response
     FROM run_commands
     WHERE org_id = $1 AND run_id = $2 AND command_id = $3`,
    [orgId, runId, normalizedCommandId, JSON.stringify(payload)],
  );
  const stored = duplicate.rows[0];
  if (stored) {
    if (!stored.payload_matches) {
      throw new ApiError(409, 'CONTROL_REVISION_CONFLICT', 'The command ID is already bound to a different payload');
    }
    return runCommandResponseSchema.parse(stored.response);
  }

  if (run.control_revision !== payload.expectedControlRevision) {
    throw new ApiError(409, 'CONTROL_REVISION_CONFLICT', 'The expected control revision is stale');
  }

  const nextStatus = nextRunStatus(run.status, command.type);
  if (!nextStatus) {
    throw new ApiError(409, 'CONTROL_REVISION_CONFLICT', 'The lifecycle command is not valid for the current run state');
  }

  const finishedAt = nextStatus === 'finished' ? clock.utcNow().toISOString() : null;
  const updated = await client.query<LockedRunRow>(
    `UPDATE runs
     SET status = $4,
         finished_at = $5,
         data_revision = data_revision + 1,
         control_revision = control_revision + 1
     WHERE org_id = $1 AND id = $2 AND user_id = $3
     RETURNING status, finished_at, data_revision, control_revision`,
    [orgId, runId, session.userId, nextStatus, finishedAt],
  );
  const result = updated.rows[0];
  if (!result) {
    throw new Error('The locked run disappeared before its lifecycle update');
  }

  const response = runCommandResponseSchema.parse({
    commandId: normalizedCommandId,
    controlRevision: result.control_revision,
    dataRevision: result.data_revision,
    finishedAt: result.finished_at?.toISOString() ?? null,
    status: result.status,
  });
  await client.query(
    `INSERT INTO run_commands (org_id, run_id, command_id, canonical_payload, response)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [orgId, runId, normalizedCommandId, JSON.stringify(payload), JSON.stringify(response)],
  );
  return response;
}

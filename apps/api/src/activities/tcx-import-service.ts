import {
  TCX_ALREADY_IMPORTED,
  tcxImportPreviewSchema,
  type ActivityType,
  type TcxImportPreview,
} from '@running-tracker/contracts';
import type { PoolClient } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import { ApiError } from '../http/errors.js';
import {
  activityProjection,
  alreadySaved,
  conflict,
  mapActivity,
  notFound,
  readOne,
  type CreateActivityResult,
  type OwnedActivityRow,
} from './activity-service.js';
import type { TcxActivity } from './tcx-activity.js';

// TCX import (ADR-0091). Both functions run inside withAuthenticatedTenantTransaction (membership rechecked, row-level
// security in force, runtime role) and state the owner in every statement. The summary they receive was computed by the
// server from the uploaded file in this request (tcx-activity.ts); nothing here accepts a total, a time or a source from
// the client. Every lookup names source = 'tcx': a TCX import is never matched with a GPX import, a manual entry or a
// recorded run (the unique constraint includes the source too, migration 0042).

// $1 organization, $2 owner, $3 fingerprint. The unique constraint (org_id, user_id, source, import_fingerprint)
// guarantees at most one row.
export const tcxFingerprintActivitySql = `SELECT ${activityProjection}, false AS payload_matches
  FROM activities AS activity
  WHERE activity.org_id = $1 AND activity.user_id = $2 AND activity.source = 'tcx' AND activity.import_fingerprint = $3::bytea`;

// What a TCX import is bound to: its source, the person's type choice and the laps. The start, reported duration and
// distance are functions of the laps under one metrics version, so they are not compared separately.
const importMatches = (type: number, fingerprint: number) => `activity.source = 'tcx'
           AND activity.type = $${type}
           AND activity.import_fingerprint = $${fingerprint}::bytea`;

// By id: $1 organization, $2 activity, $3 owner, $4 type, $5 fingerprint, $6 idempotency key.
export const ownedTcxImportSql = `SELECT ${activityProjection},
         (${importMatches(4, 5)} AND activity.idempotency_key IS NOT DISTINCT FROM $6::uuid) AS payload_matches
  FROM activities AS activity
  WHERE activity.org_id = $1 AND activity.id = $2 AND activity.user_id = $3`;

// By import attempt: $1 organization, $2 owner, $3 idempotency key, $4 type, $5 fingerprint.
export const keyedTcxImportSql = `SELECT ${activityProjection},
         (${importMatches(4, 5)}) AS payload_matches
  FROM activities AS activity
  WHERE activity.org_id = $1 AND activity.user_id = $2 AND activity.idempotency_key = $3::uuid`;

// No conflict target: a clash on the id, on the import attempt's key or on the laps' fingerprint inserts nothing, and the
// reads that follow decide. source is a literal: the only place a 'tcx' row is written. created_at is the database clock
// (migration 0029). No effort, notes, lap, trackpoint or file is written.
export const insertTcxImportSql = `INSERT INTO activities (
         org_id, id, user_id, type, started_at, duration_s, distance_m, rpe, notes, idempotency_key, source, import_fingerprint
       )
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7::double precision, NULL, NULL, $8::uuid, 'tcx', $9::bytea)
       ON CONFLICT DO NOTHING`;

const alreadyImported = (activityId: string) =>
  new ApiError(
    409,
    TCX_ALREADY_IMPORTED,
    'This TCX activity was already imported as one of your activities; nothing was saved',
    { activityId },
  );

/**
 * The preview: the server's summary and, advisory, an existing TCX import with the same laps. Called in a REPEATABLE
 * READ, READ ONLY transaction, so it cannot write even by mistake.
 */
export async function previewTcxImport(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  parsed: TcxActivity,
): Promise<TcxImportPreview> {
  const duplicate = await readOne(client, tcxFingerprintActivitySql, [orgId, session.userId, parsed.fingerprint]);
  return tcxImportPreviewSchema.parse({
    duplicateOf: duplicate ? { activityId: duplicate.activity_id } : null,
    summary: parsed.summary,
  });
}

function decide(row: OwnedActivityRow, byKey: boolean): CreateActivityResult {
  if (!row.payload_matches) throw byKey ? alreadySaved(row.activity_id) : conflict();
  return { activity: mapActivity(row), created: false };
}

/**
 * The confirmation, the ADR-0086 rules with the TCX source. One transaction (the caller's), retry-safe:
 * 1. the same id: an exact retry (same laps, type and key, source tcx) answers the stored activity; anything else, a
 *    manual or GPX row included, is ACTIVITY_CONFLICT;
 * 2. the same import attempt (key) under another id: the same laps and type answer the stored activity; otherwise the
 *    earlier attempt went through with other details (ACTIVITY_ALREADY_SAVED);
 * 3. the same TCX activity already imported by this person in this organization: TCX_ALREADY_IMPORTED naming it;
 * 4. insert. Correctness under concurrency rests on the unique constraints, not on the reads above: a racing
 *    confirmation waits on the unique index, inserts nothing, and the reads after the insert find the winner.
 */
export async function confirmTcxImport(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  activityId: string,
  choice: { idempotencyKey: string; type: ActivityType },
  parsed: TcxActivity,
): Promise<CreateActivityResult> {
  const key = choice.idempotencyKey.toLowerCase();
  const byId = [orgId, activityId, session.userId, choice.type, parsed.fingerprint, key];
  const byKey = [orgId, session.userId, key, choice.type, parsed.fingerprint];
  const byFingerprint = [orgId, session.userId, parsed.fingerprint];

  const settle = async (): Promise<CreateActivityResult | undefined> => {
    const existing = await readOne(client, ownedTcxImportSql, byId);
    if (existing) return decide(existing, false);
    const keyed = await readOne(client, keyedTcxImportSql, byKey);
    if (keyed) return decide(keyed, true);
    const duplicate = await readOne(client, tcxFingerprintActivitySql, byFingerprint);
    if (duplicate) throw alreadyImported(duplicate.activity_id);
    return undefined;
  };

  const before = await settle();
  if (before) return before;

  const { summary } = parsed;
  const inserted = await client.query(insertTcxImportSql, [
    orgId,
    activityId,
    session.userId,
    choice.type,
    summary.startedAt,
    summary.reportedDurationS,
    summary.distanceM,
    key,
    parsed.fingerprint,
  ]);
  // Another member's row with this id is invisible: the insert does nothing and no read finds a row of this person's,
  // which is answered like a missing activity (ADR-0072 explains why that is not an oracle).
  const after = await settle();
  if (after) return { activity: after.activity, created: inserted.rowCount === 1 };
  throw notFound();
}

import {
  GPX_ALREADY_IMPORTED,
  gpxImportPreviewSchema,
  type ActivityType,
  type GpxImportPreview,
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
import type { GpxActivity } from './gpx-activity.js';

// GPX import (ADR-0086). Both functions run inside withAuthenticatedTenantTransaction (membership rechecked, row-level
// security in force, runtime role) and state the owner in every statement. The summary they receive was computed by the
// server from the uploaded file in this request (gpx-activity.ts); nothing here accepts a total, a time or a source from
// the client.

// $1 organization, $2 owner, $3 fingerprint. The unique constraint (org_id, user_id, import_fingerprint) guarantees at
// most one row.
export const fingerprintActivitySql = `SELECT ${activityProjection}, false AS payload_matches
  FROM activities AS activity
  WHERE activity.org_id = $1 AND activity.user_id = $2 AND activity.import_fingerprint = $3::bytea`;

// What an imported activity is bound to: its source, the person's type choice and the track. The start, duration and
// distance are functions of the track under one metrics version, so they are not compared separately.
const importMatches = (type: number, fingerprint: number) => `activity.source = 'gpx'
           AND activity.type = $${type}
           AND activity.import_fingerprint = $${fingerprint}::bytea`;

// By id: $1 organization, $2 activity, $3 owner, $4 type, $5 fingerprint, $6 idempotency key.
export const ownedImportSql = `SELECT ${activityProjection},
         (${importMatches(4, 5)} AND activity.idempotency_key IS NOT DISTINCT FROM $6::uuid) AS payload_matches
  FROM activities AS activity
  WHERE activity.org_id = $1 AND activity.id = $2 AND activity.user_id = $3`;

// By import attempt: $1 organization, $2 owner, $3 idempotency key, $4 type, $5 fingerprint.
export const keyedImportSql = `SELECT ${activityProjection},
         (${importMatches(4, 5)}) AS payload_matches
  FROM activities AS activity
  WHERE activity.org_id = $1 AND activity.user_id = $2 AND activity.idempotency_key = $3::uuid`;

// No conflict target: a clash on the id, on the import attempt's key or on the track's fingerprint inserts nothing, and
// the reads that follow decide. source is a literal: the only place a 'gpx' row is written. created_at is the database
// clock (migration 0029), as for manual rows.
export const insertImportSql = `INSERT INTO activities (
         org_id, id, user_id, type, started_at, duration_s, distance_m, rpe, notes, idempotency_key, source, import_fingerprint
       )
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7::double precision, NULL, NULL, $8::uuid, 'gpx', $9::bytea)
       ON CONFLICT DO NOTHING`;

const alreadyImported = (activityId: string) =>
  new ApiError(
    409,
    GPX_ALREADY_IMPORTED,
    'This track was already imported as one of your activities; nothing was saved',
    { activityId },
  );

/**
 * The preview: the server's summary and, advisory, an existing import of the same track. Called in a REPEATABLE READ,
 * READ ONLY transaction, so it cannot write even by mistake.
 */
export async function previewGpxImport(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  parsed: GpxActivity,
): Promise<GpxImportPreview> {
  const duplicate = await readOne(client, fingerprintActivitySql, [orgId, session.userId, parsed.fingerprint]);
  return gpxImportPreviewSchema.parse({
    duplicateOf: duplicate ? { activityId: duplicate.activity_id } : null,
    summary: parsed.summary,
  });
}

function decide(row: OwnedActivityRow, byKey: boolean): CreateActivityResult {
  if (!row.payload_matches) throw byKey ? alreadySaved(row.activity_id) : conflict();
  return { activity: mapActivity(row), created: false };
}

/**
 * The confirmation. One transaction (the caller's), retry-safe:
 * 1. the same id: an exact retry (same track, type and key) answers the stored activity; anything else is
 *    ACTIVITY_CONFLICT;
 * 2. the same import attempt (key) under another id: the same track and type answers the stored activity; otherwise the
 *    earlier attempt went through with other details (ACTIVITY_ALREADY_SAVED);
 * 3. the same track already imported by this person in this organization: GPX_ALREADY_IMPORTED naming it;
 * 4. insert. Correctness under concurrency rests on the unique constraints, not on the reads above: a racing
 *    confirmation waits on the unique index, inserts nothing, and the reads after the insert find the winner.
 */
export async function confirmGpxImport(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  activityId: string,
  choice: { idempotencyKey: string; type: ActivityType },
  parsed: GpxActivity,
): Promise<CreateActivityResult> {
  const key = choice.idempotencyKey.toLowerCase();
  const byId = [orgId, activityId, session.userId, choice.type, parsed.fingerprint, key];
  const byKey = [orgId, session.userId, key, choice.type, parsed.fingerprint];
  const byFingerprint = [orgId, session.userId, parsed.fingerprint];

  const settle = async (): Promise<CreateActivityResult | undefined> => {
    const existing = await readOne(client, ownedImportSql, byId);
    if (existing) return decide(existing, false);
    const keyed = await readOne(client, keyedImportSql, byKey);
    if (keyed) return decide(keyed, true);
    const duplicate = await readOne(client, fingerprintActivitySql, byFingerprint);
    if (duplicate) throw alreadyImported(duplicate.activity_id);
    return undefined;
  };

  const before = await settle();
  if (before) return before;

  const { summary } = parsed;
  const inserted = await client.query(insertImportSql, [
    orgId,
    activityId,
    session.userId,
    choice.type,
    summary.startedAt,
    summary.elapsedDurationS,
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

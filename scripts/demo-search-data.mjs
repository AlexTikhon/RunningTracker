// The deterministic data of the archive-search demo (docs/runbooks/demo.md, "Search my runs"): a plan that is
// pure and testable, the guards that keep the seed local, and the one function that writes the plan with an
// already-connected owner client. Nothing here connects to a database by itself.
import { demoExternalIdentities, demoIds, demoRoute, requireDevelopmentDatabase } from './demo-plan.mjs';

/**
 * Fixed, obviously synthetic identifiers. The runner is the existing demo runner, so the same sign-in works; every
 * other person and both organizations are new and exist only for this demo.
 */
export const searchDemoIds = Object.freeze({
  organization: 'dddddddd-dddd-4ddd-8ddd-dddddddd1000',
  otherOrganization: 'dddddddd-dddd-4ddd-8ddd-dddddddd1001',
  outsider: 'dddddddd-dddd-4ddd-8ddd-dddddddd0301',
  runner: demoIds.runner,
  teammateOne: 'dddddddd-dddd-4ddd-8ddd-dddddddd0201',
  teammateTwo: 'dddddddd-dddd-4ddd-8ddd-dddddddd0202',
});

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/u;

export function parseSearchSeedArguments(argv, now = new Date()) {
  let month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== '--month') {
      throw new Error(`Unknown argument ${String(flag)}`);
    }
    if (value === undefined) {
      throw new Error(`${flag} needs a value`);
    }
    month = value;
  }
  parseMonth(month);
  return { month };
}

function parseMonth(month) {
  const match = MONTH_PATTERN.exec(month);
  if (!match || Number(match[1]) < 2000 || Number(match[1]) > 2100) {
    throw new Error('month must be YYYY-MM between 2000-01 and 2100-12');
  }
  return { monthIndex: Number(match[2]) - 1, year: Number(match[1]) };
}

/** The seed writes as the table owner, so it is limited to the plain local development database. */
export function requireSearchSeedAllowed(environment) {
  if (environment.APP_ENV === 'production') {
    throw new Error('Refusing to seed demo data with APP_ENV=production');
  }
  if (environment.APP_ENV !== undefined && environment.APP_ENV !== 'development') {
    throw new Error(`Refusing to seed demo data with APP_ENV=${environment.APP_ENV}; only development is allowed`);
  }
  requireDevelopmentDatabase(environment.MIGRATION_DATABASE_URL);
}

// Runs of the runner in the main organization, as offsets from a month start. `quality` is what the summary
// says about the track: good (every measurement used), poor (seven in ten used) or insufficient (no usable
// segment, so no distance).
const currentMonth = [
  ['r01', 0, 0, 0, 8_000, 2_700, 'good'],
  ['r02', 1, 6, 30, 5_000, 1_650, 'good'],
  ['r03', 2, 7, 0, 10_000, 3_300, 'good'],
  ['r04', 3, 6, 0, 3_200, 1_100, 'good'],
  ['r05', 4, 17, 45, 5_000, 1_700, 'poor'],
  ['r06', 5, 6, 0, 21_097.5, 7_500, 'good'],
  ['r07', 6, 8, 15, 12_500, 4_100, 'good'],
  ['r08', 7, 6, 0, 10_000, 3_400, 'good'],
  ['r09', 8, 6, 0, 0, 0, 'insufficient'],
  ['r10', 9, 18, 0, 4_999.96, 1_500, 'good'],
  ['r11', 10, 6, 0, 15_000, 5_100, 'good'],
  ['r12', 11, 6, 0, 6_200, 2_100, 'good'],
  ['r13', 12, 6, 0, 5_000, 1_680, 'good'],
  ['r14', 13, 6, 0, 9_000, 3_000, 'poor'],
  ['r15', 14, 6, 0, 10_000, 3_350, 'good'],
  // The same start and the same distance as r15: only the run id tells them apart.
  ['r16', 14, 6, 0, 10_000, 3_350, 'good'],
  ['r17', 16, 6, 0, 3_000, 1_000, 'good'],
  ['r18', 17, 6, 0, 42_195, 15_000, 'good'],
  ['r19', 18, 6, 0, 11_000, 3_700, 'good'],
  ['r20', 19, 6, 0, 0, 0, 'insufficient'],
  ['r21', 20, 6, 0, 5_000, 1_690, 'good'],
  ['r22', 21, 6, 0, 8_000, 2_750, 'good'],
  ['r23', 22, 6, 0, 13_100, 4_500, 'poor'],
  ['r24', 24, 6, 0, 6_000, 2_000, 'good'],
];
// No summary yet, and one whose summary was made for an older revision. Both carry synthetic points, so the API's
// summary worker really does process them, which is what "still being processed" means.
const currentMonthPending = [
  ['r25', 6, 12, 0, 'missing'],
  ['r26', 12, 12, 0, 'missing'],
  ['r27', 20, 12, 0, 'stale'],
];
const previousMonth = [
  ['q01', 0, 6, 0, 6_000, 2_000, 'good'],
  ['q02', 2, 6, 0, 10_000, 3_300, 'good'],
  ['q03', 4, 6, 0, 5_000, 1_700, 'good'],
  ['q04', 6, 6, 0, 15_000, 5_000, 'good'],
  ['q05', 8, 6, 0, 8_000, 2_700, 'poor'],
  ['q06', 10, 6, 0, 3_000, 1_000, 'good'],
  ['q07', 12, 6, 0, 10_000, 3_350, 'good'],
  ['q08', 14, 6, 0, 21_097.5, 7_400, 'good'],
  ['q09', 16, 6, 0, 5_000, 1_650, 'good'],
  ['q10', 18, 6, 0, 0, 0, 'insufficient'],
  ['q11', 20, 6, 0, 7_000, 2_400, 'good'],
  ['q12', 22, 6, 0, 12_000, 4_000, 'good'],
];
const olderMonth = [
  ['o01', 1, 6, 0, 4_000, 1_400, 'good'],
  ['o02', 5, 6, 0, 9_000, 3_000, 'good'],
  ['o03', 9, 6, 0, 10_000, 3_300, 'good'],
  ['o04', 13, 6, 0, 16_000, 5_400, 'good'],
  ['o05', 17, 6, 0, 5_500, 1_900, 'good'],
  ['o06', 21, 6, 0, 10_000, 3_350, 'good'],
];

const teammateRuns = [
  // [owner, label, day, hour, distance, duration, shared with the runner]
  ['teammateOne', 't101', 2, 6, 7_000, 2_400, true],
  ['teammateOne', 't102', 5, 6, 11_000, 3_700, true],
  ['teammateOne', 't103', 9, 6, 5_000, 1_700, true],
  ['teammateOne', 't104', 13, 6, 10_000, 3_400, false],
  ['teammateOne', 't105', 18, 6, 26_000, 9_300, false],
  ['teammateTwo', 't201', 3, 7, 6_500, 2_200, true],
  ['teammateTwo', 't202', 10, 7, 9_500, 3_200, false],
  ['teammateTwo', 't203', 20, 7, 12_000, 4_100, false],
];

// The second organization is recognisable by its long runs.
const otherOrganizationRunner = [
  ['b01', 'current', 1, 15_000, 5_100],
  ['b02', 'current', 4, 20_000, 6_900],
  ['b03', 'current', 8, 25_000, 8_700],
  ['b04', 'current', 12, 18_000, 6_200],
  ['b05', 'current', 15, 30_000, 10_500],
  ['b06', 'current', 19, 16_500, 5_700],
  ['b07', 'previous', 3, 22_000, 7_600],
  ['b08', 'previous', 17, 19_000, 6_500],
];
const otherOrganizationOutsider = [
  ['x01', 2, 5_000, 1_700, true],
  ['x02', 6, 8_000, 2_700, true],
  ['x03', 11, 10_000, 3_400, false],
  ['x04', 16, 12_000, 4_100, false],
];

function runId(month, serial) {
  const { monthIndex, year } = parseMonth(month);
  const stamp = `${String(year % 100).padStart(2, '0')}${String(monthIndex + 1).padStart(2, '0')}`;
  return `dddddddd-dddd-4ddd-8ddd-5ea0${stamp}${String(serial).padStart(4, '0')}`;
}

function qualityOf(distanceM, durationS, quality) {
  const raw = quality === 'insufficient' ? 6 : Math.max(Math.round(durationS / 2), 2);
  return {
    acceptedPoints: quality === 'insufficient' ? 0 : quality === 'poor' ? Math.round(raw * 0.7) : raw,
    distanceM,
    insufficient: quality === 'insufficient',
    observedDurationS: durationS,
    rawPoints: raw,
  };
}

/**
 * @param {{ asOf?: Date, month: string }} input `asOf` is the moment the seed runs. A month that has not ended is
 *   compressed into the time that has passed, so no demo run is dated in the future; omitted, the month is whole.
 */
export function searchDemoPlan({ asOf, month }) {
  const { monthIndex, year } = parseMonth(month);
  const monthStart = Date.UTC(year, monthIndex, 1);
  const previousStart = Date.UTC(year, monthIndex - 1, 1);
  const olderStart = Date.UTC(year, monthIndex - 2, 1);
  const monthEnd = Date.UTC(year, monthIndex + 1, 1);
  const elapsed = asOf === undefined ? monthEnd - monthStart : asOf.getTime() - monthStart;
  const scale = Math.min(1, Math.max(0, elapsed / (monthEnd - monthStart)));

  let serial = 0;
  const runs = [];
  const iso = (ms) => new Date(ms).toISOString();

  function add({ dataRevision = '1', durationS, label, orgId, points = [], startedMs, summary, userId }) {
    serial += 1;
    runs.push({
      dataRevision,
      finishedAt: iso(startedMs + Math.max(durationS, 60) * 1_000),
      id: runId(month, serial),
      label,
      orgId,
      points,
      startedAt: iso(startedMs),
      status: 'finished',
      summary,
      userId,
    });
  }

  const at = (base, day, hour, minute, factor = 1) =>
    base + Math.round(((day * 24 + hour) * 60 + minute) * 60 * factor) * 1_000;

  for (const [label, day, hour, minute, distance, duration, quality] of currentMonth) {
    add({
      durationS: duration,
      label,
      orgId: searchDemoIds.organization,
      startedMs: at(monthStart, day, hour, minute, scale),
      summary: { ...qualityOf(distance, duration, quality), sourceRevision: '1' },
      userId: searchDemoIds.runner,
    });
  }
  for (const [label, day, hour, minute, state] of currentMonthPending) {
    const startedMs = at(monthStart, day, hour, minute, scale);
    add({
      dataRevision: state === 'stale' ? '2' : '1',
      durationS: 60,
      label,
      orgId: searchDemoIds.organization,
      points: demoRoute({ count: 30, startMs: startedMs }),
      startedMs,
      summary: state === 'stale' ? { ...qualityOf(9_000, 3_000, 'good'), sourceRevision: '1' } : null,
      userId: searchDemoIds.runner,
    });
  }
  for (const [label, day, hour, minute, distance, duration, quality] of previousMonth) {
    add({
      durationS: duration,
      label,
      orgId: searchDemoIds.organization,
      startedMs: at(previousStart, day, hour, minute),
      summary: { ...qualityOf(distance, duration, quality), sourceRevision: '1' },
      userId: searchDemoIds.runner,
    });
  }
  // The last second of the previous month in UTC: in a zone ahead of UTC it already belongs to this month.
  add({
    durationS: 1_700,
    label: 'q13',
    orgId: searchDemoIds.organization,
    startedMs: monthStart - 1_000,
    summary: { ...qualityOf(5_000, 1_700, 'good'), sourceRevision: '1' },
    userId: searchDemoIds.runner,
  });
  {
    const startedMs = at(previousStart, 25, 12, 0);
    add({
      durationS: 60,
      label: 'q14',
      orgId: searchDemoIds.organization,
      points: demoRoute({ count: 30, startMs: startedMs }),
      startedMs,
      summary: null,
      userId: searchDemoIds.runner,
    });
  }
  for (const [label, day, hour, minute, distance, duration, quality] of olderMonth) {
    add({
      durationS: duration,
      label,
      orgId: searchDemoIds.organization,
      startedMs: at(olderStart, day, hour, minute),
      summary: { ...qualityOf(distance, duration, quality), sourceRevision: '1' },
      userId: searchDemoIds.runner,
    });
  }

  const shares = [];
  for (const [owner, label, day, hour, distance, duration, shared] of teammateRuns) {
    add({
      durationS: duration,
      label,
      orgId: searchDemoIds.organization,
      startedMs: at(monthStart, day, hour, 0, scale),
      summary: { ...qualityOf(distance, duration, 'good'), sourceRevision: '1' },
      userId: searchDemoIds[owner],
    });
    if (shared) {
      shares.push({
        canReadHistory: true,
        canReadLive: false,
        granteeUserId: searchDemoIds.runner,
        orgId: searchDemoIds.organization,
        runId: runs.at(-1).id,
      });
    }
  }
  for (const [label, base, day, distance, duration] of otherOrganizationRunner) {
    add({
      durationS: duration,
      label,
      orgId: searchDemoIds.otherOrganization,
      startedMs: base === 'current' ? at(monthStart, day, 7, 0, scale) : at(previousStart, day, 7, 0),
      summary: { ...qualityOf(distance, duration, 'good'), sourceRevision: '1' },
      userId: searchDemoIds.runner,
    });
  }
  for (const [label, day, distance, duration, shared] of otherOrganizationOutsider) {
    add({
      durationS: duration,
      label,
      orgId: searchDemoIds.otherOrganization,
      startedMs: at(monthStart, day, 8, 0, scale),
      summary: { ...qualityOf(distance, duration, 'good'), sourceRevision: '1' },
      userId: searchDemoIds.outsider,
    });
    if (shared) {
      shares.push({
        canReadHistory: true,
        canReadLive: false,
        granteeUserId: searchDemoIds.runner,
        orgId: searchDemoIds.otherOrganization,
        runId: runs.at(-1).id,
      });
    }
  }

  return {
    memberships: [
      { orgId: searchDemoIds.organization, role: 'runner', userId: searchDemoIds.runner },
      { orgId: searchDemoIds.organization, role: 'runner', userId: searchDemoIds.teammateOne },
      { orgId: searchDemoIds.organization, role: 'runner', userId: searchDemoIds.teammateTwo },
      { orgId: searchDemoIds.otherOrganization, role: 'runner', userId: searchDemoIds.runner },
      { orgId: searchDemoIds.otherOrganization, role: 'runner', userId: searchDemoIds.outsider },
    ],
    month,
    organizations: [{ id: searchDemoIds.organization }, { id: searchDemoIds.otherOrganization }],
    runs,
    shares,
    users: [
      { externalIdentity: demoExternalIdentities.runner, id: searchDemoIds.runner },
      { externalIdentity: 'demo-search-teammate-1', id: searchDemoIds.teammateOne },
      { externalIdentity: 'demo-search-teammate-2', id: searchDemoIds.teammateTwo },
      { externalIdentity: 'demo-search-outsider', id: searchDemoIds.outsider },
    ],
  };
}

function qualityStatsJson(summary) {
  return JSON.stringify({
    acceptedEdgeCount: Math.max(summary.acceptedPoints - 1, 0),
    acceptedPointCount: summary.acceptedPoints,
    excessiveSpeedCount: 0,
    excessiveTimeGapCount: 0,
    insufficientData: summary.insufficient,
    nonpositiveTimeDeltaCount: 0,
    poorAccuracyPointCount: summary.acceptedPoints < summary.rawPoints ? summary.rawPoints - summary.acceptedPoints : 0,
    rawPointCount: summary.rawPoints,
    segmentBreakCount: 0,
    seqGapCount: 0,
  });
}

/**
 * Writes the plan with a connected owner client in one transaction. Idempotent and additive: every insert is
 * `ON CONFLICT DO NOTHING`, nothing is updated or deleted, and a run's summary and points are written only when
 * the run itself is new, so a second invocation never overwrites what the summary worker has made since.
 */
export async function applySearchDemoPlan(client, plan, { algorithmVersion }) {
  const counts = { memberships: 0, organizations: 0, runsExisting: 0, runsInserted: 0, shares: 0, users: 0 };
  await client.query('BEGIN');
  try {
    for (const user of plan.users) {
      const result = await client.query(
        'INSERT INTO users (id, external_identity) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [user.id, user.externalIdentity],
      );
      counts.users += result.rowCount ?? 0;
    }
    for (const organization of plan.organizations) {
      const result = await client.query(
        'INSERT INTO organizations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
        [organization.id],
      );
      counts.organizations += result.rowCount ?? 0;
    }
    for (const membership of plan.memberships) {
      const result = await client.query(
        `INSERT INTO memberships (org_id, user_id, role, active) VALUES ($1, $2, $3, true)
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [membership.orgId, membership.userId, membership.role],
      );
      counts.memberships += result.rowCount ?? 0;
    }
    for (const run of plan.runs) {
      const inserted = await client.query(
        `INSERT INTO runs (org_id, id, user_id, status, started_at, created_at, finished_at, data_revision)
         VALUES ($1, $2, $3, 'finished', $4, $4, $5, $6)
         ON CONFLICT (org_id, id) DO NOTHING`,
        [run.orgId, run.id, run.userId, run.startedAt, run.finishedAt, run.dataRevision],
      );
      if ((inserted.rowCount ?? 0) === 0) {
        counts.runsExisting += 1;
        continue;
      }
      counts.runsInserted += 1;
      if (run.summary !== null) {
        await client.query(
          `INSERT INTO run_summaries (
             org_id, run_id, source_revision, algorithm_version,
             distance_m, observed_duration_s, quality_stats
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            run.orgId,
            run.id,
            run.summary.sourceRevision,
            algorithmVersion,
            run.summary.distanceM,
            run.summary.observedDurationS,
            qualityStatsJson(run.summary),
          ],
        );
      }
      if (run.points.length > 0) {
        await client.query(
          `INSERT INTO run_points (
             org_id, run_id, seq, segment_id, recorded_at, received_at, geom, accuracy_m, ingested_revision
           )
           SELECT $1, $2, input.seq, input.segment_id, input.recorded_at, $9::timestamptz,
                  ST_SetSRID(ST_MakePoint(input.longitude, input.latitude), 4326),
                  input.accuracy_m, 1
           FROM unnest(
             $3::bigint[], $4::integer[], $5::timestamptz[],
             $6::double precision[], $7::double precision[], $8::double precision[]
           ) AS input(seq, segment_id, recorded_at, longitude, latitude, accuracy_m)`,
          [
            run.orgId,
            run.id,
            run.points.map((point) => point.seq),
            run.points.map((point) => point.segmentId),
            run.points.map((point) => point.recordedAt),
            run.points.map((point) => point.longitude),
            run.points.map((point) => point.latitude),
            run.points.map((point) => point.accuracyM),
            run.finishedAt,
          ],
        );
      }
    }
    for (const share of plan.shares) {
      const result = await client.query(
        `INSERT INTO run_shares (org_id, run_id, grantee_user_id, can_read_history, can_read_live)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, run_id, grantee_user_id) DO NOTHING`,
        [share.orgId, share.runId, share.granteeUserId, share.canReadHistory, share.canReadLive],
      );
      counts.shares += result.rowCount ?? 0;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  return counts;
}

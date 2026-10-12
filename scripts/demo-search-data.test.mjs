import assert from 'node:assert/strict';
import test from 'node:test';

import { demoIds } from './demo-plan.mjs';
import {
  parseSearchSeedArguments,
  requireSearchSeedAllowed,
  searchDemoIds,
  searchDemoPlan,
} from './demo-search-data.mjs';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const plan = searchDemoPlan({ month: '2026-10' });

const runsOf = (orgId, userId) => plan.runs.filter((run) => run.orgId === orgId && run.userId === userId);

test('the plan is deterministic for a month and differs between months', () => {
  assert.deepEqual(searchDemoPlan({ month: '2026-10' }), plan);
  const other = searchDemoPlan({ month: '2026-11' });
  assert.notDeepEqual(
    other.runs.map((run) => run.id),
    plan.runs.map((run) => run.id),
  );
  assert.equal(other.runs.length, plan.runs.length);
});

test('every identifier is a distinct canonical UUID and none belongs to the original demo', () => {
  const ids = [
    ...plan.users.map((user) => user.id),
    ...plan.organizations.map((organization) => organization.id),
    ...plan.runs.map((run) => run.id),
  ];
  for (const id of ids) {
    assert.match(id, uuidPattern);
  }
  assert.equal(new Set(ids).size, ids.length);
  const original = new Set(Object.values(demoIds));
  for (const organization of plan.organizations) {
    assert.ok(!original.has(organization.id), 'the search demo uses its own organizations');
  }
  for (const user of plan.users) {
    assert.ok(user.externalIdentity.startsWith('demo-'), 'only demo identities are created');
  }
});

test('there are several dozen of the runner’s own finished runs in the main organization', () => {
  const own = runsOf(searchDemoIds.organization, searchDemoIds.runner);
  assert.ok(own.length >= 36, `expected at least 36 runs, got ${own.length}`);
  for (const run of plan.runs) {
    assert.equal(run.status, 'finished');
    assert.ok(Date.parse(run.finishedAt) > Date.parse(run.startedAt));
    assert.ok(Number.isFinite(Date.parse(run.startedAt)));
  }
});

test('the runner’s runs spread across this month, the previous month and older, and straddle the UTC month edge', () => {
  const own = runsOf(searchDemoIds.organization, searchDemoIds.runner);
  const months = new Set(own.map((run) => run.startedAt.slice(0, 7)));
  assert.ok(months.has('2026-10'));
  assert.ok(months.has('2026-09'));
  assert.ok(months.has('2026-08'));
  assert.ok(own.some((run) => run.startedAt === '2026-10-01T00:00:00.000Z'));
  assert.ok(own.some((run) => run.startedAt === '2026-09-30T23:59:59.000Z'));
});

test('there are equal sort values, an identical pair, and a distance just under a round bound', () => {
  const own = runsOf(searchDemoIds.organization, searchDemoIds.runner).filter((run) => run.summary !== null);
  const byDistance = new Map();
  for (const run of own) {
    byDistance.set(run.summary.distanceM, (byDistance.get(run.summary.distanceM) ?? 0) + 1);
  }
  assert.ok([...byDistance.values()].some((count) => count >= 3), 'three runs share one distance');
  const pairs = new Map();
  for (const run of own) {
    const key = `${run.startedAt}|${run.summary.distanceM}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  assert.ok([...pairs.values()].some((count) => count >= 2), 'two runs share start and distance');
  assert.ok(own.some((run) => run.summary.distanceM === 4999.96));
});

test('some runs have no current summary, with synthetic points the worker can process', () => {
  const own = runsOf(searchDemoIds.organization, searchDemoIds.runner);
  const missing = own.filter((run) => run.summary === null);
  const stale = own.filter((run) => run.summary !== null && run.summary.sourceRevision !== run.dataRevision);
  assert.ok(missing.length >= 2);
  assert.ok(stale.length >= 1);
  for (const run of [...missing, ...stale]) {
    assert.ok(run.points.length >= 10, 'pending runs carry points so processing them is real');
  }
  const current = own.filter((run) => run.summary !== null && run.summary.sourceRevision === run.dataRevision);
  assert.ok(current.length >= 30);
  for (const run of current) {
    assert.deepEqual(run.points, []);
  }
});

test('quality varies: good, poor and insufficient data', () => {
  const summaries = runsOf(searchDemoIds.organization, searchDemoIds.runner)
    .map((run) => run.summary)
    .filter((summary) => summary !== null);
  assert.ok(summaries.some((summary) => summary.insufficient));
  assert.ok(summaries.some((summary) => !summary.insufficient && summary.acceptedPoints * 5 < summary.rawPoints * 4));
  assert.ok(summaries.some((summary) => !summary.insufficient && summary.acceptedPoints === summary.rawPoints));
});

test('other people’s runs in the same organization are shared with the runner and are not hers', () => {
  const teammates = plan.runs.filter(
    (run) => run.orgId === searchDemoIds.organization && run.userId !== searchDemoIds.runner,
  );
  assert.ok(teammates.length >= 6);
  const sharedIds = new Set(plan.shares.map((share) => share.runId));
  const shared = teammates.filter((run) => sharedIds.has(run.id));
  assert.ok(shared.length >= 3, 'some are readable by the runner through a share');
  assert.ok(teammates.length > shared.length, 'some are not shared at all');
  for (const share of plan.shares) {
    assert.equal(share.granteeUserId, searchDemoIds.runner);
    assert.equal(share.canReadHistory, true);
  }
});

test('a second organization holds the runner’s own runs and a stranger’s, apart from the first', () => {
  const second = plan.runs.filter((run) => run.orgId === searchDemoIds.otherOrganization);
  assert.ok(runsOf(searchDemoIds.otherOrganization, searchDemoIds.runner).length >= 6);
  assert.ok(second.some((run) => run.userId === searchDemoIds.outsider));
  assert.ok(
    runsOf(searchDemoIds.otherOrganization, searchDemoIds.runner).every(
      (run) => run.summary === null || run.summary.distanceM >= 15_000,
    ),
    'the second organization is recognisable by its longer runs',
  );
  const memberships = plan.memberships.filter((entry) => entry.orgId === searchDemoIds.otherOrganization);
  assert.ok(memberships.some((entry) => entry.userId === searchDemoIds.runner));
  assert.ok(memberships.some((entry) => entry.userId === searchDemoIds.outsider));
});

test('every run’s owner is a member of its organization', () => {
  const members = new Set(plan.memberships.map((entry) => `${entry.orgId}|${entry.userId}`));
  for (const run of plan.runs) {
    assert.ok(members.has(`${run.orgId}|${run.userId}`), `${run.label} has no membership`);
  }
});

test('the month argument is validated and defaults to the current UTC month', () => {
  assert.deepEqual(parseSearchSeedArguments([], new Date('2026-10-11T08:00:00Z')), { month: '2026-10' });
  assert.deepEqual(parseSearchSeedArguments(['--month', '2026-02'], new Date('2026-10-11T08:00:00Z')), {
    month: '2026-02',
  });
  assert.throws(() => parseSearchSeedArguments(['--month', '2026-13'], new Date()), /month/);
  assert.throws(() => parseSearchSeedArguments(['--month', 'October'], new Date()), /month/);
  assert.throws(() => parseSearchSeedArguments(['--month'], new Date()), /needs a value/);
  assert.throws(() => parseSearchSeedArguments(['--force'], new Date()), /Unknown argument/);
  assert.throws(() => searchDemoPlan({ month: '1999-12' }), /month/);
});

test('seeding is refused in production and against anything but the local development database', () => {
  const good = 'postgresql://running_tracker_owner:owner_local_only@127.0.0.1:5433/running_tracker';
  assert.doesNotThrow(() => requireSearchSeedAllowed({ APP_ENV: 'development', MIGRATION_DATABASE_URL: good }));
  assert.doesNotThrow(() => requireSearchSeedAllowed({ MIGRATION_DATABASE_URL: good }));
  assert.throws(() => requireSearchSeedAllowed({ APP_ENV: 'production', MIGRATION_DATABASE_URL: good }), /production/);
  assert.throws(() => requireSearchSeedAllowed({ APP_ENV: 'test', MIGRATION_DATABASE_URL: good }), /APP_ENV/);
  assert.throws(
    () =>
      requireSearchSeedAllowed({
        APP_ENV: 'development',
        MIGRATION_DATABASE_URL: 'postgresql://running_tracker_owner:x@db.example.com:5432/running_tracker',
      }),
    /loopback/,
  );
  assert.throws(
    () =>
      requireSearchSeedAllowed({
        APP_ENV: 'development',
        MIGRATION_DATABASE_URL: 'postgresql://running_tracker_owner:x@127.0.0.1:5433/running_tracker_test',
      }),
    /running_tracker/,
  );
  assert.throws(
    () =>
      requireSearchSeedAllowed({
        APP_ENV: 'development',
        MIGRATION_DATABASE_URL: 'postgresql://running_tracker_runtime:x@127.0.0.1:5433/running_tracker',
      }),
    /owner/,
  );
  assert.throws(() => requireSearchSeedAllowed({ APP_ENV: 'development' }), /MIGRATION_DATABASE_URL/);
});

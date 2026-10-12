// Adds a deterministic archive-search demo data set to the local development database: several dozen synthetic
// runs of the demo runner, runs of other people (some shared with the runner), and a second organization.
// Explicit, additive and idempotent. See docs/runbooks/demo.md. Run with `npm run demo:seed:search`.
import { existsSync } from 'node:fs';
import process from 'node:process';

import pg from 'pg';

import {
  applySearchDemoPlan,
  parseSearchSeedArguments,
  requireSearchSeedAllowed,
  searchDemoIds,
  searchDemoPlan,
} from './demo-search-data.mjs';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

requireSearchSeedAllowed(process.env);
const now = new Date();
const { month } = parseSearchSeedArguments(process.argv.slice(2), now);
// A month that is still running is compressed into the time that has passed, so no demo run is in the future.
const asOf = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
const plan = searchDemoPlan({ asOf, month });

const client = new pg.Client({
  application_name: 'running-tracker-demo-search-seed',
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
await client.connect();
let counts;
try {
  const version = await client.query('SELECT app_private.current_track_algorithm_version() AS version');
  counts = await applySearchDemoPlan(client, plan, { algorithmVersion: version.rows[0].version });
} finally {
  await client.end();
}

const pending = plan.runs.filter(
  (run) => run.userId === searchDemoIds.runner && run.points.length > 0,
).length;
console.log(`Archive-search demo data for ${month} is in place in the development database.`);
console.log('');
console.log(`  runs written     ${counts.runsInserted} new, ${counts.runsExisting} already there`);
console.log(`  people           ${counts.users} new (the runner is the existing demo runner)`);
console.log(`  organizations    ${counts.organizations} new`);
console.log(`  shares           ${counts.shares} new`);
console.log('');
console.log(`  organization     ${searchDemoIds.organization}   (the runner's runs, teammates' runs, ${pending} still being processed)`);
console.log(`  other            ${searchDemoIds.otherOrganization}   (a second organization, longer runs)`);
console.log(`  runner           ${searchDemoIds.runner}`);
console.log('');
console.log('Sign in as the demo runner (docs/runbooks/demo.md, "Search my runs"), open Archive, and use "My runs".');
console.log(
  `${pending} runs have no current result yet. The API's summary worker processes them within about a minute, ` +
    'after which they appear in the list.',
);

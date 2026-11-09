// The iPhone LAN pilot's seed: the two synthetic demo people and their organization, nothing else. Runs inside the
// pilot's one-shot init job, after bootstrap and migrations, against the pilot's own database only. Idempotent.
import process from 'node:process';

import pg from 'pg';

import { seedDemoPeople } from './demo-people.mjs';
import { demoIds } from './demo-plan.mjs';
import { pilotDatabase, requireLanPilotDatabase } from './lan-pilot-config.mjs';

const databaseUrl = process.env.MIGRATION_DATABASE_URL;
requireLanPilotDatabase(databaseUrl);
if (process.env.APP_ENV === 'production') {
  throw new Error('Refusing to seed demo data with APP_ENV=production');
}

const client = new pg.Client({ application_name: 'running-tracker-lan-pilot-seed', connectionString: databaseUrl });
await client.connect();
try {
  const { rows } = await client.query('SELECT current_database() AS name');
  if (rows[0].name !== pilotDatabase) throw new Error(`Connected to ${rows[0].name}, not ${pilotDatabase}`);
  await seedDemoPeople(client);
} finally {
  await client.end();
}

console.log(`Synthetic demo people are in place in ${pilotDatabase}: organization ${demoIds.organization}, runner ${demoIds.runner}, coach ${demoIds.coach}.`);

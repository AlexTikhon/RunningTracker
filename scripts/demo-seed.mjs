// Creates the two demo people and their organization in the local development database.
// Idempotent. See docs/runbooks/demo.md. Run with `npm run demo:seed`.
import { existsSync } from 'node:fs';
import process from 'node:process';

import pg from 'pg';

import { seedDemoPeople } from './demo-people.mjs';
import { demoIds, requireDevelopmentDatabase } from './demo-plan.mjs';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const databaseUrl = process.env.MIGRATION_DATABASE_URL;
requireDevelopmentDatabase(databaseUrl);
if (process.env.APP_ENV === 'production') {
  throw new Error('Refusing to seed demo data with APP_ENV=production');
}

const client = new pg.Client({ application_name: 'running-tracker-demo-seed', connectionString: databaseUrl });
await client.connect();
try {
  await seedDemoPeople(client);
} finally {
  await client.end();
}

console.log('Demo data is in place in the development database.');
console.log('');
console.log(`  organization  ${demoIds.organization}`);
console.log(`  runner        ${demoIds.runner}`);
console.log(`  coach         ${demoIds.coach}`);
console.log('');
console.log('Set these in .env, then restart the API (it reads them at startup):');
console.log('');
console.log('  LOCAL_AUTH_ENABLED=true');
console.log(`  LOCAL_AUTH_USER_IDS=${demoIds.runner},${demoIds.coach}`);

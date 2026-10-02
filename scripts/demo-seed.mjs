// Creates the two demo people and their organization in the local development database.
// Idempotent. See docs/runbooks/demo.md. Run with `npm run demo:seed`.
import { existsSync } from 'node:fs';
import process from 'node:process';

import pg from 'pg';

import { demoExternalIdentities, demoIds, requireDevelopmentDatabase } from './demo-plan.mjs';

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
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO users (id, external_identity) VALUES ($1, $2), ($3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [demoIds.runner, demoExternalIdentities.runner, demoIds.coach, demoExternalIdentities.coach],
  );
  await client.query('INSERT INTO organizations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [
    demoIds.organization,
  ]);
  await client.query(
    `INSERT INTO memberships (org_id, user_id, role, active)
     VALUES ($1, $2, 'runner', true), ($1, $3, 'coach', true)
     ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = true`,
    [demoIds.organization, demoIds.runner, demoIds.coach],
  );
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
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

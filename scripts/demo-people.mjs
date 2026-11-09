// The demo people and their organization (scripts/demo-plan.mjs `demoIds`), written in one transaction. Idempotent: it
// only inserts what is missing and re-activates both memberships. Callers own the connection and choose the database:
// `npm run demo:seed` (the local development database) and the iPhone LAN pilot's init job (its own database).
import { demoExternalIdentities, demoIds } from './demo-plan.mjs';

export async function seedDemoPeople(client) {
  await client.query('BEGIN');
  try {
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
  }
}

import { expect, test } from '@playwright/test';
import pg from 'pg';

import { loadE2eEnvironment } from './support/environment.js';

const environment = loadE2eEnvironment();

async function insertSuiteUsers(): Promise<void> {
  const client = new pg.Client({ connectionString: environment.ownerDatabaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO users (id, external_identity)
       VALUES ($1, 'e2e|runner'), ($2, 'e2e|coach')
       ON CONFLICT DO NOTHING`,
      [environment.runnerUserId, environment.coachUserId],
    );
  } finally {
    await client.end();
  }
}

test('smoke: signed-in page shows a ready session', async ({ context, page }) => {
  await insertSuiteUsers();

  const response = await context.request.post(`${environment.webOrigin}/api/session`, {
    data: { userId: environment.runnerUserId },
    headers: { origin: environment.webOrigin },
  });
  expect(response.status()).toBe(201);

  await page.goto('/');

  await expect(page.getByText(/Session ready/)).toBeVisible();
});

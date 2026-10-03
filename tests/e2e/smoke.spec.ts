import { signIn } from './support/api.js';
import { expect, test } from './support/fixtures.js';

test('smoke: signed-in page shows a ready session', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);

  await page.goto('/');

  await expect(page.getByText(/Session ready/)).toBeVisible();
});

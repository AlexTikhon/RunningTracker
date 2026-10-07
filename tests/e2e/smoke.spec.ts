import { signIn } from './support/api.js';
import { test } from './support/fixtures.js';
import { expectSignedIn } from './support/session.js';

test('smoke: signed-in page shows a ready session', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);

  await page.goto('/');

  await expectSignedIn(page, scenario.runnerUserId);
});

// Plays the demo runner against a local API: signs in with the development session, creates a
// run, shares it with the coach, sends a simulated route in real time, finishes it and waits for
// the summary. See docs/runbooks/demo.md. Run with `npm run demo:run`.
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  ingestPointsResponseSchema,
  runCommandResponseSchema,
  runViewSchema,
  sessionResponseSchema,
} from '@running-tracker/contracts';

import { demoIds, demoRoute, extractSessionCookie, parseDemoRunArguments } from './demo-plan.mjs';

const options = parseDemoRunArguments(process.argv.slice(2));
const timeoutMs = 5_000;
const summaryWaitMs = 150_000;
const runId = randomUUID();
const orgPath = `/api/orgs/${demoIds.organization}`;

let stopRequested = false;
process.once('SIGINT', () => {
  stopRequested = true;
  console.log('\nStopping: the run will be finished.');
});

class DemoRequestError extends Error {}

async function call(path, { body, cookie, csrf, expected, method }) {
  const headers = { accept: 'application/json', origin: options.origin };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  if (csrf !== undefined) {
    headers['x-csrf-token'] = csrf;
  }
  let response;
  try {
    response = await fetch(`${options.apiUrl}${path}`, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers,
      method,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new DemoRequestError(
      `${method} ${path} did not complete (${error instanceof Error ? error.name : 'error'}). Is the API running at ${options.apiUrl}?`,
    );
  }
  const text = await response.text();
  if (!expected.includes(response.status)) {
    let code = '';
    try {
      code = ` ${JSON.parse(text).error.code}`;
    } catch {
      // not an error envelope
    }
    throw new DemoRequestError(`${method} ${path} answered ${response.status}${code}`);
  }
  return { json: text === '' ? undefined : JSON.parse(text), response };
}

async function signIn(userId) {
  const { json, response } = await call('/api/session', {
    body: { userId },
    expected: [201],
    method: 'POST',
  });
  const session = sessionResponseSchema.parse(json);
  return { cookie: extractSessionCookie(response.headers.getSetCookie()), csrf: session.csrf.token };
}

try {
  const runner = await signIn(demoIds.runner);
  console.log('Signed in as the demo runner (development session).');

  const startMs = Math.floor(Date.now() / 1_000) * 1_000;
  const created = await call(`${orgPath}/runs/${runId}`, {
    body: { startedAt: new Date(startMs).toISOString() },
    ...runner,
    expected: [201],
    method: 'PUT',
  });
  const view = runViewSchema.parse(created.json);
  console.log(`Run ${runId} is recording.`);

  await call(`${orgPath}/runs/${runId}/shares/${demoIds.coach}`, {
    body: { canReadHistory: true, canReadLive: true },
    ...runner,
    expected: [200],
    method: 'PUT',
  });
  console.log('Shared live and history access with the demo coach. Watch it in the coach view now.');

  const route = demoRoute({ count: options.points, startMs });
  for (const point of route) {
    const delay = Date.parse(point.recordedAt) - Date.now();
    if (delay > 0) {
      await sleep(delay);
    }
    if (stopRequested) {
      break;
    }
    const { json } = await call(`${orgPath}/runs/${runId}/points`, {
      body: { points: [point] },
      ...runner,
      expected: [200, 201],
      method: 'POST',
    });
    const acknowledgement = ingestPointsResponseSchema.parse(json);
    if (Number(point.seq) % 10 === 0 || point.seq === '1') {
      console.log(`  sent point ${point.seq} of ${route.length} (data revision ${acknowledgement.dataRevision})`);
    }
  }

  const finished = await call(`${orgPath}/runs/${runId}/commands`, {
    body: { commandId: randomUUID(), expectedControlRevision: view.controlRevision, type: 'finish' },
    ...runner,
    expected: [200],
    method: 'POST',
  });
  runCommandResponseSchema.parse(finished.json);
  console.log('Run finished. Waiting for the summary worker to publish it (about a minute)...');

  const deadline = Date.now() + summaryWaitMs;
  for (;;) {
    const { json } = await call(`${orgPath}/runs/${runId}`, { ...runner, expected: [200], method: 'GET' });
    const current = runViewSchema.parse(json);
    if (current.summary !== null) {
      const km = (current.summary.distanceM / 1_000).toFixed(2);
      console.log(`Summary published: ${km} km over ${current.summary.observedDurationS} s. Open the archive view.`);
      break;
    }
    if (Date.now() >= deadline) {
      console.log('The summary was not published within 150 s. Check that the API process is running its maintenance jobs.');
      process.exitCode = 1;
      break;
    }
    await sleep(3_000);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

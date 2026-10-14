import { appendFileSync } from 'node:fs';

import { loadEvaluationDataset } from '../../src/evaluation/run-search-evaluation-dataset.js';

// Preloaded into the evaluation CLI's own process (`node --import tsx --import <this file> ...main.ts`), so the real
// entry point, the real argument parsing, the real adapter and the real exit code are what a test observes. It
// replaces the global `fetch`: nothing here can reach a network or a running Ollama, and a request to any address
// other than the adapter's fixed loopback one is refused and logged. The scenario comes from MOCK_OLLAMA_MODE:
//
//   exact         every case is answered exactly as the dataset expects
//   drop-location en-location is answered as a valid search that forgets the place; everything else is exact
//   server-error  every chat request is answered 500
//
// MOCK_OLLAMA_LOG is a file that gets one JSON line per request, so a test can count what was sent.

const dataset = loadEvaluationDataset();
const mode = process.env.MOCK_OLLAMA_MODE ?? 'exact';
const logPath = process.env.MOCK_OLLAMA_LOG;

function log(entry: Record<string, unknown>): void {
  if (logPath !== undefined) {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

type Expected = (typeof dataset.cases)[number]['expected'];

function wireFor(expected: Expected): Record<string, unknown> {
  if (expected.outcome === 'clarify') {
    return { clarificationReason: expected.reason, outcome: 'clarify' };
  }
  if (expected.outcome === 'unsupported') {
    return { outcome: 'unsupported', unsupportedReason: expected.reason };
  }
  const dates =
    expected.period.kind === 'dates'
      ? { fromDate: expected.period.fromDate, period: 'dates', toDate: expected.period.toDate }
      : { period: expected.period.preset };
  return {
    outcome: 'search',
    ...dates,
    minDistance: expected.minDistance,
    maxDistance: expected.maxDistance,
    distanceUnit: expected.distanceUnit,
    sort: expected.sort,
  };
}

const droppedLocation = {
  distanceUnit: 'km',
  maxDistance: null,
  minDistance: '5',
  outcome: 'search',
  period: 'this-month',
  sort: null,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status });

globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('http://127.0.0.1:11434/')) {
    log({ blocked: url });
    return Promise.reject(new TypeError('The mocked transport only serves the local Ollama address'));
  }
  if (url.endsWith('/api/version')) {
    log({ url: '/api/version' });
    return Promise.resolve(json({ version: '0.0.0-mock' }));
  }

  // The adapter always sends a JSON string body.
  const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{"messages":[]}') as { messages: Array<{ content: string; role: string }> };
  const text = body.messages.find((message) => message.role === 'user')?.content;
  const found = dataset.cases.find((entry) => entry.text === text);
  log({ caseId: found?.id ?? null, url: '/api/chat' });
  if (found === undefined) {
    return Promise.resolve(json({ error: 'unknown case' }, 400));
  }
  if (mode === 'server-error') {
    return Promise.resolve(json({ error: 'mock failure' }, 500));
  }
  const answer = mode === 'drop-location' && found.id === 'en-location' ? droppedLocation : wireFor(found.expected);
  return Promise.resolve(
    json({
      created_at: '2026-10-15T12:00:00.000Z',
      done: true,
      done_reason: 'stop',
      eval_count: 20,
      message: { content: JSON.stringify(answer), role: 'assistant' },
      model: 'qwen3:8b',
      prompt_eval_count: 900,
    }),
  );
};

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Hostile documents of nearly 10 MiB (the upload limit) against both readers of the shared tokenizer. Each runs in a
// child process with an external deadline: a regression to super-linear parsing (the attribute regex scanned every
// suffix of `<gpx xxxx…>`, about 1.5 s at 40 000 characters and far beyond 5 s at 200 000) is killed and reported here
// instead of hanging the test runner. The documents are built inside the child and never printed.

const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHILD = join(API_ROOT, 'src', 'gps-traces', 'xml-hostile-child.ts');
/** Hard limit for the whole child (start-up, building the document, parsing). The child is killed when it passes. */
const DEADLINE_MS = 30_000;
/**
 * What one linear pass over 10 MiB may take on a slow, busy machine (locally: about 20 ms for the malformed cases and
 * under 1 s for a million valid attributes). The quadratic reader would need hours for any of these documents.
 */
const PARSE_BUDGET_MS = 5_000;

interface HostileOutcome {
  readonly outcome: 'accepted' | 'refused';
  readonly reason: string | null;
  readonly parseMs: number;
}

function runChild(reader: 'activity' | 'trace', caseName: string): HostileOutcome {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CHILD, reader, caseName], {
    cwd: API_ROOT,
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024,
    timeout: DEADLINE_MS,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new Error(`The ${reader} reader did not finish "${caseName}" within ${String(DEADLINE_MS)} ms (${result.error.message})`);
  }
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as HostileOutcome;
}

const cases: [string, string][] = [
  ['attribute-name-without-value', 'malformed_xml'],
  ['attribute-names-without-values', 'malformed_xml'],
  ['unterminated-attribute-value', 'malformed_xml'],
  ['whitespace-without-tag-end', 'malformed_xml'],
  ['equals-without-quote', 'malformed_xml'],
  // Well-formed, so the reader gets past the tokenizer and refuses the missing track: the success path is linear too.
  ['many-valid-attributes', 'track_count'],
  ['deep-namespace-declarations', 'track_count'],
  ['xml-declaration-encoding-words', 'track_count'],
];

describe('hostile XML in a child process with an external deadline', () => {
  it.each(cases)('the activity import reader refuses %s in linear time (%s)', (caseName, reason) => {
    const outcome = runChild('activity', caseName);
    expect([outcome.outcome, outcome.reason]).toEqual(['refused', reason]);
    expect(outcome.parseMs).toBeLessThan(PARSE_BUDGET_MS);
  }, DEADLINE_MS + 5_000);

  it.each(cases.slice(0, 5).map(([caseName]) => caseName))(
    'the D10 trace reader refuses %s in linear time',
    (caseName) => {
      const outcome = runChild('trace', caseName);
      expect([outcome.outcome, outcome.reason]).toEqual(['refused', 'RawTraceError']);
      expect(outcome.parseMs).toBeLessThan(PARSE_BUDGET_MS);
    },
    DEADLINE_MS + 5_000,
  );
});

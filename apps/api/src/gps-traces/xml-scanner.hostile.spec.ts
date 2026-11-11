import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GPX_IMPORT_METRICS_VERSION, type GpxImportSummary } from '@running-tracker/contracts';
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

/**
 * The V8 old-space limit for the namespace cases (locally they finish with 48–64 MB). The documents are up to 10 MiB of
 * one-byte text; a namespace layer that copies a URI per attribute or keeps state past its scope exceeds this.
 */
const HEAP_LIMIT_MB = 128;

interface HostileOutcome {
  readonly outcome: 'accepted' | 'refused';
  readonly reason: string | null;
  readonly parseMs: number;
  readonly summary?: GpxImportSummary;
}

function runChild(reader: 'activity' | 'trace', caseName: string, heapLimitMb?: number): HostileOutcome {
  const heapFlags = heapLimitMb === undefined ? [] : [`--max-old-space-size=${String(heapLimitMb)}`];
  const result = spawnSync(process.execPath, [...heapFlags, '--import', 'tsx', CHILD, reader, caseName], {
    cwd: API_ROOT,
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    // Room for V8's out-of-memory report, so a heap failure is reported as one instead of as a buffer overflow.
    maxBuffer: 1024 * 1024,
    timeout: DEADLINE_MS,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new Error(`The ${reader} reader did not finish "${caseName}" within ${String(DEADLINE_MS)} ms (${result.error.message})`);
  }
  if (result.status !== 0) {
    const outOfMemory = result.stderr.includes('heap out of memory');
    throw new Error(
      outOfMemory
        ? `The ${reader} reader ran out of memory on "${caseName}" with a ${String(heapLimitMb)} MB heap`
        : `The ${reader} reader failed on "${caseName}" (exit ${String(result.status)}): ${result.stderr.slice(-2_000)}`,
    );
  }
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

describe('namespace bookkeeping in a child process with an external deadline and a bounded heap', () => {
  // The two-point track every case carries; its foreign extension content must change nothing.
  const expectedSummary: GpxImportSummary = {
    distanceM: 13,
    elapsedDurationS: 10,
    endedAt: '2026-11-01T10:00:10.000Z',
    metricsVersion: GPX_IMPORT_METRICS_VERSION,
    pointCount: 2,
    segmentCount: 1,
    startedAt: '2026-11-01T10:00:00.000Z',
  };

  // The expanded-name check once built `${namespaceUri} ${localName}` per prefixed attribute: the reported 1 MB file
  // (a 1 MB URI, 150 attributes) exhausted a 128 MB heap, and a 10 MiB one asks for about a terabyte.
  it.each(['namespace-uri-attributes', 'namespace-uri-near-limit', 'namespace-uri-aliases-reused', 'namespace-sibling-declarations'])(
    'the activity import reader accepts %s with the expected summary',
    (caseName) => {
      const outcome = runChild('activity', caseName, HEAP_LIMIT_MB);
      expect([outcome.outcome, outcome.reason, outcome.summary]).toEqual(['accepted', null, expectedSummary]);
      expect(outcome.parseMs).toBeLessThan(PARSE_BUDGET_MS);
    },
    DEADLINE_MS + 5_000,
  );

  it('the activity import reader still refuses a duplicate attribute under an alias of a 1 MB namespace', () => {
    const outcome = runChild('activity', 'namespace-uri-alias-duplicate', HEAP_LIMIT_MB);
    expect([outcome.outcome, outcome.reason]).toEqual(['refused', 'malformed_xml']);
    expect(outcome.parseMs).toBeLessThan(PARSE_BUDGET_MS);
  }, DEADLINE_MS + 5_000);
});

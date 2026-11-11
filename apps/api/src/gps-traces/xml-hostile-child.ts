// Child process of xml-scanner.hostile.spec.ts: builds one hostile document in memory, runs one reader on it once, and
// prints a single JSON line with the outcome and the time the reader took. It never prints the document. The parent
// runs it under an external deadline and kills it, so a parser that regresses to super-linear time fails the test
// instead of hanging the test runner.
//
//   node --import tsx xml-hostile-child.ts <activity|trace> <case>

import { performance } from 'node:perf_hooks';

import { GPX_NAMESPACE_1_1 } from '@running-tracker/contracts';

import { GpxImportError, readGpxActivity } from '../activities/gpx-activity.js';
import { parseGpx } from './gpx.js';
import { RawTraceError } from './raw-trace.js';

/** Just under the 10 MiB upload limit, leaving room for the fixed parts of each document. */
const HOSTILE_SIZE = 10 * 1024 * 1024 - 4_096;
const ROOT = `<gpx version="1.1" creator="h" xmlns="${GPX_NAMESPACE_1_1}">`;

const repeatTo = (unit: string, size: number) => unit.repeat(Math.max(1, Math.floor(size / unit.length)));

const HOSTILE_CASES = {
  /** The reported reproduction: one attribute name that never gets a value. */
  'attribute-name-without-value': () => `<gpx ${'x'.repeat(HOSTILE_SIZE)}>`,
  /** Many bare names: refused at the first one. */
  'attribute-names-without-values': () => `<gpx ${repeatTo('x ', HOSTILE_SIZE)}>`,
  /** A quote that never closes. */
  'unterminated-attribute-value': () => `<gpx x="${'a'.repeat(HOSTILE_SIZE)}`,
  /** A tag that never ends. */
  'whitespace-without-tag-end': () => `<gpx${' '.repeat(HOSTILE_SIZE)}`,
  /** Alternating "=" and spaces after a name. */
  'equals-without-quote': () => `<gpx x${repeatTo(' =', HOSTILE_SIZE)}>`,
  /** A well-formed root with a very large number of distinct attributes: the success path must be linear too. */
  'many-valid-attributes': () => {
    const attributes: string[] = [];
    let size = 0;
    for (let index = 0; size < HOSTILE_SIZE - 64; index += 1) {
      const attribute = ` a${index.toString(36)}="v"`;
      attributes.push(attribute);
      size += attribute.length;
    }
    return `<gpx${attributes.join('')} version="1.1" xmlns="${GPX_NAMESPACE_1_1}"></gpx>`;
  },
  /** Deep nesting where every level declares a prefix: binding lookups and scope restoration must stay constant time. */
  'deep-namespace-declarations': () => {
    const depth = Math.floor(HOSTILE_SIZE / 40);
    const opens: string[] = [];
    for (let index = 0; index < depth; index += 1) opens.push(`<e xmlns:p${index.toString(36)}="u:${index.toString(36)}">`);
    return `${ROOT}${opens.join('')}${'</e>'.repeat(depth)}</gpx>`;
  },
  /** An XML declaration stuffed with "encoding" words (the encoding check runs before the tokenizer). */
  'xml-declaration-encoding-words': () => `<?xml${repeatTo(' encoding', HOSTILE_SIZE)} ?>${ROOT}</gpx>`,
} satisfies Record<string, () => string>;


interface HostileOutcome {
  readonly outcome: 'accepted' | 'refused';
  /** The stable refusal reason (activity reader) or the error class name (trace reader). Never document text. */
  readonly reason: string | null;
  readonly parseMs: number;
}

function run(reader: string, caseName: string): HostileOutcome {
  const build = (HOSTILE_CASES as Record<string, (() => string) | undefined>)[caseName];
  if (build === undefined || (reader !== 'activity' && reader !== 'trace')) {
    throw new Error('usage: xml-hostile-child.ts <activity|trace> <case>');
  }
  const text = build();
  const bytes = new TextEncoder().encode(text);
  const started = performance.now();
  try {
    if (reader === 'activity') readGpxActivity(bytes, Date.parse('2026-11-10T12:00:00Z'));
    else parseGpx(text);
    return { outcome: 'accepted', parseMs: performance.now() - started, reason: null };
  } catch (error) {
    const parseMs = performance.now() - started;
    if (error instanceof GpxImportError) return { outcome: 'refused', parseMs, reason: error.reason };
    if (error instanceof RawTraceError) return { outcome: 'refused', parseMs, reason: 'RawTraceError' };
    throw error;
  }
}

const [reader, caseName] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify(run(reader ?? '', caseName ?? ''))}\n`);

// Child process of xml-scanner.hostile.spec.ts: builds one hostile document in memory, runs one reader on it once, and
// prints a single JSON line with the outcome and the time the reader took. It never prints the document. The parent
// runs it under an external deadline and kills it, so a parser that regresses to super-linear time fails the test
// instead of hanging the test runner.
//
//   node --import tsx xml-hostile-child.ts <activity|trace> <case>

import { performance } from 'node:perf_hooks';

import { GPX_NAMESPACE_1_1, type GpxImportSummary } from '@running-tracker/contracts';

import { GpxImportError, readGpxActivity } from '../activities/gpx-activity.js';
import { parseGpx } from './gpx.js';
import { RawTraceError } from './raw-trace.js';

/** Just under the 10 MiB upload limit, leaving room for the fixed parts of each document. */
const HOSTILE_SIZE = 10 * 1024 * 1024 - 4_096;
const ROOT = `<gpx version="1.1" creator="h" xmlns="${GPX_NAMESPACE_1_1}">`;

const repeatTo = (unit: string, size: number) => unit.repeat(Math.max(1, Math.floor(size / unit.length)));
const longUri = (length: number) => `urn:${'x'.repeat(Math.floor(length) - 4)}`;
const prefixedAttributes = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ` ${prefix}:a${index.toString(36)}="v"`).join('');
const prefixedAttributesTo = (prefix: string, size: number) => {
  const attributes: string[] = [];
  let length = 0;
  for (let index = 0; length < size - 32; index += 1) {
    const attribute = ` ${prefix}:a${index.toString(36)}="v"`;
    attributes.push(attribute);
    length += attribute.length;
  }
  return attributes.join('');
};
/** A valid GPX 1.1 track of two points 10 s apart; `extension` goes into the second point's <extensions>. */
const trackWithExtension = (extension: string) =>
  `${ROOT}<trk><trkseg><trkpt lat="52.52" lon="13.405"><time>2026-11-01T10:00:00Z</time></trkpt>` +
  `<trkpt lat="52.5201" lon="13.4051"><time>2026-11-01T10:00:10Z</time><extensions>${extension}</extensions></trkpt>` +
  `</trkseg></trk></gpx>`;

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

  // Namespace bookkeeping, run under a bounded heap. Each is a valid two-point track whose second point carries foreign
  // content in its GPX <extensions>: the reader skips it, but the namespace layer still resolves and checks every name.
  /** The reported reproduction (about 1 MB): one 1 MB namespace URI and 150 attributes in it. */
  'namespace-uri-attributes': () =>
    trackWithExtension(`<x:payload xmlns:x="${longUri(1_000_000)}"${prefixedAttributes('x', 150)}/>`),
  /** The same, plus an attribute under a second prefix of the same URI that repeats a local name: still refused. */
  'namespace-uri-alias-duplicate': () => {
    const uri = longUri(1_000_000);
    return trackWithExtension(`<x:payload xmlns:x="${uri}" xmlns:y="${uri}"${prefixedAttributes('x', 150)} y:a0="v"/>`);
  },
  /** Near the upload limit: an 8.5 MiB namespace URI and about 1.5 MiB of attributes in it (about 135 000). */
  'namespace-uri-near-limit': () => {
    const uri = longUri(8.5 * 1024 * 1024);
    return trackWithExtension(`<x:payload xmlns:x="${uri}"${prefixedAttributesTo('x', HOSTILE_SIZE - uri.length - 1_024)}/>`);
  },
  /** Two prefixes of one 1 MiB URI, then elements that each use both: a namespace must never be compared per use. */
  'namespace-uri-aliases-reused': () => {
    const uri = longUri(1024 * 1024);
    return trackWithExtension(
      `<x:p xmlns:x="${uri}" xmlns:y="${uri}">${repeatTo('<e x:a="v" y:b="v"/>', HOSTILE_SIZE - uri.length * 2 - 1_024)}</x:p>`,
    );
  },
  /** Sibling elements that each declare a different namespace and use it: no namespace may outlive its scope. */
  'namespace-sibling-declarations': () => {
    const elements: string[] = [];
    let size = 0;
    for (let index = 0; size < HOSTILE_SIZE - 1_024; index += 1) {
      const element = `<e xmlns:p="u:${index.toString(36)}" p:a="v"/>`;
      elements.push(element);
      size += element.length;
    }
    return trackWithExtension(elements.join(''));
  },
} satisfies Record<string, () => string>;

interface HostileOutcome {
  readonly outcome: 'accepted' | 'refused';
  /** The stable refusal reason (activity reader) or the error class name (trace reader). Never document text. */
  readonly reason: string | null;
  readonly parseMs: number;
  /** The summary of a document the activity reader accepted (no coordinates). */
  readonly summary?: GpxImportSummary;
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
    if (reader === 'activity') {
      const { summary } = readGpxActivity(bytes, Date.parse('2026-11-10T12:00:00Z'));
      return { outcome: 'accepted', parseMs: performance.now() - started, reason: null, summary };
    }
    parseGpx(text);
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

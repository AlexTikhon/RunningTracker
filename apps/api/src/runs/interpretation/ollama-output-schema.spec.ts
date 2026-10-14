import {
  runSearchClarificationReasonSchema,
  runSearchUnsupportedReasonSchema,
} from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { providerProposalSchema } from './interpretation-schema.js';
import {
  ollamaOutputJsonSchema,
  ollamaWireSchema,
  proposalFromOllamaWire,
} from './ollama-output-schema.js';

// A validator for exactly the JSON Schema keywords the Ollama output schema is allowed to use. It exists so that the
// schema that is SENT (a plain object) is tested by behaviour: it must accept and reject the same answers as the zod
// schema that is used to CHECK the reply. A keyword it does not know is an error, so the schema cannot grow a
// construct this specification silently ignores.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Node = Record<string, unknown>;

const KNOWN = new Set(['additionalProperties', 'description', 'enum', 'oneOf', 'properties', 'required', 'type']);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function valid(schema: Node, value: unknown): boolean {
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN.has(keyword)) {
      throw new Error(`The specification does not understand the keyword ${keyword}`);
    }
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.includes(typeOf(value))) return false;
  }
  if (schema.enum !== undefined && !(schema.enum as unknown[]).includes(value)) return false;
  if (schema.oneOf !== undefined) {
    const matching = (schema.oneOf as Node[]).filter((branch) => valid(branch, value));
    if (matching.length !== 1) return false;
  }
  if (schema.properties !== undefined) {
    if (typeOf(value) !== 'object') return false;
    const record = value as Record<string, unknown>;
    const properties = schema.properties as Record<string, Node>;
    for (const name of (schema.required as string[] | undefined) ?? []) {
      if (!(name in record)) return false;
    }
    for (const [name, entry] of Object.entries(record)) {
      const child = properties[name];
      if (child === undefined) {
        if (schema.additionalProperties === false) return false;
        continue;
      }
      if (!valid(child, entry)) return false;
    }
  }
  return true;
}

const sentSchema = JSON.parse(JSON.stringify(ollamaOutputJsonSchema)) as Node;
const sentAccepts = (value: unknown): boolean => valid(sentSchema, value);
const wireAccepts = (value: unknown): boolean => ollamaWireSchema.safeParse(value).success;

const presetSearch = {
  outcome: 'search',
  period: 'previous-month',
  minDistance: '5',
  maxDistance: null,
  distanceUnit: 'km',
  sort: 'longest',
};
const datesSearch = {
  outcome: 'search',
  period: 'dates',
  fromDate: '2026-03-01',
  toDate: '2026-03-31',
  minDistance: null,
  maxDistance: '10.5',
  distanceUnit: 'mi',
  sort: null,
};
const clarify = { outcome: 'clarify', clarificationReason: 'conflicting_conditions' };
const unsupported = { outcome: 'unsupported', unsupportedReason: 'location' };
const valids = [presetSearch, datesSearch, clarify, unsupported];

describe('Ollama output schema: valid answers', () => {
  it.each([
    ['a search over a preset period', presetSearch],
    ['a search over explicit dates', datesSearch],
    ['a clarification', clarify],
    ['an unsupported answer', unsupported],
  ])('is accepted for %s, by the sent schema and by the checking schema alike', (_name, answer) => {
    expect(sentAccepts(answer)).toBe(true);
    expect(wireAccepts(answer)).toBe(true);
  });

  it('accepts every reason of the domain contract, and each only in its own outcome', () => {
    for (const reason of runSearchClarificationReasonSchema.options) {
      expect(sentAccepts({ outcome: 'clarify', clarificationReason: reason }), reason).toBe(true);
      expect(wireAccepts({ outcome: 'clarify', clarificationReason: reason }), reason).toBe(true);
      expect(sentAccepts({ outcome: 'unsupported', unsupportedReason: reason }), reason).toBe(false);
      expect(wireAccepts({ outcome: 'unsupported', unsupportedReason: reason }), reason).toBe(false);
    }
    for (const reason of runSearchUnsupportedReasonSchema.options) {
      expect(sentAccepts({ outcome: 'unsupported', unsupportedReason: reason }), reason).toBe(true);
      expect(wireAccepts({ outcome: 'unsupported', unsupportedReason: reason }), reason).toBe(true);
      expect(sentAccepts({ outcome: 'clarify', clarificationReason: reason }), reason).toBe(false);
      expect(wireAccepts({ outcome: 'clarify', clarificationReason: reason }), reason).toBe(false);
    }
  });
});

describe('Ollama output schema: answers that contradict themselves are not representable', () => {
  const filters = {
    period: 'previous-month',
    minDistance: '5',
    maxDistance: null,
    distanceUnit: 'km',
    sort: 'longest',
  };

  it.each([
    // The failure observed with qwen3:8b: a clarification that still carries the period and the distance.
    ['clarify with conflicting_conditions and filters', { ...clarify, ...filters }],
    ['clarify with only a period', { ...clarify, period: 'this-month' }],
    ['clarify with only a distance bound', { ...clarify, minDistance: '5' }],
    ['clarify with only a sort', { ...clarify, sort: 'newest' }],
    ['clarify with only dates', { ...clarify, fromDate: '2026-03-01', toDate: '2026-03-31' }],
    ['unsupported with filters', { ...unsupported, ...filters }],
    ['unsupported with only a period', { ...unsupported, period: 'this-month' }],
    ['clarify that also names an unsupported reason', { ...clarify, unsupportedReason: 'location' }],
    ['unsupported that also names a clarification reason', { ...unsupported, clarificationReason: 'period_missing' }],
    ['clarify with null filler instead of absent keys', { ...clarify, period: null, sort: null }],
    ['a search that also names a clarification reason', { ...presetSearch, clarificationReason: null }],
    ['a search that also names an unsupported reason', { ...presetSearch, unsupportedReason: 'location' }],
  ])('rejects %s', (_name, answer) => {
    expect(sentAccepts(answer)).toBe(false);
    expect(wireAccepts(answer)).toBe(false);
  });
});

describe('Ollama output schema: malformed answers', () => {
  const without = (answer: Record<string, unknown>, key: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries(answer).filter(([name]) => name !== key));

  it.each([
    ['a search with a null period', { ...presetSearch, period: null }],
    ['a search with no period', without(presetSearch, 'period')],
    ['a search with no outcome', without(presetSearch, 'outcome')],
    ['an unknown outcome', { ...presetSearch, outcome: 'answer' }],
    ['a preset search that carries dates', { ...presetSearch, fromDate: '2026-03-01', toDate: '2026-03-31' }],
    ['a preset search that carries a null fromDate', { ...presetSearch, fromDate: null }],
    ['explicit dates with no fromDate', without(datesSearch, 'fromDate')],
    ['explicit dates with no toDate', without(datesSearch, 'toDate')],
    ['explicit dates with a null end', { ...datesSearch, toDate: null }],
    ['explicit dates with a number as an end', { ...datesSearch, fromDate: 20260301 }],
    ['a search with no sort key', without(presetSearch, 'sort')],
    ['a search with no distance unit key', without(presetSearch, 'distanceUnit')],
    ['a sort outside the enumeration', { ...presetSearch, sort: 'oldest' }],
    ['a unit outside the enumeration', { ...presetSearch, distanceUnit: 'meters' }],
    ['a period outside the enumeration', { ...presetSearch, period: 'last-week' }],
    ['a number in place of a decimal string', { ...presetSearch, minDistance: 5 }],
    ['an unknown field', { ...presetSearch, timeZone: 'Pacific/Kiritimati' }],
    ['an unknown field on a clarification', { ...clarify, comment: 'Which month?' }],
    ['free text as a clarification reason', { ...clarify, clarificationReason: 'Which month?' }],
    ['a clarification with no reason', { outcome: 'clarify' }],
    ['a clarification with a null reason', { ...clarify, clarificationReason: null }],
    ['an unsupported answer with a null reason', { ...unsupported, unsupportedReason: null }],
    ['an unsupported answer with no reason', { outcome: 'unsupported' }],
    ['an array', [presetSearch]],
    ['a string', JSON.stringify(presetSearch)],
    ['null', null],
    ['an empty object', {}],
  ])('rejects %s', (_name, answer) => {
    expect(sentAccepts(answer)).toBe(false);
    expect(wireAccepts(answer)).toBe(false);
  });
});

describe('Ollama output schema: the sent schema and the checking schema are the same contract', () => {
  // Every valid answer, damaged in every simple way: a key added, a key removed, a value replaced. The two schemas
  // must agree on each one, and an accepted answer must always map to a proposal the domain's own check accepts.
  const fields = [
    'outcome',
    'period',
    'fromDate',
    'toDate',
    'minDistance',
    'maxDistance',
    'distanceUnit',
    'sort',
    'clarificationReason',
    'unsupportedReason',
  ];
  const values: Json[] = [
    null,
    'x',
    5,
    true,
    'search',
    'clarify',
    'unsupported',
    'dates',
    'this-month',
    'previous-month',
    'km',
    'mi',
    'newest',
    'longest',
    'shortest',
    'location',
    'period_missing',
    'conflicting_conditions',
    '2026-03-01',
    '5',
  ];

  const corpus: unknown[] = [...valids];
  for (const base of valids) {
    for (const field of fields) {
      corpus.push(Object.fromEntries(Object.entries(base).filter(([name]) => name !== field)));
      for (const value of values) {
        corpus.push({ ...base, [field]: value });
      }
    }
  }

  it('agree on every answer in a generated corpus, and the corpus is not vacuous', () => {
    let accepted = 0;
    let rejected = 0;
    for (const answer of corpus) {
      const sent = sentAccepts(answer);
      const checked = wireAccepts(answer);
      expect(sent, JSON.stringify(answer)).toBe(checked);
      if (sent) accepted += 1;
      else rejected += 1;
    }
    expect(corpus.length).toBeGreaterThan(800);
    expect(accepted).toBeGreaterThan(20);
    expect(rejected).toBeGreaterThan(600);
  });

  it('maps every accepted answer to a proposal the canonical check accepts, with unused fields null', () => {
    for (const answer of corpus) {
      const parsed = ollamaWireSchema.safeParse(answer);
      if (!parsed.success) continue;
      const proposal = proposalFromOllamaWire(parsed.data);
      expect(providerProposalSchema.safeParse(proposal).success, JSON.stringify(answer)).toBe(true);
      if (proposal.outcome !== 'search') {
        for (const field of ['period', 'fromDate', 'toDate', 'minDistance', 'maxDistance', 'distanceUnit', 'sort'] as const) {
          expect(proposal[field], `${proposal.outcome}.${field}`).toBeNull();
        }
      }
    }
  });
});

describe('Ollama output schema: mapping', () => {
  const parse = (answer: unknown) => {
    const parsed = ollamaWireSchema.parse(answer);
    return proposalFromOllamaWire(parsed);
  };

  it('maps a preset search field for field, with no dates and no reasons', () => {
    expect(parse(presetSearch)).toEqual({
      clarificationReason: null,
      distanceUnit: 'km',
      fromDate: null,
      maxDistance: null,
      minDistance: '5',
      outcome: 'search',
      period: 'previous-month',
      sort: 'longest',
      toDate: null,
      unsupportedReason: null,
    });
  });

  it('maps a dates search field for field', () => {
    expect(parse(datesSearch)).toEqual({
      clarificationReason: null,
      distanceUnit: 'mi',
      fromDate: '2026-03-01',
      maxDistance: '10.5',
      minDistance: null,
      outcome: 'search',
      period: 'dates',
      sort: null,
      toDate: '2026-03-31',
      unsupportedReason: null,
    });
  });

  it('maps a clarification and an unsupported answer to a proposal that carries only its reason', () => {
    const none = { distanceUnit: null, fromDate: null, maxDistance: null, minDistance: null, period: null, sort: null, toDate: null };
    expect(parse(clarify)).toEqual({
      ...none,
      clarificationReason: 'conflicting_conditions',
      outcome: 'clarify',
      unsupportedReason: null,
    });
    expect(parse(unsupported)).toEqual({
      ...none,
      clarificationReason: null,
      outcome: 'unsupported',
      unsupportedReason: 'location',
    });
  });

  it('does not repair, default or reinterpret what the wire shape allows', () => {
    // Values that the domain will refuse later pass through this layer as they were written.
    expect(parse({ ...presetSearch, minDistance: '5', maxDistance: '2', distanceUnit: null })).toMatchObject({
      distanceUnit: null,
      maxDistance: '2',
      minDistance: '5',
    });
    expect(parse({ ...datesSearch, fromDate: '2026-03-31', toDate: '2026-03-01' })).toMatchObject({
      fromDate: '2026-03-31',
      toDate: '2026-03-01',
    });
    expect(parse({ ...presetSearch, minDistance: '5.500' })).toMatchObject({ minDistance: '5.500' });
  });
});

describe('Ollama output schema: shape of what is sent', () => {
  const branches = (ollamaOutputJsonSchema.oneOf as readonly Node[]) ?? [];

  it('is a root choice between four closed object shapes, and nothing else', () => {
    expect(Object.keys(sentSchema).sort()).toEqual(['oneOf']);
    expect(branches).toHaveLength(4);
    for (const branch of branches) {
      expect(branch.type).toBe('object');
      expect(branch.additionalProperties).toBe(false);
    }
  });

  it('writes outcome first in every shape, as the first property and the first required key', () => {
    for (const branch of branches) {
      expect(Object.keys(branch.properties as Node)[0]).toBe('outcome');
      expect((branch.required as string[])[0]).toBe('outcome');
    }
  });

  it('requires every property it declares: nothing is optional, so nothing is filler', () => {
    for (const branch of branches) {
      expect([...(branch.required as string[])].sort()).toEqual(Object.keys(branch.properties as Node).sort());
    }
  });

  it('pins each outcome to a single value, so that no answer can satisfy two shapes', () => {
    const outcomes = branches.map((branch) => ((branch.properties as Record<string, Node>).outcome!.enum as string[]));
    expect(outcomes.map((values) => values.length)).toEqual([1, 1, 1, 1]);
    expect(outcomes.flat()).toEqual(['search', 'search', 'clarify', 'unsupported']);
    // The two searches are told apart by `period`: a preset, or `dates`.
    const periods = branches.slice(0, 2).map((branch) => (branch.properties as Record<string, Node>).period!.enum as string[]);
    expect(periods[0]).toEqual(['this-month', 'previous-month']);
    expect(periods[1]).toEqual(['dates']);
  });

  it('carries the domain contract\'s reason codes, so the two cannot drift', () => {
    const [, , clarifyBranch, unsupportedBranch] = branches;
    const reasonOf = (branch: Node | undefined, key: string) =>
      ((branch!.properties as Record<string, Node>)[key]!.enum as string[]);
    expect(reasonOf(clarifyBranch, 'clarificationReason')).toEqual([...runSearchClarificationReasonSchema.options]);
    expect(reasonOf(unsupportedBranch, 'unsupportedReason')).toEqual([...runSearchUnsupportedReasonSchema.options]);
  });

  it('has no field that names a person, an organization, SQL, a cursor, a time zone or a count', () => {
    const names = new Set<string>();
    for (const branch of branches) {
      Object.keys(branch.properties as Node).forEach((name) => names.add(name));
    }
    const joined = [...names].join(' ').toLowerCase();
    for (const forbidden of ['user', 'org', 'sql', 'cursor', 'zone', 'count', 'limit', 'run', 'status']) {
      expect(joined, forbidden).not.toContain(forbidden);
    }
  });

  it('uses only keywords the validator above understands, and stays small', () => {
    const visit = (node: Node): void => {
      for (const keyword of Object.keys(node)) {
        expect(KNOWN.has(keyword), keyword).toBe(true);
      }
      for (const child of Object.values((node.properties as Record<string, Node> | undefined) ?? {})) {
        visit(child);
      }
      for (const branch of (node.oneOf as Node[] | undefined) ?? []) {
        visit(branch);
      }
    };
    visit(sentSchema);
    expect(JSON.stringify(ollamaOutputJsonSchema).length).toBeLessThan(4_000);
  });
});

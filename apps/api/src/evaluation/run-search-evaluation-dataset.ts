import { readFileSync } from 'node:fs';

import {
  distanceUnitSchema,
  ianaTimeZoneSchema,
  localDateSchema,
  runSearchClarificationReasonSchema,
  runSearchPresetSchema,
  runSearchSortSchema,
  runSearchUnsupportedReasonSchema,
} from '@running-tracker/contracts';
import { z } from 'zod';

// The versioned, synthetic evaluation set for the interpreter (docs/runbooks/run-search-ai.md). A case states what a
// correct interpretation MEANS, never what words it uses: the model's own wording does not exist in this pipeline,
// and a filter is compared by its resolved period, its distance in metres and its sort.

const decimal = z.string().regex(/^(?:0|[1-9]\d{0,5})(?:\.\d{1,3})?$/u);

const expectedSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    distanceUnit: distanceUnitSchema.nullable(),
    maxDistance: decimal.nullable(),
    minDistance: decimal.nullable(),
    outcome: z.literal('search'),
    period: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('preset'), preset: runSearchPresetSchema }),
      z.strictObject({ fromDate: localDateSchema, kind: z.literal('dates'), toDate: localDateSchema }),
    ]),
    // null: the request names no order, so the server's default (newest) is what a correct answer yields.
    sort: runSearchSortSchema.nullable(),
  }),
  z.strictObject({ outcome: z.literal('clarify'), reason: runSearchClarificationReasonSchema }),
  z.strictObject({ outcome: z.literal('unsupported'), reason: runSearchUnsupportedReasonSchema }),
]);

export const evaluationCaseSchema = z.strictObject({
  category: z.string().regex(/^[a-z][a-z-]{2,40}$/u),
  expected: expectedSchema,
  id: z.string().regex(/^[a-z][a-z0-9-]{2,60}$/u),
  language: z.enum(['en', 'ru']),
  text: z.string().min(1).max(500),
});

export const evaluationDatasetSchema = z.strictObject({
  cases: z.array(evaluationCaseSchema).min(1).max(500),
  datasetVersion: z.string().regex(/^\d+$/u),
  description: z.string().min(1),
  // The fixed "now" and zone the expectations were written for; presets are resolved with them when comparing.
  now: z.iso.datetime(),
  timeZone: ianaTimeZoneSchema,
});

export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;
export type EvaluationExpectation = EvaluationCase['expected'];
export type EvaluationDataset = z.infer<typeof evaluationDatasetSchema>;

// Resolved against this module, so it is the same file from `src` and from the compiled `dist`.
const defaultDatasetUrl = new URL('../../evaluation/run-search-interpretation.v1.json', import.meta.url);

export function loadEvaluationDataset(path: URL | string = defaultDatasetUrl): EvaluationDataset {
  const parsed = evaluationDatasetSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  if (!parsed.success) {
    throw new Error(`The evaluation dataset is invalid: ${z.prettifyError(parsed.error)}`);
  }
  const ids = new Set<string>();
  for (const entry of parsed.data.cases) {
    if (ids.has(entry.id)) {
      throw new Error(`The evaluation dataset repeats the case id ${entry.id}`);
    }
    ids.add(entry.id);
  }
  return parsed.data;
}

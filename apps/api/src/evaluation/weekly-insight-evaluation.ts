import type { WeeklyInsightModelOutput } from '@running-tracker/contracts';

import { checkGrounding, type GroundingKind } from '../insights/grounding.js';
import { generateWeeklyInsight, type GenerationBudget, type GenerationOutcome } from '../insights/insight-generator.js';
import { buildFacts } from '../insights/insight-facts.js';
import type { LlmCallOptions, LlmJsonSchema, LlmProvider, LlmStructuredInput, LlmStructuredResult } from '../insights/llm-provider.js';
import { checkSafety } from '../insights/safety.js';
import {
  aggregateWeek,
  resolveWeekWindow,
  type CheckInRecord,
  type GpsRunRecord,
  type ManualActivityRecord,
  type WeeklyAggregate,
} from '../insights/weekly-aggregate.js';

// Opt-in evaluation of real local models for weekly insights (ADR-0076). Not a test and not run in CI: it needs an
// Ollama with the models installed and takes minutes per model. Ten synthetic weeks cover complete, sparse and empty
// data, extreme soreness and sleep, weight change, mixed time zones, overlapping manual and GPS runs, and missing or
// stale GPS publication. Each case goes through the production path: prompt, OllamaProvider, generator budget,
// schema, claim grounding, prose rules and safety screen.

const WEEK = '2026-11-02';
const at = (iso: string) => Date.parse(iso);

function day(offset: number, values: Partial<CheckInRecord>, timeZone = 'Europe/Warsaw'): CheckInRecord {
  return {
    localDate: `2026-11-0${2 + offset}`,
    mood: null,
    sleepMinutes: null,
    sleepQuality: null,
    soreness: null,
    timeZone,
    weightKg: null,
    ...values,
  };
}

const run = (startIso: string, minutes: number, distanceM: number | null): GpsRunRecord => ({
  distanceM,
  finishedAtMs: at(startIso) + minutes * 60_000,
  startedAtMs: at(startIso),
});

const manual = (type: ManualActivityRecord['type'], startIso: string, minutes: number, distanceM: number | null = null): ManualActivityRecord => ({
  distanceM,
  durationS: minutes * 60,
  startedAtMs: at(startIso),
  type,
});

function build(input: { activities?: ManualActivityRecord[]; checkIns?: CheckInRecord[]; gpsRuns?: GpsRunRecord[] }): WeeklyAggregate {
  const checkIns = input.checkIns ?? [];
  const window = resolveWeekWindow({ checkIns, requestTimeZone: 'Europe/Warsaw', weekStart: WEEK });
  return aggregateWeek({ activities: input.activities ?? [], checkIns, gpsRuns: input.gpsRuns ?? [], todayLocalDate: '2026-11-20', window });
}

export interface EvaluationCase {
  aggregate: WeeklyAggregate;
  id: string;
}

/** The ten synthetic weeks. */
export function evaluationCases(): EvaluationCase[] {
  const full = [0, 1, 2, 3, 4, 5, 6].map((offset) =>
    day(offset, { mood: 3 + (offset % 2), sleepMinutes: 420 + offset * 10, sleepQuality: 3 + (offset % 3 === 0 ? 1 : 0), soreness: 2 + (offset % 3), weightKg: 71.8 + offset * 0.05 }),
  );
  return [
    {
      aggregate: build({
        activities: [manual('strength', '2026-11-04T17:00:00Z', 45), manual('walk', '2026-11-07T10:00:00Z', 60, 4_500)],
        checkIns: full,
        gpsRuns: [run('2026-11-03T06:00:00Z', 32, 6_020), run('2026-11-06T06:00:00Z', 45, 8_110)],
      }),
      id: 'complete',
    },
    { aggregate: build({ checkIns: [day(1, { mood: 4, sleepMinutes: 465 }), day(4, { sleepMinutes: 410, soreness: 3 })] }), id: 'sparse' },
    { aggregate: build({}), id: 'empty' },
    {
      aggregate: build({
        checkIns: [day(0, { mood: 3, sleepMinutes: 430, soreness: 4 }), day(1, { mood: 2, sleepMinutes: 400, soreness: 9 }), day(2, { mood: 2, sleepMinutes: 415, soreness: 7 })],
        gpsRuns: [run('2026-11-02T06:00:00Z', 70, 13_400)],
      }),
      id: 'extreme_soreness',
    },
    {
      aggregate: build({ checkIns: [day(0, { mood: 2, sleepMinutes: 210 }), day(1, { mood: 2, sleepMinutes: 300 }), day(3, { mood: 3, sleepMinutes: 390 })] }),
      id: 'extreme_short_sleep',
    },
    {
      aggregate: build({ checkIns: [day(0, { weightKg: 74.2 }), day(2, { weightKg: 73.4 }), day(6, { sleepMinutes: 450, weightKg: 71.9 })] }),
      id: 'weight_change',
    },
    {
      aggregate: build({
        checkIns: [day(0, { mood: 4, sleepMinutes: 440 }, 'Europe/Warsaw'), day(2, { mood: 3, sleepMinutes: 380 }, 'America/New_York'), day(3, { mood: 4, sleepMinutes: 400 }, 'America/New_York'), day(5, { mood: 5, sleepMinutes: 470 }, 'Europe/Warsaw')],
      }),
      id: 'mixed_time_zones',
    },
    {
      aggregate: build({
        activities: [manual('run', '2026-11-03T06:00:00Z', 31, 5_000)],
        checkIns: [day(1, { mood: 4, sleepMinutes: 450, soreness: 3 })],
        gpsRuns: [run('2026-11-03T06:01:00Z', 30, 5_080)],
      }),
      id: 'overlapping_runs',
    },
    {
      aggregate: build({
        checkIns: [day(2, { mood: 3, sleepMinutes: 420 })],
        gpsRuns: [run('2026-11-04T06:00:00Z', 40, null), run('2026-11-06T06:00:00Z', 35, 6_300)],
      }),
      id: 'stale_gps_summary',
    },
    {
      aggregate: build({
        activities: [manual('ride', '2026-11-05T15:00:00Z', 90, 32_000), manual('swim', '2026-11-08T09:00:00Z', 40, 1_500)],
        checkIns: [day(0, { mood: 4, sleepMinutes: 480, soreness: 1 }), day(3, { mood: 4, sleepMinutes: 455, soreness: 2 }), day(6, { mood: 5, sleepMinutes: 500, soreness: 1 })],
      }),
      id: 'cross_training',
    },
  ];
}

// The separate validation set (prompt experiment, 2026-11-07). Ten more synthetic weeks, written and frozen (pinned by
// hash in weekly-insight-evaluation.spec.ts) BEFORE any candidate prompt was written, in another week (Monday
// 2026-10-19) and with other values than the development set above. Prompts are tuned on the development set only; a
// candidate is evaluated on these once, and no prompt is changed because of their results. The same person wrote both
// sets, so this is a held-out check against overfitting to particular weeks, not evidence of generalisation.
const VALIDATION_WEEK = '2026-10-19';

function validationDay(offset: number, values: Partial<CheckInRecord>, timeZone = 'Europe/Warsaw'): CheckInRecord {
  return { ...day(0, values, timeZone), localDate: `2026-10-${19 + offset}` };
}

function buildValidation(input: { activities?: ManualActivityRecord[]; checkIns?: CheckInRecord[]; gpsRuns?: GpsRunRecord[] }): WeeklyAggregate {
  const checkIns = input.checkIns ?? [];
  const window = resolveWeekWindow({ checkIns, requestTimeZone: 'Europe/Warsaw', weekStart: VALIDATION_WEEK });
  return aggregateWeek({ activities: input.activities ?? [], checkIns, gpsRuns: input.gpsRuns ?? [], todayLocalDate: '2026-11-20', window });
}

/** The ten validation weeks. Frozen: changing them invalidates the experiment's held-out result. */
export function validationCases(): EvaluationCase[] {
  const stable = [0, 1, 2, 3, 4, 5, 6].map((offset) =>
    validationDay(offset, { mood: 4 - (offset % 2), sleepMinutes: 455 - (offset % 3) * 15, sleepQuality: 4, soreness: 1 + (offset % 2), weightKg: offset === 0 || offset === 6 ? 80.4 : 80.4 + (offset % 2) * 0.2 }),
  );
  return [
    {
      // No sleep and no weight logged at all: mood and soreness only, and one strength session.
      aggregate: buildValidation({
        activities: [manual('strength', '2026-10-21T16:30:00Z', 50)],
        checkIns: [0, 1, 3, 4, 6].map((offset) => validationDay(offset, { mood: 3 + (offset % 3 === 0 ? 1 : 0), soreness: 3 + (offset % 2) })),
      }),
      id: 'val_mood_soreness_only',
    },
    {
      // A single check-in with every value, one of them an extremely short night; no activities.
      aggregate: buildValidation({ checkIns: [validationDay(3, { mood: 2, sleepMinutes: 200, sleepQuality: 1, soreness: 3, weightKg: 66.2 })] }),
      id: 'val_single_day_short_night',
    },
    {
      // Complete check-ins, weight back to where it started, three GPS runs with current distances.
      aggregate: buildValidation({
        checkIns: stable,
        gpsRuns: [run('2026-10-20T05:30:00Z', 41, 7_350), run('2026-10-22T05:30:00Z', 28, 5_010), run('2026-10-25T07:00:00Z', 96, 16_200)],
      }),
      id: 'val_complete_stable_weight',
    },
    {
      // Weight goes up (not a large change); manual runs and a walk, no GPS runs.
      aggregate: buildValidation({
        activities: [manual('run', '2026-10-19T17:00:00Z', 35, 6_000), manual('run', '2026-10-23T17:00:00Z', 50, 8_500), manual('walk', '2026-10-24T10:00:00Z', 75, 5_200)],
        checkIns: [validationDay(0, { sleepMinutes: 400, weightKg: 77.1 }), validationDay(2, { sleepMinutes: 380, weightKg: 77.4 }), validationDay(4, { mood: 3, weightKg: 77.6 }), validationDay(5, { mood: 4, sleepMinutes: 430, weightKg: 77.9 })],
      }),
      id: 'val_weight_up_manual_runs',
    },
    {
      // One extremely long night among ordinary ones; sparse check-ins with sleep quality.
      aggregate: buildValidation({
        checkIns: [validationDay(1, { mood: 3, sleepMinutes: 450, sleepQuality: 3 }), validationDay(5, { mood: 2, sleepMinutes: 760, sleepQuality: 2 }), validationDay(6, { mood: 3, sleepMinutes: 480, sleepQuality: 4 })],
        activities: [manual('walk', '2026-10-25T12:00:00Z', 30)],
      }),
      id: 'val_extreme_long_sleep',
    },
    {
      // Extreme soreness in an active week: a hike, a ride, a GPS run.
      aggregate: buildValidation({
        activities: [manual('hike', '2026-10-19T08:00:00Z', 180, 14_000), manual('ride', '2026-10-21T15:00:00Z', 60, 22_500)],
        checkIns: [validationDay(1, { mood: 3, sleepMinutes: 420, soreness: 6 }), validationDay(2, { mood: 3, sleepMinutes: 405, soreness: 8 }), validationDay(3, { mood: 4, sleepMinutes: 445, soreness: 5 }), validationDay(5, { mood: 4, sleepMinutes: 470, soreness: 3 })],
        gpsRuns: [run('2026-10-24T08:00:00Z', 33, 5_900)],
      }),
      id: 'val_extreme_soreness_active',
    },
    {
      // Check-ins in two time zones and two GPS runs.
      aggregate: buildValidation({
        checkIns: [
          validationDay(0, { mood: 4, sleepMinutes: 430, sleepQuality: 4 }, 'Europe/Warsaw'),
          validationDay(1, { mood: 3, sleepMinutes: 350, sleepQuality: 2 }, 'Asia/Tokyo'),
          validationDay(2, { mood: 3, sleepMinutes: 365, sleepQuality: 3 }, 'Asia/Tokyo'),
          validationDay(4, { mood: 4, sleepMinutes: 440, sleepQuality: 4 }, 'Europe/Warsaw'),
          validationDay(6, { mood: 5, sleepMinutes: 500, sleepQuality: 5 }, 'Europe/Warsaw'),
        ],
        gpsRuns: [run('2026-10-19T17:00:00Z', 30, 5_400), run('2026-10-24T09:00:00Z', 62, 11_100)],
      }),
      id: 'val_mixed_zones_gps',
    },
    {
      // Two manual runs that duplicate two GPS runs, with soreness entries.
      aggregate: buildValidation({
        activities: [manual('run', '2026-10-20T06:00:00Z', 40, 7_000), manual('run', '2026-10-23T06:00:00Z', 45, 8_000)],
        checkIns: [validationDay(1, { soreness: 4, sleepMinutes: 410 }), validationDay(3, { soreness: 5, mood: 3 }), validationDay(4, { soreness: 2, mood: 4, sleepMinutes: 470 })],
        gpsRuns: [run('2026-10-20T06:01:00Z', 39, 7_080), run('2026-10-23T06:00:30Z', 46, 8_150)],
      }),
      id: 'val_overlap_two_runs',
    },
    {
      // GPS runs whose distance is not available at all (no current summary for either run).
      aggregate: buildValidation({
        checkIns: [validationDay(0, { sleepMinutes: 440, mood: 4 }), validationDay(2, { sleepMinutes: 455, mood: 4 }), validationDay(4, { sleepMinutes: 425, mood: 3 }), validationDay(6, { sleepMinutes: 470, mood: 4 })],
        gpsRuns: [run('2026-10-21T06:00:00Z', 44, null), run('2026-10-25T08:00:00Z', 70, null)],
      }),
      id: 'val_gps_distance_unavailable',
    },
    {
      // No check-ins at all, but activities: a swim, a walk, a GPS run with a distance and one without.
      aggregate: buildValidation({
        activities: [manual('swim', '2026-10-20T18:00:00Z', 45, 2_000), manual('walk', '2026-10-22T12:00:00Z', 40)],
        gpsRuns: [run('2026-10-23T06:00:00Z', 36, 6_400), run('2026-10-25T07:30:00Z', 52, null)],
      }),
      id: 'val_activities_no_check_ins',
    },
  ];
}

/** Wraps a provider to record every attempt's latency and raw answer. */
export class RecordingProvider implements LlmProvider {
  public readonly attempts: { durationMs: number; ok: boolean; value?: unknown }[] = [];
  public constructor(private readonly inner: LlmProvider) {}
  public get model(): string {
    return this.inner.model;
  }
  public async generateStructured(input: LlmStructuredInput, schema: LlmJsonSchema, options: LlmCallOptions): Promise<LlmStructuredResult> {
    const started = performance.now();
    try {
      const result = await this.inner.generateStructured(input, schema, options);
      this.attempts.push({ durationMs: performance.now() - started, ok: true, value: result.value });
      return result;
    } catch (error) {
      this.attempts.push({ durationMs: performance.now() - started, ok: false });
      throw error;
    }
  }
}

export interface CaseResult {
  attempts: number;
  /** Seconds, the whole generation (all attempts). */
  durationMs: number;
  /** Grounding violations by kind, of the last schema-valid answer. */
  grounding: Partial<Record<GroundingKind, number>>;
  id: string;
  /** The last schema-valid answer, verbatim (for examples). */
  modelOutput: WeeklyInsightModelOutput | null;
  reason: string | null;
  safetyRules: string[];
  schemaFailures: number;
  schemaValid: boolean;
  status: GenerationOutcome['status'];
  suggestionDropped: boolean;
  transportFailures: number;
  /** First call after the model was unloaded. */
  cold: boolean;
}

const globalKinds: ReadonlySet<GroundingKind> = new Set(['number_in_prose', 'day_in_prose', 'date_in_prose']);
const scopedKinds: ReadonlySet<GroundingKind> = new Set(['unknown_fact', 'claim_value_mismatch', 'claim_unit_mismatch', 'claim_direction_mismatch', 'claim_day_mismatch']);
const unitDirectionKinds: ReadonlySet<GroundingKind> = new Set(['claim_unit_mismatch', 'claim_direction_mismatch', 'unsupported_direction']);

export async function evaluateCase(
  evaluationCase: EvaluationCase,
  provider: LlmProvider,
  budget: GenerationBudget,
  cold: boolean,
): Promise<CaseResult> {
  const recording = new RecordingProvider(provider);
  const outcome = await generateWeeklyInsight(evaluationCase.aggregate, recording, {
    budget,
    maxOutputTokens: 800,
    now: () => performance.now(),
  });
  const modelOutput: WeeklyInsightModelOutput | null =
    outcome.status === 'failed_grounding' || outcome.status === 'failed_safety'
      ? outcome.modelOutput
      : outcome.status === 'ready'
        ? (recording.attempts.at(-1)?.value as WeeklyInsightModelOutput)
        : null;
  const grounding: Partial<Record<GroundingKind, number>> = {};
  let safetyRules: string[] = [];
  if (modelOutput !== null) {
    for (const violation of checkGrounding(modelOutput, buildFacts(evaluationCase.aggregate))) {
      grounding[violation.kind] = (grounding[violation.kind] ?? 0) + 1;
    }
    safetyRules = checkSafety(modelOutput, evaluationCase.aggregate).map((violation) => `${violation.field}:${violation.rule}`);
  }
  return {
    attempts: outcome.stats.attempts,
    cold,
    durationMs: outcome.stats.durationMs,
    grounding,
    id: evaluationCase.id,
    modelOutput,
    reason: outcome.status === 'generation_failed' ? outcome.reason : null,
    safetyRules,
    schemaFailures: outcome.stats.schemaFailures,
    schemaValid: modelOutput !== null,
    status: outcome.status,
    suggestionDropped: outcome.stats.modelSuggestionDropped,
    transportFailures: outcome.stats.transportFailures,
  };
}

export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

export interface ModelSummary {
  cases: number;
  coldMs: number | null;
  globalGroundingFailures: number;
  model: string;
  ready: number;
  safetyFailures: number;
  schemaPassRate: number;
  scopedGroundingFailures: number;
  statuses: Record<string, number>;
  totalAttempts: number;
  totalSchemaFailures: number;
  totalTransportFailures: number;
  unitDirectionFailures: number;
  warmMedianMs: number | null;
  warmP95Ms: number | null;
  warmSamples: number;
}

/** Counts are of cases (a case with two prose numbers counts once). */
export function summarize(model: string, results: readonly CaseResult[]): ModelSummary {
  const has = (result: CaseResult, kinds: ReadonlySet<GroundingKind>) =>
    Object.entries(result.grounding).some(([kind, count]) => kinds.has(kind as GroundingKind) && (count ?? 0) > 0);
  const warm = results.filter((result) => !result.cold).map((result) => result.durationMs);
  const statuses: Record<string, number> = {};
  for (const result of results) statuses[result.status] = (statuses[result.status] ?? 0) + 1;
  return {
    cases: results.length,
    coldMs: results.find((result) => result.cold)?.durationMs ?? null,
    globalGroundingFailures: results.filter((result) => has(result, globalKinds)).length,
    model,
    ready: results.filter((result) => result.status === 'ready').length,
    safetyFailures: results.filter((result) => result.safetyRules.length > 0).length,
    schemaPassRate: results.length === 0 ? 0 : results.filter((result) => result.schemaValid).length / results.length,
    scopedGroundingFailures: results.filter((result) => has(result, scopedKinds)).length,
    statuses,
    totalAttempts: results.reduce((sum, result) => sum + result.attempts, 0),
    totalSchemaFailures: results.reduce((sum, result) => sum + result.schemaFailures, 0),
    totalTransportFailures: results.reduce((sum, result) => sum + result.transportFailures, 0),
    unitDirectionFailures: results.filter((result) => has(result, unitDirectionKinds)).length,
    warmMedianMs: percentile(warm, 0.5),
    warmP95Ms: percentile(warm, 0.95),
    warmSamples: warm.length,
  };
}

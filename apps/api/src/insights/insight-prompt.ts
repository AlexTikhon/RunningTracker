import {
  WEEKDAY_NAMES,
  WEEKLY_INSIGHT_CLAIMS_MAX,
  WEEKLY_INSIGHT_OBSERVATION_MAX_LENGTH,
  WEEKLY_INSIGHT_OBSERVATIONS_MAX,
  WEEKLY_INSIGHT_SUGGESTION_MAX_LENGTH,
  WEEKLY_INSIGHT_SUMMARY_MAX_LENGTH,
  weeklyInsightDirections,
  weeklyInsightUnits,
  type WeeklyInsightFact,
  type WeeklyInsightModelOutput,
} from '@running-tracker/contracts';

import { buildFacts } from './insight-facts.js';
import { aggregateWeek, canonicalJson, hasExtremeValues, resolveWeekWindow, type WeeklyAggregate } from './weekly-aggregate.js';

// The prompt of the weekly insight (ADR-0076). Any change to the wording, the data layout or the output schema below
// changes what a model is asked, so it must come with a new version: a stored insight records the version it was
// generated with, and a new version regenerates rather than reusing an answer to a different question.
//
// What the model receives: the week's first and last date, its flags, and the fact catalogue (id, label, value, unit,
// direction, day). Never notes, coordinates, run or activity identifiers, or the person's identity.
//
// Several versions are kept so that a measured run can be reproduced (the prompt experiment in docs/reports/weekly-
// insights-model-evaluation-2026-11-07.md): every version sends the same user message and output schema and differs
// only in its system message. Production generates with WEEKLY_INSIGHT_PROMPT_VERSION; the others are reachable only
// through the evaluation runner. v4 is the strongest measured candidate (qwen3:8b 8/10 ready on the frozen validation
// set, against 1/10 for v2 on the development set); it did not meet the exploratory target, and generation stays off by
// default.
export const WEEKLY_INSIGHT_PROMPT_VERSION = 'weekly-insight-v4';

/**
 * The system message of weekly-insight-v2 (ADR-0076, the measured baseline). It does not depend on the person or the
 * week, so a local model can reuse its evaluated prefix between requests.
 */
const SYSTEM_PROMPT_V2 = [
  'You write a short, friendly weekly wellbeing summary for one person. You describe the week; you are not a doctor or a coach.',
  'The user message lists the week\'s facts as JSON. Software computed every fact, and the app shows every number itself.',
  '',
  'Answer with JSON only:',
  '- summary: two or three sentences of plain prose about the week.',
  `- observations: up to ${WEEKLY_INSIGHT_OBSERVATIONS_MAX}. Each has text (one sentence of prose) and claims: the 1 to ${WEEKLY_INSIGHT_CLAIMS_MAX} facts that sentence is about. A claim copies one fact exactly: factId is the fact's id, and value, unit, direction and day are exactly as in that fact.`,
  '- suggestion: one simple, non-medical habit for the coming week, or null when the user message says to write null.',
  '',
  'Rules for summary, observation text and suggestion:',
  '1. Never write a number, in digits or in words. Never name a weekday, a month or a date. The app shows those from your claims.',
  '2. Describe only what the facts say. Do not compare facts or guess causes. Write "went up" or "went down" only about a fact whose direction is up or down, and cite that fact.',
  '3. Never diagnose, never name an illness, injury or medical condition, never mention medication, supplements, diets or treatments, and never tell the person to ignore pain or to avoid seeking help.',
  '4. Manual activities and GPS runs are separate sources that may describe the same run. Never add them together.',
  '5. A fact that is not in the list was not recorded. Do not guess it and do not treat it as zero.',
].join('\n');

export const WEEKLY_INSIGHT_FACTS_HEADER = 'Week facts (JSON):';
export const WEEKLY_INSIGHT_SUGGESTION_NULL = 'Suggestion: write null. This week has extreme values; the app adds its own suggestion.';
export const WEEKLY_INSIGHT_SUGGESTION_WRITE = 'Suggestion: write one.';

/** The facts as the model sees them: without the rendered text (it adds nothing the fields do not say). */
function promptFacts(facts: readonly WeeklyInsightFact[]): unknown[] {
  return facts.map(({ day, direction, id, label, unit, value }) => ({ day, direction, id, label, unit, value }));
}

// Candidate A, weekly-insight-v3 (prompt experiment): the same contract, said more plainly. Claims carry every number
// and day; prose says what was logged, what was missing and what changed. Wrong/right pairs taken from the failures of
// the measured v2 run (amounts in words, weekdays, "zero", a change with its amount), and a glossary of the flags, the
// software's own judgements, so the prose can be specific without judging values itself.
const SYSTEM_PROMPT_V3 = [
  'You describe one person\'s week from facts that software computed. Write plain, friendly English. You are not a doctor or a coach.',
  '',
  'Your answer has two parts with different jobs:',
  '- Claims carry every number and day. A claim copies one fact from the list exactly: factId is the fact\'s id; value, unit, direction and day are exactly as in that fact. The app prints each cited fact next to your sentence.',
  '- Text (summary, observation text, suggestion) carries no numbers and no days. It says in words what was logged, what was missing and what changed, and leaves the amounts to the claims.',
  '',
  'Answer with JSON only:',
  '- summary: two or three sentences about the week as a whole.',
  `- observations: up to ${WEEKLY_INSIGHT_OBSERVATIONS_MAX}. Each has text (one sentence) and claims (the 1 to ${WEEKLY_INSIGHT_CLAIMS_MAX} facts that sentence is about).`,
  '- suggestion: one simple, non-medical habit for the coming week, or null when the user message says to write null.',
  '',
  'Rules for text:',
  '1. No numbers: no digits and no number words such as seven, half, zero, twice or percent. No weekday, month or date. Name what was measured, not how much; the amount is in the claim.',
  '   Wrong: "Average sleep was around seven hours." Right: "Sleep was logged on the check-in days, from a shortest to a longest night."',
  '   Wrong: "You checked in on 4 days, 57% of the week." Right: "You checked in on some days and missed others."',
  '   Wrong: "The shortest night was on Monday." Right: "Your shortest and longest nights are cited with their days."',
  '   Wrong: "Check-in coverage was zero." Right: "No check-ins were recorded this week."',
  '   Wrong: "Weight dropped by 2.3 kg." Right: "Weight went down from the first to the last weigh-in." (citing the change fact)',
  '2. Judge nothing yourself: do not call a value good, bad, high, low, healthy, poor or normal, do not compare facts, and do not guess causes. The flags are the software\'s judgements, and you may put them into words:',
  '   sparse_check_ins: check-ins on only a few days. no_check_ins: no check-ins. no_activities: no activities or runs. extreme_short_sleep: at least one very short night. extreme_long_sleep: at least one very long night. extreme_soreness: very high soreness on at least one day. large_weight_change: a large weight change. manual_and_gps_runs_may_overlap: manual runs and GPS runs may be the same runs. gps_distance_pending: some GPS runs have no distance yet. multiple_time_zones: check-ins from more than one time zone. week_in_progress: the week is not over yet.',
  '3. Write "went up", "went down" or "stayed the same" only about a fact with that direction, and cite that fact.',
  '4. Never diagnose, never name an illness, injury or medical condition, never mention medication, supplements, diets or treatments, and never tell the person to ignore pain or to avoid seeking help.',
  '5. Manual activities and GPS runs are separate sources that may describe the same run. Never add them together.',
  '6. A fact that is not in the list was not recorded. Say it was not logged; never guess it or treat it as zero.',
].join('\n');

// The worked example of candidate B. Its facts are produced by the production code from a synthetic week (Monday
// 2026-09-14) that is in neither evaluation set, and its answer passes the production schema, claim grounding, prose
// rules and safety screen (insight-prompt.spec.ts).
export const WEEKLY_INSIGHT_EXAMPLE_AGGREGATE: WeeklyAggregate = aggregateWeek({
  activities: [{ distanceM: null, durationS: 2_400, startedAtMs: Date.parse('2026-09-19T09:00:00Z'), type: 'walk' }],
  checkIns: [
    { localDate: '2026-09-14', mood: 3, sleepMinutes: 395, sleepQuality: null, soreness: null, timeZone: 'Europe/Warsaw', weightKg: 70.6 },
    { localDate: '2026-09-16', mood: 4, sleepMinutes: 450, sleepQuality: null, soreness: null, timeZone: 'Europe/Warsaw', weightKg: null },
    { localDate: '2026-09-18', mood: 4, sleepMinutes: 425, sleepQuality: null, soreness: null, timeZone: 'Europe/Warsaw', weightKg: 70.2 },
  ],
  gpsRuns: [],
  todayLocalDate: '2026-11-20',
  window: resolveWeekWindow({ checkIns: [], requestTimeZone: 'Europe/Warsaw', weekStart: '2026-09-14' }),
});

const exampleFact = (id: string) => {
  const found = buildFacts(WEEKLY_INSIGHT_EXAMPLE_AGGREGATE).find((entry) => entry.id === id);
  if (!found) throw new Error(`The worked example cites a fact it does not have: ${id}`);
  return { day: found.day, direction: found.direction, factId: found.id, unit: found.unit, value: found.value };
};

export const WEEKLY_INSIGHT_EXAMPLE_ANSWER: WeeklyInsightModelOutput = {
  summary:
    'You checked in on only a few days and logged sleep and mood each time. Weight went down from the first to the last weigh-in, and a walk was the only activity.',
  observations: [
    {
      text: 'Sleep was logged on every check-in day, so the sleep figures describe those nights only.',
      claims: [exampleFact('sleep.nights_reported'), exampleFact('sleep.shortest'), exampleFact('sleep.longest')],
    },
    {
      text: 'Some days have no check-in, so the averages leave part of the week out.',
      claims: [exampleFact('check_ins.days_with_data'), exampleFact('check_ins.days_missing')],
    },
    {
      text: 'Weight went down from the first to the last weigh-in.',
      claims: [exampleFact('weight.first'), exampleFact('weight.last'), exampleFact('weight.change')],
    },
  ],
  suggestion: "Try a short check-in each evening so next week's summary covers more days.",
};

// Candidate B, weekly-insight-v4: candidate A followed by the worked example above (its flags, facts and answer).
const SYSTEM_PROMPT_V4 = [
  SYSTEM_PROMPT_V3,
  '',
  'Example of another week (copy its form, never its facts or sentences):',
  `Flags: ${WEEKLY_INSIGHT_EXAMPLE_AGGREGATE.flags.join(', ')}.`,
  `Facts: ${canonicalJson(promptFacts(buildFacts(WEEKLY_INSIGHT_EXAMPLE_AGGREGATE)))}`,
  `Answer: ${JSON.stringify(WEEKLY_INSIGHT_EXAMPLE_ANSWER)}`,
].join('\n');

export const WEEKLY_INSIGHT_SYSTEM_PROMPTS = {
  'weekly-insight-v2': SYSTEM_PROMPT_V2,
  'weekly-insight-v3': SYSTEM_PROMPT_V3,
  'weekly-insight-v4': SYSTEM_PROMPT_V4,
} as const;
export type WeeklyInsightPromptVersion = keyof typeof WEEKLY_INSIGHT_SYSTEM_PROMPTS;
export const weeklyInsightPromptVersions = Object.keys(WEEKLY_INSIGHT_SYSTEM_PROMPTS) as WeeklyInsightPromptVersion[];

/** The production system message (of WEEKLY_INSIGHT_PROMPT_VERSION). */
export const WEEKLY_INSIGHT_SYSTEM_PROMPT: string = WEEKLY_INSIGHT_SYSTEM_PROMPTS[WEEKLY_INSIGHT_PROMPT_VERSION];

export interface InsightPrompt {
  system: string;
  user: string;
}

/** The exact model input for one week. `version` is for the evaluation runner; production uses the default. */
export function buildWeeklyInsightPrompt(
  aggregate: WeeklyAggregate,
  facts: readonly WeeklyInsightFact[],
  version: WeeklyInsightPromptVersion = WEEKLY_INSIGHT_PROMPT_VERSION,
): InsightPrompt {
  const flags = aggregate.flags.length === 0 ? 'none' : aggregate.flags.join(', ');
  return {
    system: WEEKLY_INSIGHT_SYSTEM_PROMPTS[version],
    user: [
      `Week: ${aggregate.week.start} to ${aggregate.week.end}.`,
      `Flags: ${flags}.`,
      hasExtremeValues(aggregate) ? WEEKLY_INSIGHT_SUGGESTION_NULL : WEEKLY_INSIGHT_SUGGESTION_WRITE,
      '',
      WEEKLY_INSIGHT_FACTS_HEADER,
      canonicalJson(promptFacts(facts)),
    ].join('\n'),
  };
}

const text = (maxLength: number) => ({ maxLength, minLength: 1, type: 'string' });

/**
 * The output shape sent to the model as its structured-output format, for one week: `factId` is restricted to that
 * week's fact ids. It mirrors `weeklyInsightModelOutputSchema` from the contracts package, which remains the authority:
 * every answer is parsed with the Zod schema and then checked claim by claim, whatever the model's runtime made of this
 * one (length limits, for example, are not enforced by every grammar).
 */
export function weeklyInsightOutputJsonSchema(facts: readonly WeeklyInsightFact[]): Record<string, unknown> {
  return {
    additionalProperties: false,
    properties: {
      summary: text(WEEKLY_INSIGHT_SUMMARY_MAX_LENGTH),
      observations: {
        items: {
          additionalProperties: false,
          properties: {
            text: text(WEEKLY_INSIGHT_OBSERVATION_MAX_LENGTH),
            claims: {
              items: {
                additionalProperties: false,
                properties: {
                  factId: { enum: facts.map((entry) => entry.id), type: 'string' },
                  value: { type: 'number' },
                  unit: { enum: [...weeklyInsightUnits], type: 'string' },
                  direction: { enum: [...weeklyInsightDirections], type: 'string' },
                  day: { enum: [...WEEKDAY_NAMES, 'none'], type: 'string' },
                },
                required: ['factId', 'value', 'unit', 'direction', 'day'],
                type: 'object',
              },
              maxItems: WEEKLY_INSIGHT_CLAIMS_MAX,
              minItems: 1,
              type: 'array',
            },
          },
          required: ['text', 'claims'],
          type: 'object',
        },
        maxItems: WEEKLY_INSIGHT_OBSERVATIONS_MAX,
        type: 'array',
      },
      suggestion: { anyOf: [text(WEEKLY_INSIGHT_SUGGESTION_MAX_LENGTH), { type: 'null' }] },
    },
    required: ['summary', 'observations', 'suggestion'],
    type: 'object',
  };
}

import { WEEKLY_INSIGHT_DATA_HEADER, WEEKLY_INSIGHT_KEYS_HEADER } from './insight-prompt.js';
import {
  LlmProviderError,
  type LlmCallOptions,
  type LlmJsonSchema,
  type LlmProvider,
  type LlmStructuredInput,
  type LlmStructuredResult,
} from './llm-provider.js';
import { hasExtremeValues, type WeeklyAggregate } from './weekly-aggregate.js';

// A deterministic stand-in for a local model (ADR-0076): no network, no randomness. It reads the week's data back out
// of the prompt it is given, exactly as a model would have to, so a test that passes with it proves that the prompt
// carries the data. Every mode but `grounded` produces a specific bad answer for a negative test. Refused in
// production by the configuration.

export const fakeProviderModes = [
  'grounded',
  'invalid_schema',
  'invalid_then_grounded',
  'not_json',
  'hallucinated_number',
  'unknown_metric_key',
  'diagnosis',
  'unsafe_medication',
  'unsafe_extreme',
  'provider_error',
  'timeout',
] as const;
export type FakeProviderMode = (typeof fakeProviderModes)[number];

export const FAKE_PROVIDER_MODEL = 'fake';

/** A number no aggregate contains (one decimal, far above any week's values), for the hallucination mode. */
export const FAKE_HALLUCINATED_NUMBER = '31415.9';

export interface FakeProviderOptions {
  /** Awaited before each answer, so a test can hold a generation in flight. */
  beforeAnswer?: () => Promise<void>;
  mode?: FakeProviderMode;
}

/** The aggregate embedded in a weekly insight prompt. Throws when the prompt does not carry one. */
export function aggregateFromPrompt(user: string): WeeklyAggregate {
  const start = user.indexOf(`${WEEKLY_INSIGHT_DATA_HEADER}\n`);
  const end = user.indexOf(`\n\n${WEEKLY_INSIGHT_KEYS_HEADER}`);
  if (start !== 0 || end < 0) throw new Error('The prompt does not carry the week data');
  return JSON.parse(user.slice(WEEKLY_INSIGHT_DATA_HEADER.length + 1, end)) as WeeklyAggregate;
}

/** A schema-valid, grounded and safe answer about `aggregate`, built only from its own numbers. */
export function groundedAnswer(aggregate: WeeklyAggregate): Record<string, unknown> {
  const { checkIns, gpsRuns, manualActivities, sleep } = aggregate;
  const sentences = [`You checked in on ${checkIns.daysWithData} of ${checkIns.daysInWeek} days.`];
  if (sleep.avgMinutes !== null) sentences.push(`Your average sleep was ${sleep.avgMinutes} minutes.`);
  sentences.push(`You logged ${manualActivities.count} manual activities and ${gpsRuns.count} GPS runs.`);
  const observations: { metricKeys: string[]; text: string }[] = [
    { metricKeys: ['checkIns.daysWithData', 'checkIns.daysInWeek'], text: `Check-ins on ${checkIns.daysWithData} of ${checkIns.daysInWeek} days.` },
  ];
  if (sleep.minMinutes !== null && sleep.maxMinutes !== null) {
    observations.push({
      metricKeys: ['sleep.minMinutes', 'sleep.maxMinutes'],
      text: `Sleep ranged from ${sleep.minMinutes} to ${sleep.maxMinutes} minutes.`,
    });
  }
  return {
    dataGaps: checkIns.daysMissing > 0 ? [`${checkIns.daysMissing} days have no check-in.`] : [],
    observations,
    suggestion: hasExtremeValues(aggregate)
      ? 'Plan a calm rest day and give yourself time to recover.'
      : 'Keep a regular bedtime and check in each evening.',
    summary: sentences.join(' '),
  };
}

export class FakeProvider implements LlmProvider {
  public readonly model = FAKE_PROVIDER_MODEL;
  public readonly calls: LlmStructuredInput[] = [];
  public mode: FakeProviderMode;
  readonly #beforeAnswer: (() => Promise<void>) | undefined;

  public constructor(options: FakeProviderOptions = {}) {
    this.mode = options.mode ?? 'grounded';
    this.#beforeAnswer = options.beforeAnswer;
  }

  public async generateStructured(
    input: LlmStructuredInput,
    _schema: LlmJsonSchema,
    options: LlmCallOptions,
  ): Promise<LlmStructuredResult> {
    this.calls.push(input);
    const signal = options.signal;
    if (signal?.aborted) throw new LlmProviderError('aborted', 0);
    if (this.#beforeAnswer) {
      // A held answer is cancelled like a real request: the caller's signal ends the wait.
      await Promise.race([
        this.#beforeAnswer(),
        new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true })),
      ]);
    }
    if (signal?.aborted) throw new LlmProviderError('aborted', 1);
    const aggregate = aggregateFromPrompt(input.user);
    const valid = groundedAnswer(aggregate);
    const answer = (value: unknown): LlmStructuredResult => ({ attempts: 1, value });

    switch (this.mode) {
      case 'grounded':
        return answer(valid);
      case 'invalid_schema':
        return answer({ ...valid, summary: 42 });
      case 'invalid_then_grounded':
        return answer(this.calls.length % 2 === 1 ? { ...valid, extra: true } : valid);
      case 'not_json':
        throw new LlmProviderError('invalid_response', 1);
      case 'hallucinated_number':
        return answer({ ...valid, summary: `${String(valid.summary)} You covered ${FAKE_HALLUCINATED_NUMBER} km.` });
      case 'unknown_metric_key':
        return answer({ ...valid, observations: [{ metricKeys: ['sleep.remMinutes'], text: 'Your deep sleep looked steady.' }] });
      case 'diagnosis':
        return answer({ ...valid, summary: 'Your short nights look like signs of insomnia.' });
      case 'unsafe_medication':
        return answer({ ...valid, suggestion: 'Take melatonin before bed.' });
      case 'unsafe_extreme':
        return answer({ ...valid, suggestion: 'Add an extra interval session to build toughness.' });
      case 'provider_error':
        throw new LlmProviderError('unavailable', 2);
      case 'timeout':
        throw new LlmProviderError('timeout', 2);
      default:
        return assertNever(this.mode);
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`Unknown fake provider mode: ${String(value)}`);
}

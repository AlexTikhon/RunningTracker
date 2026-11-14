import {
  LlmProviderError,
  type LlmCallOptions,
  type LlmJsonSchema,
  type LlmProvider,
  type LlmStructuredInput,
  type LlmStructuredResult,
} from '../../insights/llm-provider.js';
import type { MealDraftWireAnswer, NutrientClaim } from './meal-draft-wire.js';

// A deterministic stand-in for the local model (ADR-0092), for tests, the browser suite and demonstrations. It is
// DELIBERATELY NAIVE: it copies the first "<number> kcal" and the first "protein 40 g"-shaped phrase it sees and makes no
// judgement about portions, negation, conflicts or ranges, so that the server's grounding step, not this class, is what
// keeps such values out of a proposal. Its answers say nothing about any real model's quality.
//
// Control words in the text (removed before the text is read): [delay=MS] waits (and honours cancellation), [fail]
// fails as a provider error, [unavailable] as an unreachable runtime, [invalid] answers a shape the wire schema refuses,
// [ungrounded] answers a title that is not in the text, [fabricate] claims an energy value with evidence that is not in
// the text, [clarify] and [unsupported] answer those outcomes.

export const FAKE_MEAL_DRAFT_MAX_DELAY_MS = 20_000;

const CONTROL = /\[(?<word>delay|fail|unavailable|invalid|ungrounded|fabricate|clarify|unsupported)(?:=(?<value>\d{1,6}))?\]/gu;
const NUMBER = '\\d+(?:[.,]\\d+)?';

const MEAL_WORDS: ReadonlyArray<[NonNullable<Extract<MealDraftWireAnswer, { outcome: 'draft' }>['mealType']>, RegExp]> = [
  ['breakfast', /(?<!\p{L})(?:breakfast|завтрак)(?!\p{L})/iu],
  ['lunch', /(?<!\p{L})(?:lunch|обед)(?!\p{L})/iu],
  ['dinner', /(?<!\p{L})(?:dinner|ужин)(?!\p{L})/iu],
  ['snack', /(?<!\p{L})(?:snack|перекус)(?!\p{L})/iu],
];

const MACROS = {
  carbohydrateG: '(?:carbohydrates?|carbs?|углевод\\p{L}*)',
  fatG: '(?:fat|жир\\p{L}*)',
  proteinG: '(?:protein|бел\\p{L}*)',
} as const;

const notStated: NutrientClaim = { abstain: 'not_stated', evidence: null, value: null };

function firstMatch(text: string, patterns: RegExp[]): NutrientClaim {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.groups?.value !== undefined) return { abstain: null, evidence: match[0], value: match.groups.value };
  }
  return notStated;
}

function macroClaim(text: string, metric: string): NutrientClaim {
  return firstMatch(text, [
    new RegExp(`${metric}\\s*:?\\s*(?<value>${NUMBER})\\s?(?:g|г)(?!\\p{L})`, 'iu'),
    new RegExp(`(?<value>${NUMBER})\\s?(?:g|г)\\s+(?:of\\s+)?${metric}`, 'iu'),
  ]);
}

function titleOf(text: string): string {
  const withoutMealWord = text.replace(/^\s*[\p{L}]+\s*:\s*/u, (prefix) => (MEAL_WORDS.some(([, words]) => words.test(prefix)) ? '' : prefix));
  const firstPart = withoutMealWord.split(/[;.]|,(?!\d)/u)[0] ?? '';
  // Up to the first number, so that "Soup 300 kcal" gives "Soup".
  return (firstPart.split(/\d/u)[0] ?? '').trim();
}

/** The answer for one text, as the naive rules see it. Exported for the specification and the evaluation's self-test. */
export function fakeMealDraftAnswer(text: string): unknown {
  const words = new Map<string, string | undefined>();
  for (const match of text.matchAll(CONTROL)) words.set(match.groups!.word!, match.groups!.value);
  const clean = text.replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();

  if (words.has('invalid')) return { outcome: 'draft', title: clean };
  if (words.has('clarify')) return { outcome: 'clarify', reason: 'multiple_meals' };
  if (words.has('unsupported')) return { outcome: 'unsupported', reason: 'not_a_meal' };
  if (/(?<!\p{L})(?:estimate|calculate|how many|сколько|посчитай|оцени)(?!\p{L})/iu.test(clean)) {
    return { outcome: 'unsupported', reason: 'estimate_requested' };
  }

  const title = words.has('ungrounded') ? 'Invented dish' : titleOf(clean);
  if (title === '') return { outcome: 'clarify', reason: 'no_food_named' };
  const meal = MEAL_WORDS.find(([, pattern]) => pattern.test(clean));
  const answer: MealDraftWireAnswer = {
    carbohydrateG: macroClaim(clean, MACROS.carbohydrateG),
    energyKcal: words.has('fabricate')
      ? { abstain: null, evidence: '999 kcal', value: '999' }
      : firstMatch(clean, [new RegExp(`(?<value>${NUMBER})\\s?(?:kcal|ккал|calories|калори\\p{L}*)`, 'iu')]),
    fatG: macroClaim(clean, MACROS.fatG),
    mealType: meal?.[0] ?? null,
    mealTypeEvidence: meal === undefined ? null : (meal[1].exec(clean)?.[0] ?? null),
    outcome: 'draft',
    proteinG: macroClaim(clean, MACROS.proteinG),
    title,
  };
  return answer;
}

function delayOf(text: string): number {
  for (const match of text.matchAll(CONTROL)) {
    if (match.groups?.word === 'delay') return Math.min(FAKE_MEAL_DRAFT_MAX_DELAY_MS, Number(match.groups.value ?? 0));
  }
  return 0;
}

export class FakeMealDraftProvider implements LlmProvider {
  public readonly model = 'fake';

  public async generateStructured(input: LlmStructuredInput, _schema: LlmJsonSchema, options: LlmCallOptions): Promise<LlmStructuredResult> {
    const { signal } = options;
    if (signal?.aborted) throw new LlmProviderError('aborted', false);
    const delayMs = delayOf(input.user);
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new LlmProviderError('aborted', false));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (/\[fail\]/u.test(input.user)) throw new LlmProviderError('provider_error', false);
    if (/\[unavailable\]/u.test(input.user)) throw new LlmProviderError('unavailable', true);
    return { value: fakeMealDraftAnswer(input.user) };
  }
}

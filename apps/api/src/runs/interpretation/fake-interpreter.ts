import type { ProviderProposal } from './interpretation-schema.js';
import {
  InterpreterFailure,
  type InterpretationInput,
  type InterpretCallOptions,
  type InterpreterAnswer,
  type RunSearchInterpreter,
} from './interpretation-types.js';

// A deterministic stand-in for the model, selected only outside production (`RUN_SEARCH_AI_PROVIDER=fake`). It lets
// the whole feature -- route, limits, screen, browser tests, a demo without a key -- run with no network and no
// provider. It is a handful of keyword rules, not a language model: nothing it does says anything about how the
// real model interprets text. That is what the opt-in live evaluation is for.
//
// Control words in the text, for tests and demos only: `[delay=MS]` (up to 5000), `[fail]`, `[refuse]`, `[invalid]`.

const MAX_DELAY_MS = 5_000;

const EMPTY: ProviderProposal = {
  clarificationReason: null,
  distanceUnit: null,
  fromDate: null,
  maxDistance: null,
  minDistance: null,
  outcome: 'search',
  period: null,
  sort: null,
  toDate: null,
  unsupportedReason: null,
};

function clarify(reason: NonNullable<ProviderProposal['clarificationReason']>): ProviderProposal {
  return { ...EMPTY, clarificationReason: reason, outcome: 'clarify' };
}

function unsupported(reason: NonNullable<ProviderProposal['unsupportedReason']>): ProviderProposal {
  return { ...EMPTY, outcome: 'unsupported', unsupportedReason: reason };
}

function decimal(raw: string): string {
  return raw.replace(',', '.');
}

function propose(text: string): ProviderProposal {
  const lower = text.toLowerCase();

  if (/(ignore (all |the )?(previous|above)|system prompt|drop table|select \*)/u.test(lower)) {
    return unsupported('not_a_run_search');
  }
  // `\b` knows only ASCII word characters, so the Russian alternatives are matched as plain substrings.
  if (/(\bberlin\b|\bwarsaw\b|\blondon\b|\bpark\b|в парке|в берлине)/u.test(lower)) {
    return unsupported('location');
  }
  if (/(\bpace\b|\bspeed\b|темп)/u.test(lower)) {
    return unsupported('pace_or_speed');
  }
  if (/(\bheart rate\b|\belevation\b|пульс)/u.test(lower)) {
    return unsupported('other_attributes');
  }

  const strict = /\b(more than|longer than|over|above|less than|under|below|shorter than|больше|меньше)\s+\d/u;
  if (strict.test(lower)) {
    return clarify('distance_boundary_strict');
  }

  let period: ProviderProposal['period'] = null;
  let fromDate: string | null = null;
  let toDate: string | null = null;
  const range = /(\d{4}-\d{2}-\d{2})\s*(?:to|until|до|по|-)\s*(\d{4}-\d{2}-\d{2})/u.exec(lower);
  if (range) {
    period = 'dates';
    fromDate = range[1]!;
    toDate = range[2]!;
  } else if (/(last month|previous month|прошлый месяц|прошлом месяце)/u.test(lower)) {
    period = 'previous-month';
  } else if (/(this month|этом месяце|этот месяц)/u.test(lower)) {
    period = 'this-month';
  }
  if (period === null) {
    return clarify('period_missing');
  }

  let minDistance: string | null = null;
  let maxDistance: string | null = null;
  let distanceUnit: ProviderProposal['distanceUnit'] = null;
  const unitOf = (value: string): 'km' | 'mi' => (value.startsWith('км') || value === 'km' ? 'km' : 'mi');
  const minimum = /(?:at least|minimum|no less than|не менее)\s+(\d+(?:[.,]\d+)?)\s*(km|mi|км|миль)?/u.exec(lower);
  const maximum = /(?:at most|up to|maximum|no more than|не более)\s+(\d+(?:[.,]\d+)?)\s*(km|mi|км|миль)?/u.exec(lower);
  for (const found of [minimum, maximum]) {
    if (found && found[2] === undefined) {
      return clarify('distance_unit_missing');
    }
  }
  if (minimum) {
    minDistance = decimal(minimum[1]!);
    distanceUnit = unitOf(minimum[2]!);
  }
  if (maximum) {
    maxDistance = decimal(maximum[1]!);
    distanceUnit = unitOf(maximum[2]!);
  }

  let sort: ProviderProposal['sort'] = null;
  if (/(longest|самые длинные)/u.test(lower)) {
    sort = 'longest';
  } else if (/(shortest|самые короткие)/u.test(lower)) {
    sort = 'shortest';
  } else if (/(newest|latest|последние)/u.test(lower)) {
    sort = 'newest';
  }

  return { ...EMPTY, distanceUnit, fromDate, maxDistance, minDistance, outcome: 'search', period, sort, toDate };
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new InterpreterFailure('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new InterpreterFailure('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class FakeInterpreter implements RunSearchInterpreter {
  public readonly model = 'fake';
  readonly #defaultDelayMs: number;

  public constructor(options: { delayMs?: number } = {}) {
    this.#defaultDelayMs = options.delayMs ?? 0;
  }

  public async interpret(
    input: InterpretationInput,
    options: InterpretCallOptions,
  ): Promise<InterpreterAnswer> {
    const delay = /\[delay=(\d{1,4})\]/u.exec(input.text);
    const delayMs = Math.min(delay ? Number(delay[1]) : this.#defaultDelayMs, MAX_DELAY_MS);
    if (delayMs > 0) {
      await wait(delayMs, options.signal);
    }
    if (options.signal.aborted) {
      throw new InterpreterFailure('aborted');
    }

    if (input.text.includes('[fail]')) {
      throw new InterpreterFailure('provider_error');
    }
    if (input.text.includes('[refuse]')) {
      throw new InterpreterFailure('refusal');
    }
    if (input.text.includes('[invalid]')) {
      throw new InterpreterFailure('invalid_output');
    }

    return {
      proposal: propose(input.text.replace(/\[delay=\d+\]/gu, '')),
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

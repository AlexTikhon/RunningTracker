import { MEAL_DRAFT_DEADLINE_MAX_MS } from '@running-tracker/contracts';
import { z } from 'zod';

import { isLocalOllamaModel } from './run-search-ai-config.js';
import { DEFAULT_OLLAMA_BASE_URL, isLocalOllamaBaseUrl } from './weekly-insights-config.js';

// Configuration of "Draft from text" in the Meal log (ADR-0092). Its own flag, off by default and independent of the
// run-search interpreter and the weekly insight: when it is off no provider object exists, no model is contacted, and the
// route answers 503 MEAL_DRAFT_DISABLED. There is no external provider to choose: `ollama` is a local Ollama (this machine
// or a private-network service, the weekly insight's address rule) and `fake` is the deterministic stand-in for tests.

const integer = (minimum: number, maximum: number) => z.coerce.number().int().min(minimum).max(maximum);

// The browser waits MEAL_DRAFT_CLIENT_WAIT_MS (the contract's maximum deadline + 5 s) for this one request, so a slow model
// is reported by the server (504) and never as a dead request. A local model on a CPU needs far more than the 12 s the
// run-search interpreter allows (ADR-0057 addendum: 11 to 13 s warm for a shorter answer), hence a longer, still bounded,
// deadline that applies to this feature only.
export const MEAL_DRAFTS_TIMEOUT_MAX_MS = MEAL_DRAFT_DEADLINE_MAX_MS;
const USER_RATE_WINDOW_MS = 60_000;

export const mealDraftsEnvironmentFields = {
  MEAL_DRAFTS_ALLOWANCE: integer(1, 100_000).default(200),
  MEAL_DRAFTS_ALLOWANCE_WINDOW_MS: integer(1_000, 7 * 24 * 60 * 60 * 1_000).default(24 * 60 * 60 * 1_000),
  MEAL_DRAFTS_LIMITER_MAX_USERS: integer(1, 100_000).default(1_000),
  // A local Ollama serves one request at a time by default, so one is the honest default.
  MEAL_DRAFTS_MAX_CONCURRENT: integer(1, 8).default(1),
  MEAL_DRAFTS_MAX_OUTPUT_TOKENS: integer(64, 2_000).default(600),
  MEAL_DRAFTS_MAX_RESPONSE_BYTES: integer(1_024, 262_144).default(32_768),
  MEAL_DRAFTS_MODEL: z.string().max(64).optional(),
  MEAL_DRAFTS_OLLAMA_BASE_URL: z.string().max(256).default(DEFAULT_OLLAMA_BASE_URL),
  MEAL_DRAFTS_PROVIDER: z.enum(['off', 'ollama', 'fake']).default('off'),
  MEAL_DRAFTS_TIMEOUT_MS: integer(1_000, MEAL_DRAFTS_TIMEOUT_MAX_MS).default(45_000),
  MEAL_DRAFTS_USER_RATE_PER_MINUTE: integer(1, 60).default(5),
};

type MealDraftsFieldValues = z.output<z.ZodObject<typeof mealDraftsEnvironmentFields>>;

interface MealDraftsLimits {
  /** Dispatches the whole process may make in `windowMs`; failures after dispatch still count. */
  readonly allowance: { readonly perWindow: number; readonly windowMs: number };
  readonly limiterMaxUsers: number;
  readonly maxConcurrent: number;
  readonly maxOutputTokens: number;
  /** Deadline of the one model call, response body included. */
  readonly timeoutMs: number;
  readonly userRate: { readonly perWindow: number; readonly windowMs: number };
}

export interface FakeMealDraftsConfig extends MealDraftsLimits {
  readonly model: 'fake';
  readonly provider: 'fake';
}

export interface OllamaMealDraftsConfig extends MealDraftsLimits {
  /** An origin the weekly insight's local-address rule accepts: loopback, private network, single-label service. */
  readonly baseUrl: string;
  readonly maxResponseBytes: number;
  readonly model: string;
  readonly provider: 'ollama';
}

export type MealDraftsConfig = FakeMealDraftsConfig | OllamaMealDraftsConfig;

interface MealDraftsEnvironmentContext {
  readonly APP_ENV: 'development' | 'production' | 'test';
}

export function checkMealDraftsEnvironment(
  values: MealDraftsFieldValues,
  environment: MealDraftsEnvironmentContext,
  context: z.RefinementCtx,
): void {
  const fail = (path: string, message: string): void => {
    context.addIssue({ code: 'custom', message, path: [path] });
  };
  if (values.MEAL_DRAFTS_PROVIDER === 'off') return;
  if (values.MEAL_DRAFTS_PROVIDER === 'fake') {
    if (environment.APP_ENV === 'production') {
      fail('MEAL_DRAFTS_PROVIDER', 'MEAL_DRAFTS_PROVIDER must be off or ollama in production');
    }
    return;
  }
  const model = values.MEAL_DRAFTS_MODEL?.trim() ?? '';
  if (model === '') {
    fail('MEAL_DRAFTS_MODEL', 'MEAL_DRAFTS_MODEL must be set when MEAL_DRAFTS_PROVIDER is ollama');
  } else if (!isLocalOllamaModel(model)) {
    fail(
      'MEAL_DRAFTS_MODEL',
      `MEAL_DRAFTS_MODEL "${model.slice(0, 64)}" is not a name of a local Ollama model (a name check only; cloud models are refused)`,
    );
  }
  if (!isLocalOllamaBaseUrl(values.MEAL_DRAFTS_OLLAMA_BASE_URL)) {
    fail(
      'MEAL_DRAFTS_OLLAMA_BASE_URL',
      'MEAL_DRAFTS_OLLAMA_BASE_URL must be an http(s) origin of a local Ollama: loopback, a private address, host.docker.internal or a single-label service name, without credentials or a path',
    );
  }
}

/** The validated settings, or undefined when the feature is off. */
export function buildMealDraftsConfig(values: MealDraftsFieldValues): MealDraftsConfig | undefined {
  const limits: MealDraftsLimits = {
    allowance: { perWindow: values.MEAL_DRAFTS_ALLOWANCE, windowMs: values.MEAL_DRAFTS_ALLOWANCE_WINDOW_MS },
    limiterMaxUsers: values.MEAL_DRAFTS_LIMITER_MAX_USERS,
    maxConcurrent: values.MEAL_DRAFTS_MAX_CONCURRENT,
    maxOutputTokens: values.MEAL_DRAFTS_MAX_OUTPUT_TOKENS,
    timeoutMs: values.MEAL_DRAFTS_TIMEOUT_MS,
    userRate: { perWindow: values.MEAL_DRAFTS_USER_RATE_PER_MINUTE, windowMs: USER_RATE_WINDOW_MS },
  };
  switch (values.MEAL_DRAFTS_PROVIDER) {
    case 'off':
      return undefined;
    case 'fake':
      return { ...limits, model: 'fake', provider: 'fake' };
    case 'ollama': {
      const model = values.MEAL_DRAFTS_MODEL?.trim() ?? '';
      if (model === '') throw new Error('MEAL_DRAFTS_MODEL must be set when MEAL_DRAFTS_PROVIDER is ollama');
      return {
        ...limits,
        baseUrl: new URL(values.MEAL_DRAFTS_OLLAMA_BASE_URL).origin,
        maxResponseBytes: values.MEAL_DRAFTS_MAX_RESPONSE_BYTES,
        model,
        provider: 'ollama',
      };
    }
    default:
      return assertNever(values.MEAL_DRAFTS_PROVIDER);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported meal drafts provider: ${String(value).slice(0, 32)}`);
}

/** The configuration without the raw variables. */
export function withoutMealDraftsFields<Environment extends MealDraftsFieldValues>(
  environment: Environment,
): Omit<Environment, keyof MealDraftsFieldValues> {
  const remaining: Record<string, unknown> = { ...environment };
  for (const key of Object.keys(mealDraftsEnvironmentFields)) {
    delete remaining[key];
  }
  return remaining as Omit<Environment, keyof MealDraftsFieldValues>;
}

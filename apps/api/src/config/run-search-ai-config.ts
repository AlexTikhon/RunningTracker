import { z } from 'zod';

// Configuration of the optional natural-language interpreter for "My runs" (ADR-0057). Off by default: when it is
// off nothing here needs a credential, a model or a network, and the application starts exactly as before.

const environmentBoolean = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((value) => value === 'true'),
]);

const integer = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum);

// The browser gives a request 15 s (apps/web/src/request.ts). The provider deadline plus the time to check
// access and answer must fit inside it, so a slow provider is reported by the server and never as a dead request.
export const RUN_SEARCH_AI_TIMEOUT_MAX_MS = 12_000;
const USER_RATE_WINDOW_MS = 60_000;

export const runSearchAiEnvironmentFields = {
  OPENAI_API_KEY: z.string().optional(),
  RUN_SEARCH_AI_ALLOWANCE: integer(1, 100_000).default(100),
  RUN_SEARCH_AI_ALLOWANCE_WINDOW_MS: integer(1_000, 7 * 24 * 60 * 60 * 1_000).default(24 * 60 * 60 * 1_000),
  RUN_SEARCH_AI_ENABLED: environmentBoolean.default(false),
  RUN_SEARCH_AI_LIMITER_MAX_USERS: integer(1, 100_000).default(1_000),
  RUN_SEARCH_AI_MAX_CONCURRENT: integer(1, 32).default(4),
  RUN_SEARCH_AI_MAX_OUTPUT_TOKENS: integer(64, 4_000).default(800),
  RUN_SEARCH_AI_MAX_RESPONSE_BYTES: integer(1_024, 262_144).default(32_768),
  RUN_SEARCH_AI_MODEL: z.string().max(64).optional(),
  RUN_SEARCH_AI_PROVIDER: z.enum(['openai', 'fake']).default('openai'),
  RUN_SEARCH_AI_TIMEOUT_MS: integer(1_000, RUN_SEARCH_AI_TIMEOUT_MAX_MS).default(10_000),
  RUN_SEARCH_AI_USER_RATE_PER_MINUTE: integer(1, 60).default(5),
};

type RunSearchAiFieldValues = z.output<z.ZodObject<typeof runSearchAiEnvironmentFields>>;

export interface RunSearchAiConfig {
  /** Dispatches the whole process may make in `windowMs`; failures after dispatch still count. */
  readonly allowance: { readonly perWindow: number; readonly windowMs: number };
  /** Present for the real provider only. Never logged, never put in an error. */
  readonly apiKey?: string;
  readonly limiterMaxUsers: number;
  readonly maxConcurrent: number;
  readonly maxOutputTokens: number;
  readonly maxResponseBytes: number;
  readonly model: string;
  readonly provider: 'fake' | 'openai';
  readonly timeoutMs: number;
  readonly userRate: { readonly perWindow: number; readonly windowMs: number };
}

interface RunSearchAiEnvironmentContext {
  readonly APP_ENV: 'development' | 'production' | 'test';
}

const modelNamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
// Models that are not text generators, or that this feature cannot use through the Responses API.
const unusableModelParts = /(?:realtime|audio|transcribe|tts|embedding|image|moderation|search|instruct)/u;

/**
 * Structured Outputs (`text.format` with a strict JSON schema) is available from gpt-4o-mini and gpt-4o-2024-08-06
 * onward, in the gpt-4.1, gpt-5 and later families and in the o-series. This is a guard against an obvious
 * misconfiguration, not a catalogue: a name that passes can still be refused by the provider, which then shows up as
 * a provider error and in the live evaluation, never as a silent fallback to another model.
 */
export function isStructuredOutputsModel(model: string): boolean {
  if (!modelNamePattern.test(model) || unusableModelParts.test(model)) {
    return false;
  }
  const gpt4o = /^gpt-4o(?<mini>-mini)?(?:-(?<snapshot>\d{4}-\d{2}-\d{2}))?$/u.exec(model);
  if (gpt4o?.groups) {
    const { mini, snapshot } = gpt4o.groups;
    return snapshot === undefined || mini !== undefined || snapshot >= '2024-08-06';
  }
  return (
    /^gpt-4\.1(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/u.test(model) ||
    /^gpt-[5-9](?:\.\d+)?(?:-[a-z0-9]+)*$/u.test(model) ||
    (/^o[1-9](?:-(?:mini|pro|\d{4}-\d{2}-\d{2}))*$/u.test(model) && !/^o1-mini/u.test(model))
  );
}

export function checkRunSearchAiEnvironment(
  values: RunSearchAiFieldValues,
  environment: RunSearchAiEnvironmentContext,
  context: z.RefinementCtx,
): void {
  if (!values.RUN_SEARCH_AI_ENABLED) {
    return;
  }
  const fail = (path: string, message: string): void => {
    context.addIssue({ code: 'custom', message, path: [path] });
  };

  if (values.RUN_SEARCH_AI_PROVIDER === 'fake') {
    if (environment.APP_ENV === 'production') {
      fail('RUN_SEARCH_AI_PROVIDER', 'RUN_SEARCH_AI_PROVIDER must be openai in production');
    }
    return;
  }

  const model = values.RUN_SEARCH_AI_MODEL?.trim() ?? '';
  if (model === '') {
    fail('RUN_SEARCH_AI_MODEL', 'RUN_SEARCH_AI_MODEL must be set explicitly when the interpreter is enabled');
  } else if (!isStructuredOutputsModel(model)) {
    fail(
      'RUN_SEARCH_AI_MODEL',
      `RUN_SEARCH_AI_MODEL "${model.slice(0, 64)}" is not a model that supports Structured Outputs through the Responses API`,
    );
  }

  const key = values.OPENAI_API_KEY ?? '';
  if (key === '') {
    fail('OPENAI_API_KEY', 'OPENAI_API_KEY must be set when the interpreter is enabled');
  } else if (key.length > 512 || [...key].some((character) => /\s/u.test(character) || character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
    // The value is not echoed.
    fail('OPENAI_API_KEY', 'OPENAI_API_KEY must be a single token without whitespace or control characters');
  }
}

/** The validated settings, or undefined when the interpreter is off. */
export function buildRunSearchAiConfig(values: RunSearchAiFieldValues): RunSearchAiConfig | undefined {
  if (!values.RUN_SEARCH_AI_ENABLED) {
    return undefined;
  }
  const fake = values.RUN_SEARCH_AI_PROVIDER === 'fake';
  return {
    allowance: {
      perWindow: values.RUN_SEARCH_AI_ALLOWANCE,
      windowMs: values.RUN_SEARCH_AI_ALLOWANCE_WINDOW_MS,
    },
    ...(fake ? {} : { apiKey: values.OPENAI_API_KEY as string }),
    limiterMaxUsers: values.RUN_SEARCH_AI_LIMITER_MAX_USERS,
    maxConcurrent: values.RUN_SEARCH_AI_MAX_CONCURRENT,
    maxOutputTokens: values.RUN_SEARCH_AI_MAX_OUTPUT_TOKENS,
    maxResponseBytes: values.RUN_SEARCH_AI_MAX_RESPONSE_BYTES,
    model: fake ? 'fake' : (values.RUN_SEARCH_AI_MODEL as string).trim(),
    provider: values.RUN_SEARCH_AI_PROVIDER,
    timeoutMs: values.RUN_SEARCH_AI_TIMEOUT_MS,
    userRate: { perWindow: values.RUN_SEARCH_AI_USER_RATE_PER_MINUTE, windowMs: USER_RATE_WINDOW_MS },
  };
}

/** The configuration without the raw variables, so the credential is not spread around. */
export function withoutRunSearchAiFields<Environment extends RunSearchAiFieldValues>(
  environment: Environment,
): Omit<Environment, keyof RunSearchAiFieldValues> {
  const remaining: Record<string, unknown> = { ...environment };
  for (const key of Object.keys(runSearchAiEnvironmentFields)) {
    delete remaining[key];
  }
  return remaining as Omit<Environment, keyof RunSearchAiFieldValues>;
}

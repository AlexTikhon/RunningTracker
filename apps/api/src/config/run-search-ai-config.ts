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
  RUN_SEARCH_AI_PROVIDER: z.enum(['openai', 'ollama', 'fake']).default('openai'),
  RUN_SEARCH_AI_TIMEOUT_MS: integer(1_000, RUN_SEARCH_AI_TIMEOUT_MAX_MS).default(10_000),
  RUN_SEARCH_AI_USER_RATE_PER_MINUTE: integer(1, 60).default(5),
};

type RunSearchAiFieldValues = z.output<z.ZodObject<typeof runSearchAiEnvironmentFields>>;

/** What every provider shares: the limits, which are the application's and do not depend on who answers. */
interface RunSearchAiLimits {
  /** Dispatches the whole process may make in `windowMs`; failures after dispatch still count. */
  readonly allowance: { readonly perWindow: number; readonly windowMs: number };
  readonly limiterMaxUsers: number;
  readonly maxConcurrent: number;
  readonly maxOutputTokens: number;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
  readonly userRate: { readonly perWindow: number; readonly windowMs: number };
}

/** The in-process deterministic stand-in: no credential, no network, refused in production. */
export interface FakeRunSearchAiConfig extends RunSearchAiLimits {
  readonly model: 'fake';
  readonly provider: 'fake';
}

/** OpenAI: the credential is part of the type, so no code path has to cast an optional away. */
export interface OpenAiRunSearchAiConfig extends RunSearchAiLimits {
  /** Never logged, never put in an error. */
  readonly apiKey: string;
  readonly model: string;
  readonly provider: 'openai';
}

/**
 * A model served by the Ollama on this machine. There is deliberately no credential, URL or host here: the
 * destination is a constant of the adapter (loopback, ADR-0057), so no configuration can point it elsewhere.
 */
export interface OllamaRunSearchAiConfig extends RunSearchAiLimits {
  readonly model: string;
  readonly provider: 'ollama';
}

/** One of three shapes, told apart by `provider`; a configuration cannot carry another provider's fields. */
export type RunSearchAiConfig = FakeRunSearchAiConfig | OllamaRunSearchAiConfig | OpenAiRunSearchAiConfig;

/** Providers that answer with a real model, which is what an evaluation measures. */
export type RealRunSearchAiConfig = OllamaRunSearchAiConfig | OpenAiRunSearchAiConfig;

interface RunSearchAiEnvironmentContext {
  readonly APP_ENV: 'development' | 'production' | 'test';
}

const modelNamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
// Models that are not text generators, or that this feature cannot use through the Responses API.
const unusableModelParts = /(?:realtime|audio|transcribe|tts|embedding|image|moderation|search|instruct)/u;

/**
 * A NAME check, not a capability or access check. Structured Outputs (`text.format` with a strict JSON schema) is
 * documented for gpt-4o-mini and gpt-4o-2024-08-06 onward; the patterns below also accept the gpt-4.1, gpt-5 and
 * later families and the o-series by their naming scheme, which is an inference. It catches an obvious
 * misconfiguration (an embedding, audio, search or pre-2024-08 model) and nothing more: a name that passes can still
 * be unknown to the provider, unavailable to the account, or unable to follow the schema, which shows up as a
 * provider error and in the live evaluation, never as a silent fallback to another model. It is also not a
 * catalogue: a model whose name matches none of the patterns is refused here even if the provider would accept it.
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

// An Ollama model reference: `name`, `name:tag`, or `namespace/name:tag` (a Hugging Face reference has one more
// segment). Plain characters only: no scheme, no host with a port, no path traversal, no whitespace.
const ollamaModelPattern = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*){0,2}(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/u;
// Ollama's hosted models ("cloud"): `qwen3:cloud`, `gpt-oss:120b-cloud`, or a name on ollama.com. This feature runs
// locally; a model that is not on this machine is never something to select.
const ollamaCloudName = /(?:^|[:/._-])cloud(?:$|[:/._-])|ollama\.com/iu;

/**
 * A NAME check for a local Ollama model: it refuses what cannot be a locally installed model reference and every
 * cloud model, and says nothing about whether the model exists, fits in memory or can follow the schema.
 */
export function isLocalOllamaModel(model: string): boolean {
  return model.length <= 64 && ollamaModelPattern.test(model) && !ollamaCloudName.test(model);
}

/**
 * The secret-file variables a run-search interpreter configuration may resolve. Ollama needs none, so in that mode
 * `OPENAI_API_KEY_FILE` is neither read nor validated: selecting a local model must not touch an OpenAI credential.
 */
export function runSearchAiSecretVariables(source: Record<string, string | undefined>): readonly string[] {
  return source.RUN_SEARCH_AI_PROVIDER === 'ollama' ? [] : ['OPENAI_API_KEY'];
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

  if (values.RUN_SEARCH_AI_PROVIDER === 'ollama') {
    // Local development and test only: loopback inside a container is the container, and container networking is
    // outside this stage (ADR-0057).
    if (environment.APP_ENV === 'production') {
      fail('RUN_SEARCH_AI_PROVIDER', 'RUN_SEARCH_AI_PROVIDER must be openai in production');
    }
    const localModel = values.RUN_SEARCH_AI_MODEL?.trim() ?? '';
    if (localModel === '') {
      fail('RUN_SEARCH_AI_MODEL', 'RUN_SEARCH_AI_MODEL must be set explicitly when the interpreter is enabled');
    } else if (!isLocalOllamaModel(localModel)) {
      fail(
        'RUN_SEARCH_AI_MODEL',
        `RUN_SEARCH_AI_MODEL "${localModel.slice(0, 64)}" is not a name of a local Ollama model (a name check only; cloud models are refused)`,
      );
    }
    // No OPENAI_API_KEY check: that credential does not exist in this mode and is never looked at.
    return;
  }

  const model = values.RUN_SEARCH_AI_MODEL?.trim() ?? '';
  if (model === '') {
    fail('RUN_SEARCH_AI_MODEL', 'RUN_SEARCH_AI_MODEL must be set explicitly when the interpreter is enabled');
  } else if (!isStructuredOutputsModel(model)) {
    fail(
      'RUN_SEARCH_AI_MODEL',
      `RUN_SEARCH_AI_MODEL "${model.slice(0, 64)}" is not a name the local Structured Outputs check recognises (a name check only: it does not prove that a model supports the feature or that the account can use it)`,
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
  const limits: RunSearchAiLimits = {
    allowance: {
      perWindow: values.RUN_SEARCH_AI_ALLOWANCE,
      windowMs: values.RUN_SEARCH_AI_ALLOWANCE_WINDOW_MS,
    },
    limiterMaxUsers: values.RUN_SEARCH_AI_LIMITER_MAX_USERS,
    maxConcurrent: values.RUN_SEARCH_AI_MAX_CONCURRENT,
    maxOutputTokens: values.RUN_SEARCH_AI_MAX_OUTPUT_TOKENS,
    maxResponseBytes: values.RUN_SEARCH_AI_MAX_RESPONSE_BYTES,
    timeoutMs: values.RUN_SEARCH_AI_TIMEOUT_MS,
    userRate: { perWindow: values.RUN_SEARCH_AI_USER_RATE_PER_MINUTE, windowMs: USER_RATE_WINDOW_MS },
  };
  // The model and the credential were validated by checkRunSearchAiEnvironment for exactly this provider; the
  // validated values are read here once, per provider, and no other provider's field can be reached.
  const model = values.RUN_SEARCH_AI_MODEL?.trim() ?? '';
  switch (values.RUN_SEARCH_AI_PROVIDER) {
    case 'fake':
      return { ...limits, model: 'fake', provider: 'fake' };
    case 'ollama':
      if (model === '') {
        throw new Error('RUN_SEARCH_AI_MODEL must be set when the interpreter is enabled');
      }
      return { ...limits, model, provider: 'ollama' };
    case 'openai': {
      const apiKey = values.OPENAI_API_KEY ?? '';
      if (model === '' || apiKey === '') {
        throw new Error('RUN_SEARCH_AI_MODEL and OPENAI_API_KEY must be set when the interpreter is enabled');
      }
      return { ...limits, apiKey, model, provider: 'openai' };
    }
    default:
      return assertNever(values.RUN_SEARCH_AI_PROVIDER);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported run search interpreter provider: ${String(value).slice(0, 32)}`);
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

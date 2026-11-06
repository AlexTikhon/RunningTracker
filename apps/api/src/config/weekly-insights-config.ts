import { isIP } from 'node:net';

import { z } from 'zod';

import { fakeProviderModes, type FakeProviderMode } from '../insights/fake-provider.js';
import { isLocalOllamaModel } from './run-search-ai-config.js';

// Configuration of the weekly insight generator (ADR-0076). Off by default: nothing is generated, POST answers 503
// WEEKLY_INSIGHTS_DISABLED and no model is contacted. There is no external provider to choose: `ollama` is a local
// Ollama (this machine, or a service on the compose network) and `fake` is the deterministic test stand-in.

const integer = (minimum: number, maximum: number) => z.coerce.number().int().min(minimum).max(maximum);

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

export const weeklyInsightsEnvironmentFields = {
  WEEKLY_INSIGHTS_FAKE_MODE: z.enum(fakeProviderModes).default('grounded'),
  WEEKLY_INSIGHTS_MAX_OUTPUT_TOKENS: integer(64, 4_000).default(800),
  WEEKLY_INSIGHTS_MAX_PER_PERSON: integer(1, 16).default(2),
  WEEKLY_INSIGHTS_MAX_QUEUE: integer(0, 256).default(16),
  WEEKLY_INSIGHTS_MAX_RESPONSE_BYTES: integer(1_024, 1_048_576).default(65_536),
  WEEKLY_INSIGHTS_MODEL: z.string().max(64).optional(),
  WEEKLY_INSIGHTS_OLLAMA_BASE_URL: z.string().max(256).default(DEFAULT_OLLAMA_BASE_URL),
  WEEKLY_INSIGHTS_PROVIDER: z.enum(['off', 'ollama', 'fake']).default('off'),
  WEEKLY_INSIGHTS_TIMEOUT_MS: integer(1_000, 300_000).default(60_000),
};

type WeeklyInsightsFieldValues = z.output<z.ZodObject<typeof weeklyInsightsEnvironmentFields>>;

interface WeeklyInsightsLimits {
  readonly maxOutputTokens: number;
  readonly maxPerPerson: number;
  readonly maxQueue: number;
  /** Deadline of one model request; the provider may retry once with a fresh deadline. */
  readonly timeoutMs: number;
}

export interface FakeWeeklyInsightsConfig extends WeeklyInsightsLimits {
  readonly fakeMode: FakeProviderMode;
  readonly provider: 'fake';
}

export interface OllamaWeeklyInsightsConfig extends WeeklyInsightsLimits {
  readonly baseUrl: string;
  readonly maxResponseBytes: number;
  readonly model: string;
  readonly provider: 'ollama';
}

export type WeeklyInsightsConfig = FakeWeeklyInsightsConfig | OllamaWeeklyInsightsConfig;

const privateIpv4 = (address: string): boolean => {
  const [a = -1, b = -1] = address.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

const singleLabelHost = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/**
 * A base URL that can only reach a local Ollama: http(s), no credentials, no path, query or fragment, and a host that
 * is loopback, a private IPv4 address, IPv6 loopback or unique-local, `host.docker.internal`, or a single-label name
 * such as the compose service `ollama`. Every public host, and so every hosted LLM API, is refused.
 */
export function isLocalOllamaBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return false;
  if (url.pathname !== '/') return false;
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    const address = host.slice(1, -1);
    return isIP(address) === 6 && (address === '::1' || /^f[cd][0-9a-f]{2}:/u.test(address));
  }
  if (isIP(host) === 4) return privateIpv4(host);
  return host === 'localhost' || host === 'host.docker.internal' || singleLabelHost.test(host);
}

interface WeeklyInsightsEnvironmentContext {
  readonly APP_ENV: 'development' | 'production' | 'test';
}

export function checkWeeklyInsightsEnvironment(
  values: WeeklyInsightsFieldValues,
  environment: WeeklyInsightsEnvironmentContext,
  context: z.RefinementCtx,
): void {
  const fail = (path: string, message: string): void => {
    context.addIssue({ code: 'custom', message, path: [path] });
  };
  if (values.WEEKLY_INSIGHTS_PROVIDER === 'off') return;
  if (values.WEEKLY_INSIGHTS_PROVIDER === 'fake') {
    if (environment.APP_ENV === 'production') {
      fail('WEEKLY_INSIGHTS_PROVIDER', 'WEEKLY_INSIGHTS_PROVIDER must be off or ollama in production');
    }
    return;
  }
  const model = values.WEEKLY_INSIGHTS_MODEL?.trim() ?? '';
  if (model === '') {
    fail('WEEKLY_INSIGHTS_MODEL', 'WEEKLY_INSIGHTS_MODEL must be set when WEEKLY_INSIGHTS_PROVIDER is ollama');
  } else if (!isLocalOllamaModel(model)) {
    fail(
      'WEEKLY_INSIGHTS_MODEL',
      `WEEKLY_INSIGHTS_MODEL "${model.slice(0, 64)}" is not a name of a local Ollama model (a name check only; cloud models are refused)`,
    );
  }
  if (!isLocalOllamaBaseUrl(values.WEEKLY_INSIGHTS_OLLAMA_BASE_URL)) {
    fail(
      'WEEKLY_INSIGHTS_OLLAMA_BASE_URL',
      'WEEKLY_INSIGHTS_OLLAMA_BASE_URL must be an http(s) origin of a local Ollama: loopback, a private address, host.docker.internal or a single-label service name, without credentials or a path',
    );
  }
}

/** The validated settings, or undefined when generation is off. */
export function buildWeeklyInsightsConfig(values: WeeklyInsightsFieldValues): WeeklyInsightsConfig | undefined {
  const limits: WeeklyInsightsLimits = {
    maxOutputTokens: values.WEEKLY_INSIGHTS_MAX_OUTPUT_TOKENS,
    maxPerPerson: values.WEEKLY_INSIGHTS_MAX_PER_PERSON,
    maxQueue: values.WEEKLY_INSIGHTS_MAX_QUEUE,
    timeoutMs: values.WEEKLY_INSIGHTS_TIMEOUT_MS,
  };
  switch (values.WEEKLY_INSIGHTS_PROVIDER) {
    case 'off':
      return undefined;
    case 'fake':
      return { ...limits, fakeMode: values.WEEKLY_INSIGHTS_FAKE_MODE, provider: 'fake' };
    case 'ollama': {
      const model = values.WEEKLY_INSIGHTS_MODEL?.trim() ?? '';
      if (model === '') throw new Error('WEEKLY_INSIGHTS_MODEL must be set when WEEKLY_INSIGHTS_PROVIDER is ollama');
      return {
        ...limits,
        baseUrl: new URL(values.WEEKLY_INSIGHTS_OLLAMA_BASE_URL).origin,
        maxResponseBytes: values.WEEKLY_INSIGHTS_MAX_RESPONSE_BYTES,
        model,
        provider: 'ollama',
      };
    }
    default:
      return assertNever(values.WEEKLY_INSIGHTS_PROVIDER);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported weekly insights provider: ${String(value).slice(0, 32)}`);
}

/** The configuration without the raw variables. */
export function withoutWeeklyInsightsFields<Environment extends WeeklyInsightsFieldValues>(
  environment: Environment,
): Omit<Environment, keyof WeeklyInsightsFieldValues> {
  const remaining: Record<string, unknown> = { ...environment };
  for (const key of Object.keys(weeklyInsightsEnvironmentFields)) {
    delete remaining[key];
  }
  return remaining as Omit<Environment, keyof WeeklyInsightsFieldValues>;
}

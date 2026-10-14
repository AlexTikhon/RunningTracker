import { afterEach, describe, expect, it, vi } from 'vitest';

import { systemClock } from '../../clock.js';
import { validateEnvironment, type Environment } from '../../config/environment.js';
import { ApiError } from '../../http/errors.js';
import { createLogger } from '../../observability/logger.js';
import { createInterpretationService } from './interpretation-factory.js';

// Counts OpenAI clients: choosing another provider must never build one.
const openai = vi.hoisted(() => ({ constructed: 0 }));
vi.mock('openai', () => {
  class OpenAI {
    public readonly responses = { create: () => Promise.reject(new Error('the OpenAI client was used')) };
    public constructor() {
      openai.constructed += 1;
    }
  }
  class APIConnectionTimeoutError extends Error {}
  class APIUserAbortError extends Error {}
  class RateLimitError extends Error {}
  return { APIConnectionTimeoutError, APIUserAbortError, default: OpenAI, RateLimitError };
});

const base = {
  DATABASE_URL: 'postgresql://running_tracker_runtime:runtime-secret@127.0.0.1:5433/running_tracker',
  MAINTENANCE_DATABASE_URL:
    'postgresql://running_tracker_maintenance:maintenance-secret@127.0.0.1:5433/running_tracker',
};

function configuration(overrides: Record<string, string>): Environment {
  return validateEnvironment({ ...base, ...overrides });
}

function build(config: Environment) {
  const lines: string[] = [];
  const service = createInterpretationService({
    clock: systemClock,
    config,
    logger: createLogger({ clock: systemClock, write: (_level, line) => lines.push(line) }),
  });
  return { lines, service };
}

const request = {
  requestId: '99999999-9999-4999-8999-999999999999',
  revalidate: () => Promise.resolve(),
  signal: new AbortController().signal,
  text: 'runs of at least 5 km last month',
  timeZone: 'Europe/Warsaw',
  userId: '11111111-1111-4111-8111-111111111111',
};

afterEach(() => {
  openai.constructed = 0;
  vi.restoreAllMocks();
});

describe('interpretation factory: provider selection', () => {
  it('builds nothing while the feature is off', () => {
    expect(build(configuration({})).service).toBeUndefined();
    expect(openai.constructed).toBe(0);
  });

  it('builds an OpenAI client only for the openai provider', () => {
    const { service } = build(
      configuration({
        OPENAI_API_KEY: 'sk-test-synthetic-key-value',
        RUN_SEARCH_AI_ENABLED: 'true',
        RUN_SEARCH_AI_MODEL: 'gpt-4.1-mini',
      }),
    );
    expect(service).toBeDefined();
    expect(openai.constructed).toBe(1);
  });

  it.each(['fake', 'ollama'])('builds no OpenAI client for %s and needs no credential', (provider) => {
    const { lines, service } = build(
      configuration({
        RUN_SEARCH_AI_ENABLED: 'true',
        RUN_SEARCH_AI_MODEL: 'qwen3:8b',
        RUN_SEARCH_AI_PROVIDER: provider,
      }),
    );
    expect(service).toBeDefined();
    expect(openai.constructed).toBe(0);
    expect(lines.join('\n')).toContain(`"reason":"${provider}"`);
  });

  it('talks to the fixed local destination and to nothing else when Ollama is selected, without fallback', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Promise.reject(new TypeError('fetch failed'));
    });
    const { service } = build(
      configuration({
        RUN_SEARCH_AI_ENABLED: 'true',
        RUN_SEARCH_AI_MODEL: 'qwen3:8b',
        RUN_SEARCH_AI_PROVIDER: 'ollama',
      }),
    );

    const failure = await service!.interpret(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ code: 'INTERPRETATION_FAILED', details: { reason: 'provider_error' } });
    // One attempt, to the loopback chat endpoint: no retry, no second provider, no OpenAI.
    expect(calls).toEqual(['http://127.0.0.1:11434/api/chat']);
    expect(openai.constructed).toBe(0);
  });

  it('refuses a provider it does not know instead of picking one', () => {
    const config = configuration({
      RUN_SEARCH_AI_ENABLED: 'true',
      RUN_SEARCH_AI_PROVIDER: 'fake',
    });
    const unknown = {
      ...config,
      RUN_SEARCH_AI: { ...config.RUN_SEARCH_AI!, provider: 'other' },
    } as unknown as Environment;
    expect(() => build(unknown)).toThrow('Unsupported run search interpreter provider');
    expect(openai.constructed).toBe(0);
  });
});

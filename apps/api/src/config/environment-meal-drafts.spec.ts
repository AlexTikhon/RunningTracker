import { describe, expect, it } from 'vitest';

import { validateEnvironment } from './environment.js';

const base = {
  ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
  APP_ENV: 'development',
  DATABASE_URL: 'postgresql://running_tracker_runtime:password@127.0.0.1:5433/running_tracker',
  MAINTENANCE_DATABASE_URL: 'postgresql://running_tracker_maintenance:password@127.0.0.1:5433/running_tracker',
  SESSION_COOKIE_SECURE: 'false',
};

describe('MEAL_DRAFTS_* configuration (ADR-0092)', () => {
  it('is off by default: no setting, no model, no provider', () => {
    const config = validateEnvironment(base);
    expect(config.MEAL_DRAFTS).toBeUndefined();
    expect(Object.keys(config).some((key) => key.startsWith('MEAL_DRAFTS_'))).toBe(false);
  });

  it('builds the fake provider for development and test, and refuses it in production', () => {
    expect(validateEnvironment({ ...base, MEAL_DRAFTS_PROVIDER: 'fake' }).MEAL_DRAFTS).toMatchObject({
      maxConcurrent: 1,
      model: 'fake',
      provider: 'fake',
      timeoutMs: 45_000,
      userRate: { perWindow: 5, windowMs: 60_000 },
    });
    expect(() => validateEnvironment({ ...base, APP_ENV: 'production', MEAL_DRAFTS_PROVIDER: 'fake' })).toThrow(/MEAL_DRAFTS_PROVIDER/u);
  });

  it('requires an explicit local model and a local address for Ollama', () => {
    expect(() => validateEnvironment({ ...base, MEAL_DRAFTS_PROVIDER: 'ollama' })).toThrow(/MEAL_DRAFTS_MODEL must be set/u);
    expect(() => validateEnvironment({ ...base, MEAL_DRAFTS_MODEL: 'qwen3:cloud', MEAL_DRAFTS_PROVIDER: 'ollama' })).toThrow(/cloud models are refused/u);
    expect(() =>
      validateEnvironment({ ...base, MEAL_DRAFTS_MODEL: 'qwen3:8b', MEAL_DRAFTS_OLLAMA_BASE_URL: 'https://api.example.com', MEAL_DRAFTS_PROVIDER: 'ollama' }),
    ).toThrow(/MEAL_DRAFTS_OLLAMA_BASE_URL/u);
    expect(validateEnvironment({ ...base, MEAL_DRAFTS_MODEL: 'qwen3:8b', MEAL_DRAFTS_PROVIDER: 'ollama' }).MEAL_DRAFTS).toEqual({
      allowance: { perWindow: 200, windowMs: 86_400_000 },
      baseUrl: 'http://127.0.0.1:11434',
      limiterMaxUsers: 1_000,
      maxConcurrent: 1,
      maxOutputTokens: 600,
      maxResponseBytes: 32_768,
      model: 'qwen3:8b',
      provider: 'ollama',
      timeoutMs: 45_000,
      userRate: { perWindow: 5, windowMs: 60_000 },
    });
  });

  it('bounds the deadline so that it fits the browser\'s wait for this request', () => {
    expect(() => validateEnvironment({ ...base, MEAL_DRAFTS_PROVIDER: 'fake', MEAL_DRAFTS_TIMEOUT_MS: '55001' })).toThrow(/MEAL_DRAFTS_TIMEOUT_MS/u);
    expect(() => validateEnvironment({ ...base, MEAL_DRAFTS_MAX_CONCURRENT: '9', MEAL_DRAFTS_PROVIDER: 'fake' })).toThrow(/MEAL_DRAFTS_MAX_CONCURRENT/u);
  });

  it('is independent of the other AI features', () => {
    const config = validateEnvironment({ ...base, MEAL_DRAFTS_PROVIDER: 'fake' });
    expect(config.RUN_SEARCH_AI).toBeUndefined();
    expect(config.WEEKLY_INSIGHTS).toBeUndefined();
  });
});

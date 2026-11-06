import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateEnvironment } from './environment.js';
import { isLocalOllamaBaseUrl } from './weekly-insights-config.js';

const base = {
  DATABASE_URL: 'postgresql://running_tracker_runtime:runtime-secret@127.0.0.1:5433/running_tracker',
  MAINTENANCE_DATABASE_URL: 'postgresql://running_tracker_maintenance:maintenance-secret@127.0.0.1:5433/running_tracker',
};

const production = {
  ...base,
  ALLOWED_ORIGINS: 'https://tracker.example',
  APP_ENV: 'production',
  DELETION_JOURNAL_DIR: resolve('/var/lib/running-tracker/deletion-journal'),
  LIVE_TRACK_CURSOR_SIGNING_KEY: Buffer.from('deployment-specific-live-track-key-material', 'utf8').toString('base64url'),
  OIDC_CLIENT_ID: 'running-tracker',
  OIDC_CLIENT_SECRET: 'client-secret-value',
  OIDC_ISSUER_URL: 'https://idp.example/realm',
  OIDC_REDIRECT_URI: 'https://tracker.example/api/auth/callback',
};

const invalid = (input: Record<string, string>) => () => validateEnvironment(input);

describe('weekly insights configuration (ADR-0076)', () => {
  it('is off by default and leaves no raw variable behind', () => {
    const environment = validateEnvironment(base);
    expect(environment.WEEKLY_INSIGHTS).toBeUndefined();
    expect(Object.keys(environment).filter((key) => key.startsWith('WEEKLY_INSIGHTS_'))).toEqual([]);
  });

  it('builds a local Ollama configuration with the defaults', () => {
    const environment = validateEnvironment({ ...base, WEEKLY_INSIGHTS_MODEL: 'qwen2.5:3b', WEEKLY_INSIGHTS_PROVIDER: 'ollama' });
    expect(environment.WEEKLY_INSIGHTS).toEqual({
      baseUrl: 'http://127.0.0.1:11434',
      maxOutputTokens: 800,
      maxPerPerson: 2,
      maxQueue: 16,
      maxResponseBytes: 65_536,
      model: 'qwen2.5:3b',
      provider: 'ollama',
      timeoutMs: 60_000,
    });
  });

  it('accepts the compose service name and is allowed in production', () => {
    const environment = validateEnvironment({
      ...production,
      WEEKLY_INSIGHTS_MODEL: 'llama3.2:3b',
      WEEKLY_INSIGHTS_OLLAMA_BASE_URL: 'http://ollama:11434',
      WEEKLY_INSIGHTS_PROVIDER: 'ollama',
    });
    expect(environment.WEEKLY_INSIGHTS).toMatchObject({ baseUrl: 'http://ollama:11434', provider: 'ollama' });
  });

  it('requires a local model name for Ollama and refuses cloud models', () => {
    expect(invalid({ ...base, WEEKLY_INSIGHTS_PROVIDER: 'ollama' })).toThrow(/WEEKLY_INSIGHTS_MODEL must be set/u);
    expect(invalid({ ...base, WEEKLY_INSIGHTS_MODEL: 'gpt-oss:120b-cloud', WEEKLY_INSIGHTS_PROVIDER: 'ollama' })).toThrow(
      /not a name of a local Ollama model/u,
    );
  });

  it('refuses a base URL that could reach a hosted LLM API', () => {
    for (const url of [
      'https://api.openai.com',
      'http://ollama.example.com:11434',
      'http://8.8.8.8:11434',
      'http://user:pass@127.0.0.1:11434',
      'http://127.0.0.1:11434/v1',
      'http://127.0.0.1:11434/?x=1',
      'ftp://127.0.0.1',
    ]) {
      expect(invalid({ ...base, WEEKLY_INSIGHTS_MODEL: 'qwen2.5:3b', WEEKLY_INSIGHTS_OLLAMA_BASE_URL: url, WEEKLY_INSIGHTS_PROVIDER: 'ollama' }))
        .toThrow(/WEEKLY_INSIGHTS_OLLAMA_BASE_URL/u);
    }
  });

  it('classifies local destinations', () => {
    for (const url of ['http://127.0.0.1:11434', 'http://localhost:11434/', 'http://ollama:11434', 'http://10.0.0.5:11434', 'http://172.20.0.2:11434', 'http://192.168.1.10:11434', 'http://[::1]:11434', 'http://host.docker.internal:11434']) {
      expect([url, isLocalOllamaBaseUrl(url)]).toEqual([url, true]);
    }
    for (const url of ['http://172.32.0.1:11434', 'http://[2001:db8::1]:11434', 'http://not a url', 'http://a.b:11434']) {
      expect([url, isLocalOllamaBaseUrl(url)]).toEqual([url, false]);
    }
  });

  it('allows the fake provider outside production only', () => {
    expect(validateEnvironment({ ...base, WEEKLY_INSIGHTS_PROVIDER: 'fake' }).WEEKLY_INSIGHTS).toMatchObject({
      fakeMode: 'grounded',
      provider: 'fake',
    });
    expect(validateEnvironment({ ...base, WEEKLY_INSIGHTS_FAKE_MODE: 'hallucinated_number', WEEKLY_INSIGHTS_PROVIDER: 'fake' }).WEEKLY_INSIGHTS)
      .toMatchObject({ fakeMode: 'hallucinated_number' });
    expect(invalid({ ...production, WEEKLY_INSIGHTS_PROVIDER: 'fake' })).toThrow(/must be off or ollama in production/u);
  });

  it('bounds the limits', () => {
    expect(invalid({ ...base, WEEKLY_INSIGHTS_PROVIDER: 'fake', WEEKLY_INSIGHTS_TIMEOUT_MS: '999' })).toThrow(/WEEKLY_INSIGHTS_TIMEOUT_MS/u);
    expect(invalid({ ...base, WEEKLY_INSIGHTS_PROVIDER: 'fake', WEEKLY_INSIGHTS_MAX_QUEUE: '257' })).toThrow(/WEEKLY_INSIGHTS_MAX_QUEUE/u);
    expect(invalid({ ...base, WEEKLY_INSIGHTS_PROVIDER: 'openai' })).toThrow(/WEEKLY_INSIGHTS_PROVIDER/u);
  });
});

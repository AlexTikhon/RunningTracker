import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadEnvironment, validateEnvironment } from './environment.js';

const base = {
  DATABASE_URL:
    'postgresql://running_tracker_runtime:runtime-secret@127.0.0.1:5433/running_tracker',
  MAINTENANCE_DATABASE_URL:
    'postgresql://running_tracker_maintenance:maintenance-secret@127.0.0.1:5433/running_tracker',
};

const enabled = {
  ...base,
  OPENAI_API_KEY: 'sk-test-synthetic-key-value',
  RUN_SEARCH_AI_ENABLED: 'true',
  RUN_SEARCH_AI_MODEL: 'gpt-4.1-mini',
};

const production = {
  ...enabled,
  ALLOWED_ORIGINS: 'https://tracker.example',
  APP_ENV: 'production',
  DELETION_JOURNAL_DIR: resolve('/var/lib/running-tracker/deletion-journal'),
  LIVE_TRACK_CURSOR_SIGNING_KEY: Buffer.from(
    'deployment-specific-live-track-key-material',
    'utf8',
  ).toString('base64url'),
  OIDC_CLIENT_ID: 'running-tracker',
  OIDC_CLIENT_SECRET: 'client-secret-value',
  OIDC_ISSUER_URL: 'https://idp.example/realm',
  OIDC_REDIRECT_URI: 'https://tracker.example/api/auth/callback',
};

describe('run search interpretation configuration', () => {
  it('is disabled by default and needs no credential or model', () => {
    const environment = validateEnvironment(base);
    expect(environment.RUN_SEARCH_AI).toBeUndefined();
  });

  it('ignores credentials and a model while disabled, and does not carry the raw variables', () => {
    const environment = validateEnvironment({
      ...base,
      OPENAI_API_KEY: 'sk-test-synthetic-key-value',
      RUN_SEARCH_AI_MODEL: 'gpt-4.1-mini',
    });
    expect(environment.RUN_SEARCH_AI).toBeUndefined();
    expect(JSON.stringify(environment)).not.toContain('sk-test-synthetic-key-value');
  });

  it('applies conservative bounded defaults when enabled', () => {
    expect(validateEnvironment(enabled).RUN_SEARCH_AI).toEqual({
      allowance: { perWindow: 100, windowMs: 86_400_000 },
      apiKey: 'sk-test-synthetic-key-value',
      limiterMaxUsers: 1_000,
      maxConcurrent: 4,
      maxOutputTokens: 800,
      maxResponseBytes: 32_768,
      model: 'gpt-4.1-mini',
      provider: 'openai',
      timeoutMs: 10_000,
      userRate: { perWindow: 5, windowMs: 60_000 },
    });
  });

  it('accepts explicit limits inside their bounds', () => {
    const environment = validateEnvironment({
      ...enabled,
      RUN_SEARCH_AI_ALLOWANCE: '20',
      RUN_SEARCH_AI_ALLOWANCE_WINDOW_MS: '3600000',
      RUN_SEARCH_AI_MAX_CONCURRENT: '2',
      RUN_SEARCH_AI_MAX_OUTPUT_TOKENS: '300',
      RUN_SEARCH_AI_MAX_RESPONSE_BYTES: '8192',
      RUN_SEARCH_AI_TIMEOUT_MS: '6000',
      RUN_SEARCH_AI_USER_RATE_PER_MINUTE: '3',
    });
    expect(environment.RUN_SEARCH_AI).toMatchObject({
      allowance: { perWindow: 20, windowMs: 3_600_000 },
      maxConcurrent: 2,
      maxOutputTokens: 300,
      maxResponseBytes: 8_192,
      timeoutMs: 6_000,
      userRate: { perWindow: 3, windowMs: 60_000 },
    });
  });

  it('requires a model and a credential when enabled, without echoing a secret', () => {
    const withoutModel: Record<string, string> = { ...enabled };
    delete withoutModel.RUN_SEARCH_AI_MODEL;
    expect(() => validateEnvironment(withoutModel)).toThrow('RUN_SEARCH_AI_MODEL must be set');

    const withoutKey: Record<string, string> = { ...enabled };
    delete withoutKey.OPENAI_API_KEY;
    expect(() => validateEnvironment(withoutKey)).toThrow('OPENAI_API_KEY must be set');
  });

  it('never falls back to another model: an empty or unsuitable name is refused', () => {
    for (const model of ['', ' ', 'gpt-3.5-turbo', 'gpt-4-turbo', 'gpt-4o-2024-05-13', 'text-embedding-3-small', 'o1-mini']) {
      expect(() => validateEnvironment({ ...enabled, RUN_SEARCH_AI_MODEL: model }), model).toThrow(
        'RUN_SEARCH_AI_MODEL',
      );
    }
    for (const model of ['gpt-4o-mini', 'gpt-4o-2024-08-06', 'gpt-4.1', 'gpt-5-mini', 'gpt-6-astra', 'o3']) {
      expect(validateEnvironment({ ...enabled, RUN_SEARCH_AI_MODEL: model }).RUN_SEARCH_AI?.model).toBe(model);
    }
  });

  it('keeps the provider deadline below the browser request deadline', () => {
    expect(() => validateEnvironment({ ...enabled, RUN_SEARCH_AI_TIMEOUT_MS: '13000' })).toThrow(
      'RUN_SEARCH_AI_TIMEOUT_MS',
    );
    expect(() => validateEnvironment({ ...enabled, RUN_SEARCH_AI_TIMEOUT_MS: '500' })).toThrow(
      'RUN_SEARCH_AI_TIMEOUT_MS',
    );
    expect(validateEnvironment({ ...enabled, RUN_SEARCH_AI_TIMEOUT_MS: '12000' }).RUN_SEARCH_AI?.timeoutMs).toBe(
      12_000,
    );
  });

  it.each([
    ['RUN_SEARCH_AI_USER_RATE_PER_MINUTE', '0'],
    ['RUN_SEARCH_AI_USER_RATE_PER_MINUTE', '61'],
    ['RUN_SEARCH_AI_MAX_CONCURRENT', '0'],
    ['RUN_SEARCH_AI_MAX_CONCURRENT', '33'],
    ['RUN_SEARCH_AI_ALLOWANCE', '0'],
    ['RUN_SEARCH_AI_ALLOWANCE', '100001'],
    ['RUN_SEARCH_AI_ALLOWANCE_WINDOW_MS', '999'],
    ['RUN_SEARCH_AI_MAX_OUTPUT_TOKENS', '10'],
    ['RUN_SEARCH_AI_MAX_OUTPUT_TOKENS', '100000'],
    ['RUN_SEARCH_AI_MAX_RESPONSE_BYTES', '100'],
    ['RUN_SEARCH_AI_TIMEOUT_MS', 'soon'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => validateEnvironment({ ...enabled, [name]: value })).toThrow(name);
  });

  it('rejects a credential with whitespace or control characters, without echoing it', () => {
    for (const key of ['sk-synthetic-leak a b', 'sk-synthetic-leak\nb', `sk-synthetic-leak-${'x'.repeat(600)}`]) {
      let message = '';
      try {
        validateEnvironment({ ...enabled, OPENAI_API_KEY: key });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('OPENAI_API_KEY');
      expect(message).not.toContain('sk-synthetic-leak');
    }
  });

  it('allows the in-process fake provider outside production only, and it needs no key or model', () => {
    const fake = { ...base, RUN_SEARCH_AI_ENABLED: 'true', RUN_SEARCH_AI_PROVIDER: 'fake' };
    expect(validateEnvironment(fake).RUN_SEARCH_AI).toMatchObject({ model: 'fake', provider: 'fake' });
    expect(validateEnvironment(fake).RUN_SEARCH_AI).not.toHaveProperty('apiKey');
    expect(() => validateEnvironment({ ...production, RUN_SEARCH_AI_PROVIDER: 'fake' })).toThrow(
      'RUN_SEARCH_AI_PROVIDER must be openai in production',
    );
    expect(validateEnvironment(production).RUN_SEARCH_AI?.provider).toBe('openai');
  });

  it('rejects an unknown provider', () => {
    expect(() => validateEnvironment({ ...enabled, RUN_SEARCH_AI_PROVIDER: 'other' })).toThrow(
      'RUN_SEARCH_AI_PROVIDER',
    );
  });

  describe('the local Ollama provider (ADR-0057, local development and test only)', () => {
    const ollama = {
      ...base,
      RUN_SEARCH_AI_ENABLED: 'true',
      RUN_SEARCH_AI_MODEL: 'qwen3:8b',
      RUN_SEARCH_AI_PROVIDER: 'ollama',
    };

    it('needs a model and no credential, and the configuration has no credential field at all', () => {
      const configuration = validateEnvironment(ollama).RUN_SEARCH_AI;
      expect(configuration).toEqual({
        allowance: { perWindow: 100, windowMs: 86_400_000 },
        limiterMaxUsers: 1_000,
        maxConcurrent: 4,
        maxOutputTokens: 800,
        maxResponseBytes: 32_768,
        model: 'qwen3:8b',
        provider: 'ollama',
        timeoutMs: 10_000,
        userRate: { perWindow: 5, windowMs: 60_000 },
      });
      expect(configuration).not.toHaveProperty('apiKey');
    });

    it('stays off unless enabled, whatever else is set', () => {
      const environment = validateEnvironment({ ...ollama, RUN_SEARCH_AI_ENABLED: 'false' });
      expect(environment.RUN_SEARCH_AI).toBeUndefined();
    });

    it('requires an explicit model and never falls back to another one or another provider', () => {
      const withoutModel: Record<string, string> = { ...ollama };
      delete withoutModel.RUN_SEARCH_AI_MODEL;
      expect(() => validateEnvironment(withoutModel)).toThrow('RUN_SEARCH_AI_MODEL must be set');
      for (const model of ['', ' ', 'qwen3 8b', 'http://127.0.0.1:11434/qwen3', '../qwen3', 'qwen3:8b:q4']) {
        expect(() => validateEnvironment({ ...ollama, RUN_SEARCH_AI_MODEL: model }), model).toThrow(
          'RUN_SEARCH_AI_MODEL',
        );
      }
    });

    it('refuses a cloud model: the feature is local-only', () => {
      for (const model of ['qwen3:cloud', 'gpt-oss:120b-cloud', 'gemma4:cloud', 'ollama.com/library/qwen3:8b']) {
        expect(() => validateEnvironment({ ...ollama, RUN_SEARCH_AI_MODEL: model }), model).toThrow(
          'RUN_SEARCH_AI_MODEL',
        );
      }
      for (const model of ['qwen3:8b', 'qwen3:8b-q4_K_M', 'llama3.2:3b', 'hf.co/someone/some-model:Q4_K_M', 'qwen3']) {
        expect(validateEnvironment({ ...ollama, RUN_SEARCH_AI_MODEL: model }).RUN_SEARCH_AI?.model, model).toBe(model);
      }
    });

    it('does not carry or require an OpenAI credential, and does not check names with the OpenAI pattern', () => {
      const withKey = validateEnvironment({ ...ollama, OPENAI_API_KEY: 'sk-test-synthetic-key-value' });
      expect(JSON.stringify(withKey)).not.toContain('sk-test-synthetic-key-value');
      expect(withKey.RUN_SEARCH_AI).not.toHaveProperty('apiKey');
      // A key with whitespace is an OpenAI problem; in this mode it is never looked at.
      expect(() => validateEnvironment({ ...ollama, OPENAI_API_KEY: 'has white space' })).not.toThrow();
    });

    it('is refused in production, where the destination would be the container itself', () => {
      expect(() => validateEnvironment({ ...production, RUN_SEARCH_AI_PROVIDER: 'ollama', RUN_SEARCH_AI_MODEL: 'qwen3:8b' })).toThrow(
        'RUN_SEARCH_AI_PROVIDER must be openai in production',
      );
    });

    it('applies the same limits and deadlines as the other providers', () => {
      expect(() => validateEnvironment({ ...ollama, RUN_SEARCH_AI_TIMEOUT_MS: '13000' })).toThrow(
        'RUN_SEARCH_AI_TIMEOUT_MS',
      );
      expect(validateEnvironment({ ...ollama, RUN_SEARCH_AI_MAX_CONCURRENT: '1' }).RUN_SEARCH_AI).toMatchObject({
        maxConcurrent: 1,
      });
    });

    it('does not read the OpenAI credential file, while OpenAI mode still does', () => {
      const missing = resolve('/definitely/not/here/openai-api-key');
      expect(
        loadEnvironment({ envFiles: [], environment: { ...ollama, OPENAI_API_KEY_FILE: missing } }).RUN_SEARCH_AI,
      ).toMatchObject({ provider: 'ollama' });
      // A relative path would be refused by the reader; in this mode nothing validates or opens it.
      expect(() =>
        loadEnvironment({ envFiles: [], environment: { ...ollama, OPENAI_API_KEY_FILE: 'relative/path' } }),
      ).not.toThrow();

      const openai: Record<string, string> = { ...enabled, OPENAI_API_KEY_FILE: missing };
      delete openai.OPENAI_API_KEY;
      expect(() => loadEnvironment({ envFiles: [], environment: openai })).toThrow(
        'OPENAI_API_KEY_FILE could not be read',
      );
    });
  });

  it('reads the credential from a mounted file and refuses setting both forms', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rt-openai-key-'));
    try {
      const keyFile = join(directory, 'openai-api-key');
      writeFileSync(keyFile, 'sk-test-synthetic-file-key\n', 'utf8');
      const withoutKey: Record<string, string> = { ...enabled };
      delete withoutKey.OPENAI_API_KEY;

      const environment = loadEnvironment({
        envFiles: [],
        environment: { ...withoutKey, OPENAI_API_KEY_FILE: keyFile },
      });
      expect(environment.RUN_SEARCH_AI).toMatchObject({ apiKey: 'sk-test-synthetic-file-key', provider: 'openai' });

      expect(() =>
        loadEnvironment({ envFiles: [], environment: { ...enabled, OPENAI_API_KEY_FILE: keyFile } }),
      ).toThrow('OPENAI_API_KEY and OPENAI_API_KEY_FILE are mutually exclusive');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

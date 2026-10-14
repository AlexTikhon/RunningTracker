import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  INTERPRETATION_INSTRUCTIONS,
  INTERPRETATION_PROMPT_VERSION,
  OLLAMA_INTERPRETATION_INSTRUCTIONS,
  OLLAMA_INTERPRETATION_PROMPT_VERSION,
} from '../runs/interpretation/interpretation-prompt.js';
import {
  INTERPRETATION_SCHEMA_NAME,
  providerOutputJsonSchema,
} from '../runs/interpretation/interpretation-schema.js';
import {
  OLLAMA_OUTPUT_SCHEMA_NAME,
  ollamaOutputJsonSchema,
} from '../runs/interpretation/ollama-output-schema.js';
import {
  describeEvaluationRun,
  evaluationWireContract,
  formatEvaluationReport,
  loadLiveEvaluationConfig,
  parseEvaluationArguments,
} from './run-search-evaluation-cli.js';
import type { EvaluationReport } from './run-search-evaluator.js';

describe('evaluation arguments', () => {
  it('refuses to call the provider unless --live is given', () => {
    expect(() => parseEvaluationArguments([])).toThrow(/--live/u);
    expect(() => parseEvaluationArguments(['--max-cases', '5'])).toThrow(/--live/u);
  });

  it('accepts an explicit live run with bounded defaults', () => {
    expect(parseEvaluationArguments(['--live'])).toEqual({
      caseIds: undefined,
      concurrency: 1,
      dryRun: false,
      failOnMismatch: false,
      live: true,
      maxCases: undefined,
      out: undefined,
    });
  });

  it('gates on the acceptance verdict only when --fail-on-mismatch is given', () => {
    expect(parseEvaluationArguments(['--live', '--cases', 'en-location']).failOnMismatch).toBe(false);
    expect(
      parseEvaluationArguments(['--live', '--cases', 'en-location', '--fail-on-mismatch']).failOnMismatch,
    ).toBe(true);
    expect(parseEvaluationArguments(['--fail-on-mismatch', '--live']).failOnMismatch).toBe(true);
  });

  it('refuses --fail-on-mismatch on a dry run, which makes no request and so can never be accepted', () => {
    expect(() => parseEvaluationArguments(['--dry-run', '--fail-on-mismatch'])).toThrow(/dry run/iu);
    expect(() => parseEvaluationArguments(['--live', '--dry-run', '--fail-on-mismatch'])).toThrow(/dry run/iu);
    expect(() => parseEvaluationArguments(['--fail-on-mismatch'])).toThrow(/--live/u);
  });

  it('allows a dry run without --live, which makes no call', () => {
    expect(parseEvaluationArguments(['--dry-run'])).toMatchObject({ dryRun: true, live: false });
  });

  it('bounds the number of cases and the concurrency', () => {
    expect(parseEvaluationArguments(['--live', '--max-cases', '10', '--concurrency', '2'])).toMatchObject({
      concurrency: 2,
      maxCases: 10,
    });
    for (const bad of [
      ['--live', '--max-cases', '0'],
      ['--live', '--max-cases', '201'],
      ['--live', '--max-cases', 'many'],
      ['--live', '--concurrency', '0'],
      ['--live', '--concurrency', '5'],
    ]) {
      expect(() => parseEvaluationArguments(bad), bad.join(' ')).toThrow();
    }
  });

  it('selects cases by identity, as a list that cannot be malformed, repeated or combined with --max-cases', () => {
    expect(parseEvaluationArguments(['--live', '--cases', 'en-last-month-min-longest,ru-location'])).toMatchObject({
      caseIds: ['en-last-month-min-longest', 'ru-location'],
      maxCases: undefined,
    });
    expect(parseEvaluationArguments(['--dry-run', '--cases', 'en-location']).caseIds).toEqual(['en-location']);
    for (const bad of [
      ['--live', '--cases'],
      ['--live', '--cases', '--live'],
      ['--live', '--cases', ''],
      ['--live', '--cases', 'en-location,'],
      ['--live', '--cases', 'en-location,en-location'],
      ['--live', '--cases', 'EN_LOCATION'],
      ['--live', '--cases', 'en-location', '--max-cases', '3'],
      ['--live', '--max-cases', '3', '--cases', 'en-location'],
    ]) {
      expect(() => parseEvaluationArguments(bad), bad.join(' ')).toThrow();
    }
  });

  it('refuses an argument it does not know, so a typo cannot widen a run', () => {
    expect(() => parseEvaluationArguments(['--live', '--all-the-things'])).toThrow(/Unknown argument/u);
  });

  it('keeps a report path', () => {
    expect(parseEvaluationArguments(['--live', '--out', 'report.json'])).toMatchObject({ out: 'report.json' });
  });
});

describe('live evaluation configuration', () => {
  const ok = { OPENAI_API_KEY: 'sk-test-synthetic-sentinel-key-2b7e', RUN_SEARCH_AI_MODEL: 'gpt-4.1-mini' };

  it('needs an explicit model and a credential, and never echoes the credential', () => {
    expect(loadLiveEvaluationConfig(ok)).toMatchObject({ model: 'gpt-4.1-mini', provider: 'openai' });
    expect(() => loadLiveEvaluationConfig({ OPENAI_API_KEY: ok.OPENAI_API_KEY })).toThrow(
      /RUN_SEARCH_AI_MODEL/u,
    );
    let message = '';
    try {
      loadLiveEvaluationConfig({ RUN_SEARCH_AI_MODEL: ok.RUN_SEARCH_AI_MODEL });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/OPENAI_API_KEY/u);
    const rejected = (() => {
      try {
        loadLiveEvaluationConfig({ ...ok, RUN_SEARCH_AI_MODEL: 'gpt-3.5-turbo' });
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(rejected).toMatch(/Structured Outputs/u);
    expect(rejected).not.toContain(ok.OPENAI_API_KEY);
  });

  it('ignores the enabling flag, and refuses the fake provider: a measurement needs a real model', () => {
    expect(loadLiveEvaluationConfig({ ...ok, RUN_SEARCH_AI_ENABLED: 'false' })).toMatchObject({
      provider: 'openai',
    });
    // The fake provider is never silently replaced by a paid one: the configuration is wrong, so say so.
    expect(() => loadLiveEvaluationConfig({ ...ok, RUN_SEARCH_AI_PROVIDER: 'fake' })).toThrow(
      /RUN_SEARCH_AI_PROVIDER.*(openai|ollama)/u,
    );
  });

  it('uses the same bounds as the application', () => {
    expect(() => loadLiveEvaluationConfig({ ...ok, RUN_SEARCH_AI_TIMEOUT_MS: '60000' })).toThrow();
    expect(loadLiveEvaluationConfig({ ...ok, RUN_SEARCH_AI_TIMEOUT_MS: '8000' }).timeoutMs).toBe(8_000);
  });

  describe('with the local Ollama provider', () => {
    const local = { RUN_SEARCH_AI_MODEL: 'qwen3:8b', RUN_SEARCH_AI_PROVIDER: 'ollama' };

    it('selects it, needs a model and no OpenAI credential, and carries none', () => {
      const config = loadLiveEvaluationConfig(local);
      expect(config).toMatchObject({ model: 'qwen3:8b', provider: 'ollama' });
      expect(config).not.toHaveProperty('apiKey');
      expect(() => loadLiveEvaluationConfig({ RUN_SEARCH_AI_PROVIDER: 'ollama' })).toThrow(/RUN_SEARCH_AI_MODEL/u);
    });

    it('does not use a stray OpenAI credential, and never selects a cloud model', () => {
      const config = loadLiveEvaluationConfig({ ...local, OPENAI_API_KEY: ok.OPENAI_API_KEY });
      expect(JSON.stringify(config)).not.toContain(ok.OPENAI_API_KEY);
      expect(() => loadLiveEvaluationConfig({ ...local, RUN_SEARCH_AI_MODEL: 'qwen3:cloud' })).toThrow(
        /RUN_SEARCH_AI_MODEL/u,
      );
    });

    it('keeps the application deadline and bounds by default', () => {
      expect(loadLiveEvaluationConfig(local)).toMatchObject({
        maxOutputTokens: 800,
        maxResponseBytes: 32_768,
        timeoutMs: 10_000,
      });
    });
  });
});

describe('what a run is described by', () => {
  const common = {
    args: {
      caseIds: ['en-location'],
      concurrency: 1,
      dryRun: false,
      failOnMismatch: false,
      live: true,
      maxCases: undefined,
      out: undefined,
    },
    openaiSdkVersion: '7.22.0',
  };
  const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
  const openaiConfig = (): ReturnType<typeof loadLiveEvaluationConfig> =>
    loadLiveEvaluationConfig({
      OPENAI_API_KEY: 'sk-test-synthetic-sentinel-key-2b7e',
      RUN_SEARCH_AI_MODEL: 'gpt-4.1-mini',
    });
  const ollamaConfig = (): ReturnType<typeof loadLiveEvaluationConfig> =>
    loadLiveEvaluationConfig({ RUN_SEARCH_AI_MODEL: 'qwen3:8b', RUN_SEARCH_AI_PROVIDER: 'ollama' });

  it('hashes the instructions and schema the Ollama adapter sends, and names them as its own', () => {
    const run = describeEvaluationRun({ ...common, config: ollamaConfig(), runtimeVersion: '0.35.1' });
    expect(run.instructionsSha256).toBe(sha256(OLLAMA_INTERPRETATION_INSTRUCTIONS));
    expect(run.schemaSha256).toBe(sha256(JSON.stringify(ollamaOutputJsonSchema)));
    expect(run.schemaName).toBe(OLLAMA_OUTPUT_SCHEMA_NAME);
    expect(run.promptVersion).toBe(OLLAMA_INTERPRETATION_PROMPT_VERSION);
    // Not the unchanged OpenAI wire contract.
    expect(run.instructionsSha256).not.toBe(sha256(INTERPRETATION_INSTRUCTIONS));
    expect(run.schemaSha256).not.toBe(sha256(JSON.stringify(providerOutputJsonSchema)));
    expect(run.schemaName).not.toBe(INTERPRETATION_SCHEMA_NAME);
  });

  it('hashes the OpenAI instructions and schema for OpenAI, unchanged', () => {
    const run = describeEvaluationRun({ ...common, config: openaiConfig(), runtimeVersion: null });
    expect(run.instructionsSha256).toBe(sha256(INTERPRETATION_INSTRUCTIONS));
    expect(run.schemaSha256).toBe(sha256(JSON.stringify(providerOutputJsonSchema)));
    expect(run.schemaName).toBe(INTERPRETATION_SCHEMA_NAME);
    expect(run.promptVersion).toBe(INTERPRETATION_PROMPT_VERSION);
  });

  it('takes the wire contract from the provider alone, so a run cannot be described with the other one', () => {
    expect(evaluationWireContract('ollama')).toMatchObject({
      instructions: OLLAMA_INTERPRETATION_INSTRUCTIONS,
      promptVersion: OLLAMA_INTERPRETATION_PROMPT_VERSION,
      schema: ollamaOutputJsonSchema,
    });
    expect(evaluationWireContract('openai')).toMatchObject({
      instructions: INTERPRETATION_INSTRUCTIONS,
      promptVersion: INTERPRETATION_PROMPT_VERSION,
      schema: providerOutputJsonSchema,
    });
    expect(OLLAMA_INTERPRETATION_PROMPT_VERSION).not.toBe(INTERPRETATION_PROMPT_VERSION);
  });

  it('names the local runtime and its generation settings for Ollama, and no OpenAI SDK', () => {
    const run = describeEvaluationRun({
      ...common,
      config: loadLiveEvaluationConfig({ RUN_SEARCH_AI_MODEL: 'qwen3:8b', RUN_SEARCH_AI_PROVIDER: 'ollama' }),
      runtimeVersion: '0.35.1',
    });
    expect(run).toMatchObject({
      generation: { numCtx: 4_096, numPredict: 800, stream: false, temperature: 0, think: false },
      model: 'qwen3:8b',
      provider: 'ollama',
      runtime: { name: 'ollama', version: '0.35.1' },
      selection: 'ids',
      timeoutMs: 10_000,
    });
    expect(JSON.stringify(run).toLowerCase()).not.toContain('openai');
    expect(run.instructionsSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(run.schemaSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('names the SDK, not a local runtime, for OpenAI', () => {
    const run = describeEvaluationRun({
      ...common,
      config: loadLiveEvaluationConfig({
        OPENAI_API_KEY: 'sk-test-synthetic-sentinel-key-2b7e',
        RUN_SEARCH_AI_MODEL: 'gpt-4.1-mini',
      }),
      runtimeVersion: null,
    });
    expect(run).toMatchObject({
      model: 'gpt-4.1-mini',
      provider: 'openai',
      runtime: { name: 'openai-node-sdk', version: '7.22.0' },
    });
    expect(JSON.stringify(run)).not.toContain('sk-test');
    expect(JSON.stringify(run).toLowerCase()).not.toContain('ollama');
  });

});

describe('selecting the provider for a run', () => {
  it('builds the adapter of the configured provider and never another', async () => {
    const { createInterpreter } = await import('../runs/interpretation/interpretation-factory.js');
    const { OllamaInterpreter } = await import('../runs/interpretation/ollama-interpreter.js');
    const { OpenAiInterpreter } = await import('../runs/interpretation/openai-interpreter.js');
    const local = createInterpreter(
      loadLiveEvaluationConfig({ RUN_SEARCH_AI_MODEL: 'qwen3:8b', RUN_SEARCH_AI_PROVIDER: 'ollama' }),
    );
    expect(local).toBeInstanceOf(OllamaInterpreter);
    expect(local.model).toBe('qwen3:8b');
    const remote = createInterpreter(
      loadLiveEvaluationConfig({
        OPENAI_API_KEY: 'sk-test-synthetic-sentinel-key-2b7e',
        RUN_SEARCH_AI_MODEL: 'gpt-4.1-mini',
      }),
    );
    expect(remote).toBeInstanceOf(OpenAiInterpreter);
  });
});

describe('report text', () => {
  const report: EvaluationReport = {
    aborted: null,
    byCategory: { distance: { cases: 4, exactFilters: 3, outcomeCorrect: 4 } },
    byLanguage: {
      en: {
        cases: 50,
        exactFilters: { correct: 20, total: 25 },
        failures: 1,
        outcome: { correct: 46, total: 50 },
        reason: { correct: 15, total: 25 },
      },
      ru: {
        cases: 10,
        exactFilters: { correct: 5, total: 5 },
        failures: 0,
        outcome: { correct: 8, total: 10 },
        reason: { correct: 4, total: 5 },
      },
    },
    caseCount: 60,
    counts: {
      exactFilters: { correct: 25, total: 30 },
      outcome: { correct: 54, total: 60 },
      reason: { correct: 19, total: 30 },
    },
    datasetVersion: '1',
    exactFilterAccuracy: 0.8,
    executedCount: 60,
    executedIds: [],
    failures: { byReason: { timeout: 1 }, total: 1 },
    fieldErrors: { maxDistance: 1, minDistance: 2, period: 3, sort: 0 },
    incorrectAcceptances: { ids: ['en-location'], ofCases: 30, total: 1 },
    latencyMs: { max: 2_100, mean: 900, p50: 800, p95: 1_900 },
    mismatches: [
      {
        actualOutcome: 'clarify',
        actualReason: 'period_missing',
        expectedOutcome: 'search',
        expectedReason: null,
        fieldErrors: [],
        id: 'en-this-month-plain',
      },
    ],
    model: 'gpt-4.1-mini',
    outcomeAccuracy: 0.9,
    outcomeMatrix: {
      clarify: { clarify: 9, failure: 0, search: 1, unsupported: 0 },
      search: { clarify: 1, failure: 1, search: 28, unsupported: 0 },
      unsupported: { clarify: 0, failure: 0, search: 0, unsupported: 20 },
    },
    partial: false,
    promptVersion: 'run-search-interpreter/2026-10-12.2',
    reasonAccuracy: 0.7,
    unsettled: { caseIds: [], count: 0 },
    usage: {
      cachedInputTokens: 1_000,
      callsWithReasoningDetail: 59,
      callsWithUsage: 59,
      inputTokens: 50_000,
      outputTokens: 3_000,
      reasoningTokens: 1_200,
    },
  };

  it('states model, prompt and dataset versions, counts, accuracy, field errors, latency, usage and failures', () => {
    const text = formatEvaluationReport(report);
    for (const fragment of [
      'gpt-4.1-mini',
      'run-search-interpreter/2026-10-12.2',
      'dataset v1',
      '60 cases',
      'Outcome accuracy: 90.0%',
      'Exact filter accuracy: 80.0%',
      'Reason accuracy: 70.0%',
      'period 3',
      'p95 1900 ms',
      'input 50000',
      'timeout 1',
      'en-this-month-plain',
    ]) {
      expect(text, fragment).toContain(fragment);
    }
  });

  it('gives every accuracy with its numerator and denominator, and each language separately', () => {
    const text = formatEvaluationReport(report);
    for (const fragment of [
      'Outcome accuracy: 90.0% (54/60)',
      'Reason accuracy: 70.0% (19/30',
      'Exact filter accuracy: 80.0% (25/30',
      'en: 50 cases, outcome 46/50, reason 15/25, exact filters 20/25, failures 1',
      'ru: 10 cases, outcome 8/10, reason 4/5, exact filters 5/5, failures 0',
      'Accepted as a search although a clarification or an unsupported answer was expected: 1 of 30 (en-location)',
      'clarify: 1 / 9 / 0 / 0',
      'reasoning 1200',
      'cached 1000',
      'Cost is not calculated',
    ]) {
      expect(text, fragment).toContain(fragment);
    }
  });

  it('says that a run which did not cover the dataset is partial, and why a stopped run is not a measurement', () => {
    expect(formatEvaluationReport(report)).not.toContain('PARTIAL');
    const partial = formatEvaluationReport({ ...report, executedCount: 5, partial: true });
    expect(partial).toContain('PARTIAL: 5 of 60 cases');
    const stopped = formatEvaluationReport({
      ...report,
      aborted: { afterCases: 3, consecutive: 3, reason: 'provider_error' },
      executedCount: 3,
      partial: true,
    });
    expect(stopped).toContain('STOPPED EARLY');
    expect(stopped).toContain('3 identical failures in a row (provider_error)');
    expect(stopped).toContain('not a measurement');
  });

  it('names the operations that outlived their cancellation and says that no case was started beside them', () => {
    expect(formatEvaluationReport(report)).not.toContain('UNSETTLED');
    const text = formatEvaluationReport({
      ...report,
      executedCount: 1,
      partial: true,
      unsettled: { caseIds: ['en-this-month-plain'], count: 1 },
    });
    expect(text).toContain('PARTIAL: 1 of 60 cases');
    expect(text).toContain('UNSETTLED: 1 interpreter operation(s) had not ended');
    expect(text).toContain('en-this-month-plain');
  });

  it('says the provider, runtime and generation settings when it is given the run description', () => {
    const local = describeEvaluationRun({
      args: {
        caseIds: undefined,
        concurrency: 1,
        dryRun: false,
        failOnMismatch: false,
        live: true,
        maxCases: 5,
        out: undefined,
      },
      config: loadLiveEvaluationConfig({ RUN_SEARCH_AI_MODEL: 'qwen3:8b', RUN_SEARCH_AI_PROVIDER: 'ollama' }),
      openaiSdkVersion: '7.22.0',
      runtimeVersion: '0.35.1',
    });
    const text = formatEvaluationReport({ ...report, model: 'qwen3:8b' }, local);
    expect(text).toContain('Provider: ollama (local runtime ollama 0.35.1)');
    expect(text).toContain('Generation: ');
    expect(text).toContain('temperature 0');
    expect(text).toContain('think false');
    expect(text).toContain('num_ctx 4096');
    expect(text.toLowerCase()).not.toContain('openai');
    // Without a description the text is the one it always was: no provider line is invented.
    expect(formatEvaluationReport(report)).not.toContain('Provider:');
  });

  it('says plainly that a run of this kind is one model on one day, and not a guarantee', () => {
    expect(formatEvaluationReport(report)).toMatch(/not a guarantee|one model|this run only/iu);
  });
});

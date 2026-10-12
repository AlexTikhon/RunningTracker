import { describe, expect, it } from 'vitest';

import {
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
      live: true,
      maxCases: undefined,
      out: undefined,
    });
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

  it('ignores a fake provider and the enabling flag: a live run is always the real provider', () => {
    expect(
      loadLiveEvaluationConfig({ ...ok, RUN_SEARCH_AI_ENABLED: 'false', RUN_SEARCH_AI_PROVIDER: 'fake' }),
    ).toMatchObject({ provider: 'openai' });
  });

  it('uses the same bounds as the application', () => {
    expect(() => loadLiveEvaluationConfig({ ...ok, RUN_SEARCH_AI_TIMEOUT_MS: '60000' })).toThrow();
    expect(loadLiveEvaluationConfig({ ...ok, RUN_SEARCH_AI_TIMEOUT_MS: '8000' }).timeoutMs).toBe(8_000);
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

  it('says plainly that a run of this kind is one model on one day, and not a guarantee', () => {
    expect(formatEvaluationReport(report)).toMatch(/not a guarantee|one model|this run only/iu);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { weeklyInsightModelOutputSchema } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { validateModelOutput } from '../insights/insight-generator.js';
import { evaluationCases, validationCases, type CaseResult } from './weekly-insight-evaluation.js';

// The weekly insight prompt experiment of 2026-11-07 (docs/reports/weekly-insights-model-evaluation-2026-11-07.md).
// Its raw answers are tracked under docs/reports/artifacts/weekly-insights-prompt-experiment-2026-11-07. This re-checks
// every stored answer against the CURRENT production checks, with no model call: if a later change of the schema,
// grounding, prose rules or safety screen moves any measured result, this fails and the report must be revisited.

const directory = new URL('../../../../docs/reports/artifacts/weekly-insights-prompt-experiment-2026-11-07/', import.meta.url);

interface Report {
  callBudget?: { limit: number; refused: number; used: number };
  caseSet?: string;
  perModel: Record<string, CaseResult[]>;
  promptVersion: string;
}

const read = (name: string): Report => JSON.parse(readFileSync(fileURLToPath(new URL(name, directory)), 'utf8')) as Report;

const aggregates = new Map([...evaluationCases(), ...validationCases()].map((entry) => [entry.id, entry.aggregate]));

function statuses(report: Report, model: string): Record<string, string> {
  return Object.fromEntries(
    report.perModel[model]!.map((result) => {
      if (result.modelOutput === null) return [result.id, result.status];
      const validated = validateModelOutput(weeklyInsightModelOutputSchema.parse(result.modelOutput), aggregates.get(result.id)!);
      return [result.id, validated.status];
    }),
  );
}

const readyCount = (byCase: Record<string, string>) => Object.values(byCase).filter((status) => status === 'ready').length;

describe('weekly insight prompt experiment, stored answers re-checked (2026-11-07)', () => {
  const baseline = read('baseline-weekly-insight-v2-development-2026-11-07T09-15-09-992Z.json');
  const runs = [
    read('run1-weekly-insight-v3-development-qwen3-4b-2026-11-07T16-37-06-239Z.json'),
    read('run2-weekly-insight-v4-development-qwen3-4b-2026-11-07T16-47-23-161Z.json'),
    read('run3-weekly-insight-v4-validation-qwen3-4b-2026-11-07T16-58-38-599Z.json'),
    read('run4-weekly-insight-v4-validation-qwen3-8b-2026-11-07T17-13-12-517Z.json'),
  ] as const;

  it('reproduces the baseline and every measured run under the unchanged checks', () => {
    expect(readyCount(statuses(baseline, 'qwen3:4b'))).toBe(0);
    expect(readyCount(statuses(baseline, 'qwen3:8b'))).toBe(1);
    expect(readyCount(statuses(runs[0], 'qwen3:4b'))).toBe(1);
    expect(readyCount(statuses(runs[1], 'qwen3:4b'))).toBe(5);
    expect(readyCount(statuses(runs[2], 'qwen3:4b'))).toBe(1);
    const final = statuses(runs[3], 'qwen3:8b');
    expect(readyCount(final)).toBe(8);
    expect(Object.entries(final).filter(([, status]) => status !== 'ready').map(([id]) => id)).toEqual([
      'val_mood_soreness_only',
      'val_activities_no_check_ins',
    ]);
  });

  it('stays within the experiment budget of 40 provider calls, every call recorded', () => {
    expect(runs.map((run) => [run.promptVersion, run.caseSet])).toEqual([
      ['weekly-insight-v3', 'development'],
      ['weekly-insight-v4', 'development'],
      ['weekly-insight-v4', 'validation'],
      ['weekly-insight-v4', 'validation'],
    ]);
    const calls = runs.flatMap((run) => Object.values(run.perModel).flatMap((results) => results.flatMap((result) => result.calls ?? [])));
    expect(calls).toHaveLength(40);
    expect(runs.reduce((sum, run) => sum + run.callBudget!.used, 0)).toBe(40);
    expect(runs.every((run) => run.callBudget!.refused === 0)).toBe(true);
    expect(calls.filter((call) => !call.ok)).toEqual([]);
  });
});

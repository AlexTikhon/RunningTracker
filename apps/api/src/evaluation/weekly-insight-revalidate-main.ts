import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { weeklyInsightModelOutputSchema } from '@running-tracker/contracts';

import { validateModelOutput } from '../insights/insight-generator.js';
import { evaluationCases, validationCases, type CaseResult } from './weekly-insight-evaluation.js';

// Re-checks the model answers stored in an evaluation report against the CURRENT grounding and safety rules, without
// asking any model again (ADR-0076). Used when a rule changes after a measured run, so that the effect of the change on
// real answers is reported separately from the run itself. Answers that never reached the schema are not in the report
// and keep their status.
//   node --import tsx src/evaluation/weekly-insight-revalidate-main.ts <report.json>

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error('Pass the path of an evaluation report (.json)');
  const report = JSON.parse(await readFile(path, 'utf8')) as { perModel: Record<string, CaseResult[]> };
  const cases = new Map([...evaluationCases(), ...validationCases()].map((entry) => [entry.id, entry.aggregate]));
  for (const [model, results] of Object.entries(report.perModel)) {
    const statuses: Record<string, number> = {};
    const changes: string[] = [];
    for (const result of results) {
      let status: string = result.status;
      const aggregate = cases.get(result.id);
      if (result.modelOutput !== null && aggregate) {
        const validated = validateModelOutput(weeklyInsightModelOutputSchema.parse(result.modelOutput), aggregate);
        status = validated.status;
        if (status !== result.status) {
          const kinds = validated.status === 'ready' ? [] : validated.grounding.map((violation) => `${violation.kind}:${violation.detail}`);
          changes.push(`${result.id}: ${result.status} -> ${status} ${kinds.join(', ')}`);
        }
      }
      statuses[status] = (statuses[status] ?? 0) + 1;
    }
    process.stdout.write(`${model}: ${JSON.stringify(statuses)}\n${changes.map((line) => `  ${line}`).join('\n')}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

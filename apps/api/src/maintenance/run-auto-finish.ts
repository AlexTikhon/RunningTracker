import type { Pool } from 'pg';

import type { Clock } from '../clock.js';
import { PeriodicRunner, type PeriodicRunnerOptions } from './periodic-runner.js';

interface AutoFinishResultRow {
  finished_count: number;
}

export async function runAutoFinishOnce(
  pool: Pick<Pool, 'query'>,
  clock: Pick<Clock, 'utcNow'>,
): Promise<number> {
  const effectiveNow = clock.utcNow();
  if (!Number.isFinite(effectiveNow.getTime())) {
    throw new Error('The maintenance clock returned an invalid UTC time');
  }

  const result = await pool.query<AutoFinishResultRow>(
    'SELECT app_private.auto_finish_runs($1::timestamptz) AS finished_count',
    [effectiveNow.toISOString()],
  );
  const finishedCount = result.rows[0]?.finished_count;
  if (
    typeof finishedCount !== 'number' ||
    !Number.isInteger(finishedCount) ||
    finishedCount < 0
  ) {
    throw new Error('The auto-finish function returned an invalid result');
  }
  return finishedCount;
}

export type RunAutoFinishRunnerOptions = Omit<PeriodicRunnerOptions, 'taskName'> & {
  runOnce: () => Promise<number>;
};

export class RunAutoFinishRunner extends PeriodicRunner {
  public constructor(options: RunAutoFinishRunnerOptions) {
    super({ ...options, taskName: 'Run auto-finish' });
  }
}

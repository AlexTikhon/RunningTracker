import { describe, expect, it, vi } from 'vitest';

import {
  purgeRunRawPointsBatch,
  RUN_RAW_PURGE_BATCH_LIMIT,
} from './run-raw-purge.js';

const orgId = 'a6500000-0000-4000-8000-000000000001';
const runId = 'a6500000-0000-4000-8000-000000000002';

describe('P10.1 raw point purge maintenance boundary', () => {
  it('invokes exactly one bounded database purge unit and maps its state', async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          completed: false,
          current_raw_state: 'purging',
          deleted_count: RUN_RAW_PURGE_BATCH_LIMIT,
          has_more: true,
          previous_raw_state: 'available',
        },
      ],
    });

    await expect(
      purgeRunRawPointsBatch({ query }, orgId, runId),
    ).resolves.toEqual({
      completed: false,
      currentRawState: 'purging',
      deletedCount: RUN_RAW_PURGE_BATCH_LIMIT,
      hasMore: true,
      previousRawState: 'available',
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('purge_run_raw_points_batch'), [
      orgId,
      runId,
      RUN_RAW_PURGE_BATCH_LIMIT,
    ]);
  });

  it.each([
    { rowCount: 0, rows: [] },
    {
      rowCount: 1,
      rows: [
        {
          completed: true,
          current_raw_state: 'purging',
          deleted_count: 0,
          has_more: false,
          previous_raw_state: 'available',
        },
      ],
    },
    {
      rowCount: 1,
      rows: [
        {
          completed: true,
          current_raw_state: 'purged',
          deleted_count: RUN_RAW_PURGE_BATCH_LIMIT + 1,
          has_more: false,
          previous_raw_state: 'purging',
        },
      ],
    },
  ])('rejects malformed database result %#', async (databaseResult) => {
    const query = vi.fn().mockResolvedValue(databaseResult);

    await expect(
      purgeRunRawPointsBatch({ query }, orgId, runId),
    ).rejects.toThrow('The raw purge function returned an invalid result');
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { Clock } from '../clock.js';
import { runSummaryPublicationOnce } from './run-summary-publication.js';

const clock: Pick<Clock, 'utcNow'> = {
  utcNow: () => new Date('2026-09-26T18:30:00.000Z'),
};

describe('runSummaryPublicationOnce', () => {
  it('returns idle without starting calculation when no candidate exists', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });

    await expect(runSummaryPublicationOnce({ query } as never, clock)).resolves.toEqual({
      status: 'idle',
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain('find_stale_run_summaries(1)');
  });

  it('calculates and publishes exactly the revision returned by discovery', async () => {
    const candidate = {
      algorithm_version: 'v1',
      org_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      run_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      source_revision: '7',
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [{ archive_revision: '12', published: true }] });

    await expect(runSummaryPublicationOnce({ query } as never, clock)).resolves.toEqual({
      algorithmVersion: 'v1',
      archiveRevision: '12',
      orgId: candidate.org_id,
      runId: candidate.run_id,
      sourceRevision: '7',
      status: 'published',
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain('MATERIALIZED');
    expect(query.mock.calls[1]?.[0]).toContain('app_private.publish_run_summary');
    expect(query.mock.calls[1]?.[1]).toEqual([
      candidate.org_id,
      candidate.run_id,
      '7',
      'v1',
      '2026-09-26T18:30:00.000Z',
    ]);
  });

  it('reports a stale calculation without treating it as an error', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            algorithm_version: 'v1',
            org_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            run_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            source_revision: '7',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ archive_revision: '11', published: false }] });

    await expect(runSummaryPublicationOnce({ query } as never, clock)).resolves.toMatchObject({
      archiveRevision: '11',
      status: 'stale',
    });
  });

  it('rejects malformed database results and an invalid clock', async () => {
    const invalidCandidateQuery = vi.fn().mockResolvedValue({
      rows: [
        {
          algorithm_version: 'v1',
          org_id: 'org',
          run_id: 'run',
          source_revision: '-1',
        },
      ],
    });
    await expect(
      runSummaryPublicationOnce({ query: invalidCandidateQuery } as never, clock),
    ).rejects.toThrow('summary candidate function returned an invalid result');

    await expect(
      runSummaryPublicationOnce(
        { query: vi.fn() } as never,
        { utcNow: () => new Date(Number.NaN) },
      ),
    ).rejects.toThrow('maintenance clock returned an invalid UTC time');
  });
});

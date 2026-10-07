import type { RunView } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { createInitialRunnerState, type RunnerState } from './runner-state.js';
import { unsentWorkNote } from './unsent-work.js';

const run: RunView = {
  controlRevision: '0',
  dataRevision: '0',
  finishedAt: null,
  rawState: 'available',
  runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  startedAt: '2026-10-06T08:00:00.000Z',
  status: 'recording',
  summary: null,
};

const idle = createInitialRunnerState('online');

describe('unsentWorkNote', () => {
  it('has nothing to say when nothing is left behind', () => {
    expect(unsentWorkNote(idle)).toBeNull();
    expect(unsentWorkNote({ ...idle, run: { ...run, finishedAt: '2026-10-06T08:30:00.000Z', status: 'finished' } })).toBeNull();
  });

  it('warns that an unfinished run stops recording', () => {
    for (const status of ['recording', 'paused'] as const) {
      expect(unsentWorkNote({ ...idle, run: { ...run, status } })).toContain('stops recording');
    }
  });

  it.each<[string, Partial<RunnerState>]>([
    ['buffered points', { upload: { message: null, pendingCount: 3, status: 'idle' } }],
    ['a rejected queue', { upload: { message: 'rejected', pendingCount: 0, status: 'blocked' } }],
    ['an unconfirmed request', { error: { message: 'x', request: { kind: 'start', orgId: 'a', runId: 'b', startedAt: 'c' } } }],
  ])('says unsent data stays on the device for %s', (_name, change) => {
    const note = unsentWorkNote({ ...idle, ...change });
    expect(note).toContain('stays on this device');
    expect(note).not.toContain('stops recording');
  });
});

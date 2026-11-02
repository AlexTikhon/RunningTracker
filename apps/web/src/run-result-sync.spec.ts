import { describe, expect, it } from 'vitest';

import { runResultSynchronization, type RunResultSynchronization } from './run-result-sync.js';

const settled: RunResultSynchronization = {
  connectivity: 'online', dataRevision: '2', upload: { message: null, pendingCount: 0, status: 'idle' }, writerOwned: true,
};

describe('finished result synchronization', () => {
  it('requires an empty idle buffer in the recording tab', () => {
    expect(runResultSynchronization(settled).settled).toBe(true);
    expect(runResultSynchronization({ ...settled, writerOwned: false }).settled).toBe(false);
  });

  it.each(['idle', 'uploading', 'retrying'] as const)('keeps %s buffered work incomplete', (status) => {
    const result = runResultSynchronization({ ...settled, upload: { message: null, pendingCount: 3, status } });
    expect(result.settled).toBe(false);
    expect(result.message).toContain('3 GPS measurements');
  });

  it('distinguishes offline retention from online catch-up', () => {
    const result = runResultSynchronization({ ...settled, connectivity: 'offline', upload: { message: null, pendingCount: 1, status: 'idle' } });
    expect(result.message).toContain('1 GPS measurement still');
    expect(result.message).toContain('connection returns');
    expect(result.settled).toBe(false);
  });

  it.each(['blocked', 'error', 'suspended'] as const)('never presents %s as complete, even with a zero count', (status) => {
    const result = runResultSynchronization({ ...settled, upload: { message: 'private provider error', pendingCount: 0, status } });
    expect(result).toMatchObject({ alert: true, settled: false });
    expect(result.message).toContain('Back to Runner');
    expect(result.message).not.toContain('private provider');
  });

  it('waits for an in-flight buffer check to settle', () => {
    expect(runResultSynchronization({ ...settled, upload: { message: null, pendingCount: 0, status: 'uploading' } }).settled).toBe(false);
  });
});

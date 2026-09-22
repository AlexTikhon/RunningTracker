import { describe, expect, it } from 'vitest';

import { nextRunStatus } from './run-service.js';

describe('run lifecycle state machine', () => {
  it('accepts only the lifecycle transitions defined by the SDD', () => {
    expect(nextRunStatus('recording', 'pause')).toBe('paused');
    expect(nextRunStatus('recording', 'resume')).toBeUndefined();
    expect(nextRunStatus('recording', 'finish')).toBe('finished');

    expect(nextRunStatus('paused', 'pause')).toBeUndefined();
    expect(nextRunStatus('paused', 'resume')).toBe('recording');
    expect(nextRunStatus('paused', 'finish')).toBe('finished');

    expect(nextRunStatus('finished', 'pause')).toBeUndefined();
    expect(nextRunStatus('finished', 'resume')).toBeUndefined();
    expect(nextRunStatus('finished', 'finish')).toBeUndefined();
  });
});

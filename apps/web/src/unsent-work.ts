import type { RunnerState } from './runner-state.js';

// What signing out leaves behind on this device, in words for the person; null when there is nothing to say.
// Nothing is deleted by signing out: the exact points and requests stay in this browser for the same person.
export function unsentWorkNote(runner: RunnerState): string | null {
  if (runner.run !== null && runner.run.status !== 'finished') {
    return 'Signing out stops recording. Unsent points stay on this device until you sign in again as the same person.';
  }
  if (
    runner.upload.pendingCount > 0
    || runner.upload.status === 'blocked'
    || runner.pendingRequest !== null
    || runner.error !== null
  ) {
    return 'Unsent data stays on this device until you sign in again as the same person.';
  }
  return null;
}

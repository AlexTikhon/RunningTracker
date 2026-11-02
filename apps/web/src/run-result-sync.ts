import type { Connectivity, UploadState } from './runner-state.js';

export interface RunResultSynchronization {
  connectivity: Connectivity;
  dataRevision: string;
  upload: UploadState;
  writerOwned: boolean;
}

// Publication alone cannot prove that the result includes this browser's buffered measurements.
// Re-evaluate on every upload/lease change, including while an older detail read is displayed.
export function runResultSynchronization(sync: RunResultSynchronization): {
  alert: boolean;
  message: string;
  settled: boolean;
} {
  if (sync.upload.status === 'blocked') {
    return { alert: true, message: 'GPS upload was rejected. Back to Runner to export or recover the measurements kept on this device.', settled: false };
  }
  if (!sync.writerOwned) {
    return { alert: false, message: 'This tab no longer owns synchronization. Back to Runner to check the recording tab and local measurements.', settled: false };
  }
  if (sync.upload.status === 'error' || sync.upload.status === 'suspended') {
    return { alert: true, message: 'GPS synchronization needs attention. Back to Runner to check the measurements kept on this device.', settled: false };
  }
  if (sync.upload.pendingCount > 0) {
    const count = sync.upload.pendingCount;
    const pending = `${count} GPS measurement${count === 1 ? '' : 's'} still on this device.`;
    const next = sync.connectivity === 'offline' ? 'Upload will continue when the connection returns.'
      : sync.upload.status === 'retrying' ? 'Upload is retrying. Keep this page open.' : 'Upload is continuing. Keep this page open.';
    return { alert: false, message: `${pending} ${next}`, settled: false };
  }
  if (sync.upload.status !== 'idle') {
    return { alert: false, message: 'Checking that all GPS measurements from this device have uploaded.', settled: false };
  }
  return { alert: false, message: 'No GPS measurements are waiting to upload from this device.', settled: true };
}

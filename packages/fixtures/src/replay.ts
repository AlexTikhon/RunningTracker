import type { PointInput } from '@running-tracker/contracts';

import type { GpsScenario, UploadResponse } from './scenarios.js';
import { VirtualClock, type VirtualTimerHandle } from './virtual-clock.js';

export interface CaptureReplayEvent {
  readonly atMs: number;
  readonly observedAt: string;
  readonly point: Readonly<PointInput>;
  readonly type: 'capture';
}

export interface UploadReplayEvent {
  readonly atMs: number;
  readonly attempt: number;
  readonly batchId: string;
  readonly observedAt: string;
  readonly points: readonly Readonly<PointInput>[];
  readonly response: UploadResponse;
  readonly type: 'upload-attempt';
}

export type GpsReplayEvent = CaptureReplayEvent | UploadReplayEvent;

export interface ScheduledScenarioReplay {
  cancel(): void;
  readonly completionMs: number;
}

export function scheduleGpsScenario(
  scenario: GpsScenario,
  clock: VirtualClock,
  emit: (event: GpsReplayEvent) => void,
): ScheduledScenarioReplay {
  if (clock.monotonicNow() !== 0) {
    throw new Error('scenario replay requires a fresh virtual clock at monotonic time zero');
  }
  if (clock.utcNow().toISOString() !== scenario.startAt) {
    throw new Error('virtual clock start must match scenario startAt');
  }

  const handles: VirtualTimerHandle[] = [];
  for (const capture of scenario.captures) {
    handles.push(
      clock.setTimeout(() => {
        emit(
          Object.freeze({
            atMs: capture.atMs,
            observedAt: clock.utcNow().toISOString(),
            point: capture.point,
            type: 'capture' as const,
          }),
        );
      }, capture.atMs),
    );
  }
  for (const upload of scenario.uploads) {
    handles.push(
      clock.setTimeout(() => {
        emit(
          Object.freeze({
            atMs: upload.atMs,
            attempt: upload.attempt,
            batchId: upload.batchId,
            observedAt: clock.utcNow().toISOString(),
            points: upload.points,
            response: upload.response,
            type: 'upload-attempt' as const,
          }),
        );
      }, upload.atMs),
    );
  }

  const completionMs = Math.max(
    0,
    ...scenario.captures.map(({ atMs }) => atMs),
    ...scenario.uploads.map(({ atMs }) => atMs),
  );
  return Object.freeze({
    cancel: () => {
      for (const handle of handles) clock.clearTimeout(handle);
    },
    completionMs,
  });
}

export function replayGpsScenario(scenario: GpsScenario): readonly GpsReplayEvent[] {
  const clock = new VirtualClock(scenario.startAt);
  const events: GpsReplayEvent[] = [];
  scheduleGpsScenario(scenario, clock, (event) => events.push(event));
  clock.runAll();
  return Object.freeze(events);
}

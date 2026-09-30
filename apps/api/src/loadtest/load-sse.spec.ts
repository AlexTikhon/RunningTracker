import { describe, expect, it } from 'vitest';

import { FreshLatencyTracker, SseFrameParser, SseObserver, type LiveObservation } from './load-sse.js';

const streamId = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const runA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function state(sequence: number, runs: { runId: string; seq: string | null; dataRevision?: string }[]): string {
  const payload = {
    algorithmVersion: 'v1',
    runs: runs.map((run) => ({
      dataRevision: run.dataRevision ?? '3',
      position:
        run.seq === null
          ? null
          : {
              accuracyM: 5,
              coordinates: [10, 20],
              quality: 'confirmed',
              recordedAt: '2032-01-01T00:00:00.000Z',
              seq: run.seq,
            },
      runId: run.runId,
      status: 'recording',
    })),
    sequence,
    serverTime: '2032-01-01T00:00:01.000Z',
    streamId,
  };
  return `event: live.state\ndata: ${JSON.stringify(payload)}\n\n`;
}

describe('SseFrameParser', () => {
  it('reassembles frames split at arbitrary byte boundaries and counts heartbeats', () => {
    const parser = new SseFrameParser();
    const text = `: heartbeat\n\nevent: live.state\ndata: {"a":1}\n\nevent: live.state\ndata: {"a":2}\n\n`;
    const events = [];
    let comments = 0;
    for (let index = 0; index < text.length; index += 7) {
      const result = parser.push(Buffer.from(text.slice(index, index + 7)));
      events.push(...result.events);
      comments += result.comments;
    }
    expect(events).toEqual([
      { data: '{"a":1}', event: 'live.state' },
      { data: '{"a":2}', event: 'live.state' },
    ]);
    expect(comments).toBe(1);
  });

  it('does not split a multi-byte character across chunks', () => {
    const parser = new SseFrameParser();
    const bytes = Buffer.from('event: x\ndata: é\n\n');
    const first = parser.push(bytes.subarray(0, 14));
    const second = parser.push(bytes.subarray(14));
    expect([...first.events, ...second.events]).toEqual([{ data: 'é', event: 'x' }]);
  });
});

describe('SseObserver', () => {
  it('parses live states into per-run observations and never keeps coordinates', () => {
    const seen: LiveObservation[] = [];
    const observer = new SseObserver(3, (observation) => seen.push(observation));
    observer.feed(state(0, [{ runId: runA, seq: '5' }, { runId: runB, seq: null }]), 100);
    observer.feed(state(1, [{ runId: runA, seq: '6', dataRevision: '9' }]), 250);

    expect(observer.counters).toMatchObject({ heartbeats: 0, protocolErrors: 0, statesReceived: 2 });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ observerIndex: 3, receivedAtMs: 100, sequence: 0 });
    expect(seen[0]?.runs.get(runA)).toEqual({ dataRevision: '3', seq: 5n });
    expect(seen[0]?.runs.get(runB)).toEqual({ dataRevision: '3', seq: null });
    expect(seen[1]?.runs.get(runA)).toEqual({ dataRevision: '9', seq: 6n });
    expect(JSON.stringify([...(seen[0]?.runs.keys() ?? [])])).not.toContain('coordinates');
  });

  it('flags malformed data, wrong event names, and sequence or stream discontinuities', () => {
    const observer = new SseObserver(0, () => undefined);
    observer.feed('event: live.state\ndata: not json\n\n', 1);
    observer.feed('event: other\ndata: {}\n\n', 2);
    observer.feed(state(0, []), 3);
    observer.feed(state(2, []), 4);
    expect(observer.counters.protocolErrors).toBe(3);
    expect(observer.counters.statesReceived).toBe(2);
  });

  it('keeps counting heartbeats', () => {
    const observer = new SseObserver(0, () => undefined);
    observer.feed(': heartbeat\n\n: heartbeat\n\n', 1);
    expect(observer.counters.heartbeats).toBe(2);
  });
});

describe('FreshLatencyTracker', () => {
  function observation(
    observerIndex: number,
    receivedAtMs: number,
    runs: [string, bigint | null][],
  ): LiveObservation {
    return {
      observerIndex,
      receivedAtMs,
      runs: new Map(runs.map(([runId, seq]) => [runId, { dataRevision: '1', seq }])),
      sequence: 0,
      streamId,
    };
  }

  it('records the first state at or beyond the point for every expected observer', () => {
    const tracker = new FreshLatencyTracker();
    tracker.register({ expectedObservers: [1, 2], measuredAtMs: 1_000, runId: runA, sampleId: 0, seq: 10n });

    tracker.observe(observation(1, 1_500, [[runA, 9n]]));
    expect(tracker.results()).toEqual([]);
    tracker.observe(observation(1, 2_000, [[runA, 10n]]));
    tracker.observe(observation(1, 2_500, [[runA, 11n]]));
    tracker.observe(observation(2, 3_100, [[runA, 12n]]));

    expect(tracker.results()).toEqual([
      { latencyMs: 1_000, observerIndex: 1, runId: runA, sampleId: 0, seq: '10' },
      { latencyMs: 2_100, observerIndex: 2, runId: runA, sampleId: 0, seq: '10' },
    ]);
    expect(tracker.unresolved()).toEqual([]);
  });

  it('resolves several pending points of one run from a single later state', () => {
    const tracker = new FreshLatencyTracker();
    tracker.register({ expectedObservers: [0], measuredAtMs: 1_000, runId: runA, sampleId: 0, seq: 10n });
    tracker.register({ expectedObservers: [0], measuredAtMs: 2_000, runId: runA, sampleId: 1, seq: 11n });
    tracker.observe(observation(0, 3_000, [[runA, 11n]]));
    expect(tracker.results().map((entry) => entry.latencyMs)).toEqual([2_000, 1_000]);
  });

  it('ignores observers that are not expected to see the run and reports what never arrived', () => {
    const tracker = new FreshLatencyTracker();
    tracker.register({ expectedObservers: [1], measuredAtMs: 0, runId: runA, sampleId: 7, seq: 3n });
    tracker.observe(observation(2, 10, [[runA, 3n]]));
    tracker.observe(observation(1, 20, [[runB, 99n]]));
    expect(tracker.results()).toEqual([]);
    expect(tracker.unresolved()).toEqual([{ observerIndex: 1, runId: runA, sampleId: 7, seq: '3' }]);
  });

  it('never records a negative latency when a state raced ahead of the clock reading', () => {
    const tracker = new FreshLatencyTracker();
    tracker.register({ expectedObservers: [0], measuredAtMs: 500, runId: runA, sampleId: 0, seq: 1n });
    tracker.observe(observation(0, 400, [[runA, 1n]]));
    expect(tracker.results()[0]?.latencyMs).toBe(0);
  });
});

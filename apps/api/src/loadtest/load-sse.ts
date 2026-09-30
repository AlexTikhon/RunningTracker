import { liveEventName, liveStateSchema } from '@running-tracker/contracts';
import { StringDecoder } from 'node:string_decoder';

export interface SseEvent {
  data: string;
  event: string;
}

/** Incremental `text/event-stream` parser: tolerates any chunking and counts comment (heartbeat) frames. */
export class SseFrameParser {
  readonly #decoder = new StringDecoder('utf8');
  #buffer = '';

  public push(chunk: Buffer | string): { comments: number; events: SseEvent[] } {
    this.#buffer += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
    this.#buffer = this.#buffer.replaceAll('\r\n', '\n');
    const events: SseEvent[] = [];
    let comments = 0;
    for (;;) {
      const boundary = this.#buffer.indexOf('\n\n');
      if (boundary < 0) {
        break;
      }
      const frame = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 2);
      let event = 'message';
      const data: string[] = [];
      let hasField = false;
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) {
          continue;
        }
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /u, '');
        if (field === 'event') {
          event = value;
          hasField = true;
        } else if (field === 'data') {
          data.push(value);
          hasField = true;
        }
      }
      if (hasField) {
        events.push({ data: data.join('\n'), event });
      } else {
        comments += 1;
      }
    }
    return { comments, events };
  }
}

/** What an observer's screen would show for one run. Coordinates are deliberately not retained. */
export interface ObservedRun {
  dataRevision: string;
  seq: bigint | null;
}

export interface LiveObservation {
  observerIndex: number;
  receivedAtMs: number;
  runs: Map<string, ObservedRun>;
  sequence: number;
  streamId: string;
}

export interface SseCounters {
  heartbeats: number;
  protocolErrors: number;
  statesReceived: number;
}

/** Parses the live-state stream of one observer and checks the per-stream sequence invariants. */
export class SseObserver {
  public readonly counters: SseCounters = { heartbeats: 0, protocolErrors: 0, statesReceived: 0 };
  readonly #parser = new SseFrameParser();
  #expectedSequence = 0;
  #streamId: string | undefined;

  public constructor(
    private readonly observerIndex: number,
    private readonly onState: (observation: LiveObservation) => void,
  ) {}

  public feed(chunk: Buffer | string, receivedAtMs: number): void {
    const { comments, events } = this.#parser.push(chunk);
    this.counters.heartbeats += comments;
    for (const event of events) {
      if (event.event !== liveEventName) {
        this.counters.protocolErrors += 1;
        continue;
      }
      let state;
      try {
        state = liveStateSchema.parse(JSON.parse(event.data));
      } catch {
        this.counters.protocolErrors += 1;
        continue;
      }
      this.counters.statesReceived += 1;
      if (
        state.sequence !== this.#expectedSequence ||
        (this.#streamId !== undefined && state.streamId !== this.#streamId)
      ) {
        this.counters.protocolErrors += 1;
      }
      this.#expectedSequence = state.sequence + 1;
      this.#streamId ??= state.streamId;
      const runs = new Map<string, ObservedRun>();
      for (const run of state.runs) {
        runs.set(run.runId, {
          dataRevision: run.dataRevision,
          seq: run.position ? BigInt(run.position.seq) : null,
        });
      }
      this.onState({
        observerIndex: this.observerIndex,
        receivedAtMs,
        runs,
        sequence: state.sequence,
        streamId: state.streamId,
      });
    }
  }
}

export interface FreshPointRegistration {
  expectedObservers: readonly number[];
  /** Client instant at which the fresh measurement was created, on the same clock as `receivedAtMs`. */
  measuredAtMs: number;
  runId: string;
  sampleId: number;
  seq: bigint;
}

export interface FreshLatencySample {
  latencyMs: number;
  observerIndex: number;
  runId: string;
  sampleId: number;
  seq: string;
}

export interface UnresolvedFreshPoint {
  observerIndex: number;
  runId: string;
  sampleId: number;
  seq: string;
}

interface PendingPoint {
  measuredAtMs: number;
  sampleId: number;
  seq: bigint;
}

/**
 * Correlates fresh points with the first live state on each expected observer whose position for that run
 * has reached the point's `seq`. Correlation is by run and sequence, never by wall-clock guessing.
 */
export class FreshLatencyTracker {
  readonly #pending = new Map<string, PendingPoint[]>();
  readonly #resolved: FreshLatencySample[] = [];

  public register(point: FreshPointRegistration): void {
    for (const observerIndex of point.expectedObservers) {
      const key = `${observerIndex}:${point.runId}`;
      const queue = this.#pending.get(key) ?? [];
      queue.push({ measuredAtMs: point.measuredAtMs, sampleId: point.sampleId, seq: point.seq });
      this.#pending.set(key, queue);
    }
  }

  public observe(observation: LiveObservation): void {
    for (const [runId, run] of observation.runs) {
      if (run.seq === null) {
        continue;
      }
      const queue = this.#pending.get(`${observation.observerIndex}:${runId}`);
      if (!queue) {
        continue;
      }
      const remaining: PendingPoint[] = [];
      for (const point of queue) {
        if (point.seq <= run.seq) {
          this.#resolved.push({
            latencyMs: Math.max(0, observation.receivedAtMs - point.measuredAtMs),
            observerIndex: observation.observerIndex,
            runId,
            sampleId: point.sampleId,
            seq: point.seq.toString(),
          });
        } else {
          remaining.push(point);
        }
      }
      if (remaining.length === 0) {
        this.#pending.delete(`${observation.observerIndex}:${runId}`);
      } else {
        this.#pending.set(`${observation.observerIndex}:${runId}`, remaining);
      }
    }
  }

  public results(): FreshLatencySample[] {
    return [...this.#resolved];
  }

  public unresolved(): UnresolvedFreshPoint[] {
    const unresolved: UnresolvedFreshPoint[] = [];
    for (const [key, queue] of this.#pending) {
      const separator = key.indexOf(':');
      const observerIndex = Number(key.slice(0, separator));
      const runId = key.slice(separator + 1);
      for (const point of queue) {
        unresolved.push({ observerIndex, runId, sampleId: point.sampleId, seq: point.seq.toString() });
      }
    }
    return unresolved;
  }
}

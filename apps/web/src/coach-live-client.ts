import {
  liveEventName,
  liveStateSchema,
  type LiveState,
} from '@running-tracker/contracts';

export type CoachConnectionStatus = 'connecting' | 'disconnected' | 'error' | 'live';

export interface CoachConnectionSnapshot {
  message: string | null;
  status: CoachConnectionStatus;
}

interface EventSourceLike {
  addEventListener(type: string, listener: EventListener): void;
  close(): void;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
}

export type CoachEventSourceFactory = (url: string) => EventSourceLike;
export type CoachReconnectScheduler = (callback: () => void, delayMs: number) => () => void;

export interface CoachLiveClientOptions {
  createEventSource?: CoachEventSourceFactory;
  now?: () => number;
  onConnection: (connection: CoachConnectionSnapshot) => void;
  onState: (state: LiveState) => void;
  orgId: string;
  reconnectDelaysMs?: readonly number[];
  scheduleReconnect?: CoachReconnectScheduler;
  sessionExpiresAt?: string;
}

const defaultEventSourceFactory: CoachEventSourceFactory = (url) => new EventSource(url);
const defaultReconnectDelaysMs = [1_000, 2_000, 4_000] as const;
const defaultReconnectScheduler: CoachReconnectScheduler = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export class CoachLiveClient {
  readonly #createEventSource: CoachEventSourceFactory;
  readonly #now: () => number;
  readonly #onConnection: CoachLiveClientOptions['onConnection'];
  readonly #onState: CoachLiveClientOptions['onState'];
  readonly #orgId: string;
  readonly #reconnectDelaysMs: readonly number[];
  readonly #scheduleReconnect: CoachReconnectScheduler;
  readonly #sessionExpiresAtMs: number | null;
  #cancelReconnect: (() => void) | null = null;
  #reconnectAttempt = 0;
  #source: EventSourceLike | null = null;
  #stopped = true;

  public constructor(options: CoachLiveClientOptions) {
    this.#createEventSource = options.createEventSource ?? defaultEventSourceFactory;
    this.#now = options.now ?? Date.now;
    this.#onConnection = options.onConnection;
    this.#onState = options.onState;
    this.#orgId = options.orgId;
    this.#reconnectDelaysMs = options.reconnectDelaysMs ?? defaultReconnectDelaysMs;
    this.#scheduleReconnect = options.scheduleReconnect ?? defaultReconnectScheduler;
    this.#sessionExpiresAtMs = options.sessionExpiresAt === undefined
      ? null
      : Date.parse(options.sessionExpiresAt);
  }

  public start(): void {
    if (this.#source !== null || this.#cancelReconnect !== null) {
      return;
    }
    this.#stopped = false;
    this.#reconnectAttempt = 0;
    this.#connect();
  }

  public retryNow(): void {
    this.#cancelReconnect?.();
    this.#cancelReconnect = null;
    this.#source?.close();
    this.#source = null;
    this.#stopped = false;
    this.#reconnectAttempt = 0;
    this.#connect();
  }

  #connect(): void {
    if (this.#stopped || this.#source !== null) {
      return;
    }
    this.#onConnection({ message: null, status: 'connecting' });
    let source: EventSourceLike;
    try {
      source = this.#createEventSource(
        `/api/orgs/${encodeURIComponent(this.#orgId)}/live`,
      );
    } catch {
      this.#onConnection({
        message: 'The browser could not open the live stream.',
        status: 'error',
      });
      return;
    }
    this.#source = source;
    source.onopen = () => {
      if (this.#source === source) {
        this.#onConnection({ message: null, status: 'live' });
      }
    };
    source.onerror = () => {
      if (this.#source !== source) {
        return;
      }
      source.close();
      this.#source = null;
      this.#onConnection({
        message: 'The live stream closed. Current and last-known positions were cleared.',
        status: 'disconnected',
      });
      this.#scheduleAutomaticReconnect();
    };
    source.addEventListener(liveEventName, ((event: MessageEvent<string>) => {
      if (this.#source !== source) {
        return;
      }
      try {
        const state = liveStateSchema.parse(JSON.parse(event.data));
        this.#reconnectAttempt = 0;
        this.#onState(state);
        this.#onConnection({ message: null, status: 'live' });
      } catch {
        source.close();
        this.#source = null;
        this.#onConnection({
          message: 'The server sent an invalid live-state event.',
          status: 'error',
        });
      }
    }) as EventListener);
  }

  public stop(): void {
    this.#stopped = true;
    this.#cancelReconnect?.();
    this.#cancelReconnect = null;
    this.#source?.close();
    this.#source = null;
  }

  #scheduleAutomaticReconnect(): void {
    if (this.#stopped || this.#sessionExpiresAtMs === null) {
      return;
    }
    const delayMs = this.#reconnectDelaysMs[this.#reconnectAttempt];
    if (
      delayMs === undefined
      || !Number.isFinite(this.#sessionExpiresAtMs)
      || this.#now() + delayMs >= this.#sessionExpiresAtMs
    ) {
      return;
    }
    this.#reconnectAttempt += 1;
    this.#cancelReconnect = this.#scheduleReconnect(() => {
      this.#cancelReconnect = null;
      this.#connect();
    }, delayMs);
  }
}

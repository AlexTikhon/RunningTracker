import { describe, expect, it, vi } from 'vitest';

import {
  CoachLiveClient,
  type CoachConnectionSnapshot,
} from './coach-live-client.js';

const orgId = '11111111-1111-4111-8111-111111111111';

class FakeEventSource {
  readonly listeners = new Map<string, EventListener>();
  closed = false;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  public addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  public close(): void {
    this.closed = true;
  }

  public emit(type: string, data: string): void {
    this.listeners.get(type)?.({ data } as MessageEvent<string>);
  }
}

function frame(): string {
  return JSON.stringify({
    algorithmVersion: 'track-v1',
    runs: [],
    sequence: 0,
    serverTime: '2026-09-27T10:00:00.000Z',
    streamId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
}

describe('CoachLiveClient', () => {
  it('opens one organization stream and parses strict live.state events', () => {
    const source = new FakeEventSource();
    const states = vi.fn();
    const connections: CoachConnectionSnapshot[] = [];
    const client = new CoachLiveClient({
      createEventSource: (url) => {
        expect(url).toBe(`/api/orgs/${orgId}/live`);
        return source;
      },
      onConnection: (connection) => connections.push(connection),
      onState: states,
      orgId,
    });

    client.start();
    source.emit('live.state', frame());

    expect(states).toHaveBeenCalledWith(expect.objectContaining({ sequence: 0 }));
    expect(connections.map(({ status }) => status)).toEqual(['connecting', 'live']);
  });

  it('closes instead of entering an unbounded native reconnect loop', () => {
    const source = new FakeEventSource();
    const onConnection = vi.fn();
    const client = new CoachLiveClient({
      createEventSource: () => source,
      onConnection,
      onState: vi.fn(),
      orgId,
    });

    client.start();
    source.onerror?.(new Event('error'));

    expect(source.closed).toBe(true);
    expect(onConnection).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'disconnected',
    }));
  });

  it('reconnects with a bounded schedule only while the same session can remain valid', () => {
    const first = new FakeEventSource();
    const second = new FakeEventSource();
    const sources = [first, second];
    const createEventSource = vi.fn(() => sources.shift()!);
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const client = new CoachLiveClient({
      createEventSource,
      now: () => Date.parse('2026-09-27T10:00:00.000Z'),
      onConnection: vi.fn(),
      onState: vi.fn(),
      orgId,
      reconnectDelaysMs: [1_000],
      scheduleReconnect: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return vi.fn();
      },
      sessionExpiresAt: '2026-09-27T10:00:10.000Z',
    });

    client.start();
    first.onerror?.(new Event('error'));

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(1_000);
    scheduled[0]?.callback();
    expect(createEventSource).toHaveBeenCalledTimes(2);
    expect(sources).toHaveLength(0);
  });

  it('does not schedule reconnect beyond session expiry', () => {
    const source = new FakeEventSource();
    const scheduleReconnect = vi.fn();
    const client = new CoachLiveClient({
      createEventSource: () => source,
      now: () => Date.parse('2026-09-27T10:00:00.000Z'),
      onConnection: vi.fn(),
      onState: vi.fn(),
      orgId,
      reconnectDelaysMs: [1_000],
      scheduleReconnect,
      sessionExpiresAt: '2026-09-27T10:00:00.500Z',
    });

    client.start();
    source.onerror?.(new Event('error'));

    expect(scheduleReconnect).not.toHaveBeenCalled();
  });

  it('fails closed when an event does not satisfy the shared contract', () => {
    const source = new FakeEventSource();
    const onConnection = vi.fn();
    const onState = vi.fn();
    const client = new CoachLiveClient({
      createEventSource: () => source,
      onConnection,
      onState,
      orgId,
    });

    client.start();
    source.emit('live.state', JSON.stringify({ sequence: 0 }));

    expect(source.closed).toBe(true);
    expect(onState).not.toHaveBeenCalled();
    expect(onConnection).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error' }));
  });
});

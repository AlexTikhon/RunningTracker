import type { LiveState, TrackPoint } from '@running-tracker/contracts';
import { describe, expect, it, vi } from 'vitest';

import { coachMapGeometry, type CoachMapGeometry } from './coach-map-geometry.js';
import {
  COACH_MARKER_LAYER_ID,
  COACH_MARKER_SOURCE_ID,
  COACH_RETAINED_TRACK_LINE_LAYER_ID,
  COACH_TRACK_LINE_LAYER_ID,
  COACH_TRACK_POINT_LAYER_ID,
  COACH_TRACK_SOURCE_ID,
  CoachMapController,
  type CoachMapPort,
  type CoachMapStatus,
} from './coach-map-source.js';
import { coachReducer, createInitialCoachState, type CoachState } from './coach-state.js';
import type { SelectedTrackSnapshot } from './selected-track-sync.js';

const runId = '11111111-1111-4111-8111-111111111111';
const streamId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function trackPoint(seq: string, longitude: number): TrackPoint {
  return {
    accuracyM: 5,
    connectFromPrevious: seq !== '1',
    coordinates: [longitude, 52],
    predecessorSeq: seq === '1' ? null : (BigInt(seq) - 1n).toString(),
    recordedAt: '2026-10-22T10:00:00.000Z',
    segmentId: 0,
    seq,
  };
}

const track: SelectedTrackSnapshot = {
  message: null,
  runId,
  status: 'ready',
  targetRevision: '2',
  track: { algorithmVersion: 'track-v1', points: [trackPoint('1', 21), trackPoint('2', 21.1)], revision: '2' },
};

function live(runs: LiveState['runs'], sequence: number): LiveState {
  return { algorithmVersion: 'track-v1', runs, sequence, serverTime: '2026-10-22T10:00:01.000Z', streamId };
}

function sharedRun(longitude = 21.1): LiveState['runs'][number] {
  return {
    dataRevision: '2',
    position: {
      accuracyM: 4,
      coordinates: [longitude, 52],
      quality: 'confirmed',
      recordedAt: '2026-10-22T10:00:00.000Z',
      seq: '2',
    },
    runId,
    status: 'recording',
  };
}

function receive(state: CoachState, runs: LiveState['runs'], sequence: number): CoachState {
  return coachReducer(state, { receivedAtMonotonicMs: 1_000, state: live(runs, sequence), type: 'state-received' });
}

const shared = receive(createInitialCoachState(), [sharedRun()], 0);
const selected = coachReducer(shared, { runId, type: 'track-toggled' });
const withTrack = coachMapGeometry(selected, [track], 1_000);
const markerOnly = coachMapGeometry(shared, [track], 1_000);
const revoked = coachMapGeometry(receive(selected, [], 1), [track], 1_000);

type Listener = (event: unknown) => void;

function fakeMap(styleLoaded = false) {
  const data = new Map<string, unknown>();
  const listeners = new Map<string, Set<Listener>>();
  const layers: string[] = [];
  const setData = vi.fn<(id: string, value: unknown) => void>();
  const port = {
    addLayer: vi.fn((layer: Record<string, unknown>) => {
      layers.push(String(layer['id']));
    }),
    addSource: vi.fn((id: string, source: Record<string, unknown>) => {
      data.set(id, source['data']);
    }),
    fitBounds: vi.fn(),
    getSource: (id: string) => data.has(id)
      ? {
          setData: (value: unknown) => {
            setData(id, value);
            data.set(id, value);
          },
        }
      : undefined,
    isStyleLoaded: () => styleLoaded,
    off: vi.fn((type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener);
    }),
    on: vi.fn((type: string, listener: Listener) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    }),
    remove: vi.fn(),
  } satisfies CoachMapPort;
  return {
    data,
    emit: (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener({ type });
    },
    layers,
    listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
    port,
    setData,
  };
}

function deferredFactory() {
  const pending: { resolve: (map: CoachMapPort) => void; reject: (error: Error) => void; signal: AbortSignal }[] = [];
  const createMap = vi.fn((signal: AbortSignal) => new Promise<CoachMapPort>((resolve, reject) => {
    pending.push({ reject, resolve, signal });
  }));
  return { createMap, pending };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function features(map: ReturnType<typeof fakeMap>, id: string): unknown[] {
  return (map.data.get(id) as { features: unknown[] }).features;
}

function controllerWith(session = new AbortController()) {
  const factory = deferredFactory();
  const statuses: CoachMapStatus[] = [];
  const controller = new CoachMapController({
    createMap: factory.createMap,
    onStatus: (status) => statuses.push(status),
    signal: session.signal,
  });
  return { controller, factory, session, statuses };
}

async function loadedController(geometry: CoachMapGeometry = withTrack) {
  const subject = controllerWith();
  const map = fakeMap();
  subject.controller.start();
  subject.controller.update(geometry);
  subject.factory.pending[0]!.resolve(map.port);
  await settle();
  map.emit('load');
  return { ...subject, map };
}

describe('coach map controller', () => {
  it('adds the sources and layers once and draws the current geometry', async () => {
    const { map, statuses } = await loadedController();

    expect(statuses).toEqual(['loading', 'ready']);
    expect(map.layers).toEqual([
      COACH_RETAINED_TRACK_LINE_LAYER_ID,
      COACH_TRACK_LINE_LAYER_ID,
      COACH_TRACK_POINT_LAYER_ID,
      COACH_MARKER_LAYER_ID,
    ]);
    expect(features(map, COACH_TRACK_SOURCE_ID)).toEqual([{
      geometry: { coordinates: [[21, 52], [21.1, 52]], type: 'LineString' },
      properties: { kind: 'line', label: 'Run #11111111', latest: true, revision: '2', runId },
      type: 'Feature',
    }]);
    expect(features(map, COACH_MARKER_SOURCE_ID)).toHaveLength(1);
  });

  it('replaces old geometry with the new geometry on update', async () => {
    const { controller, map } = await loadedController();
    const moved = coachMapGeometry(receive(selected, [sharedRun(21.3)], 1), [track], 1_000);

    controller.update(moved);

    expect(features(map, COACH_MARKER_SOURCE_ID)).toEqual([
      expect.objectContaining({ geometry: { coordinates: [21.3, 52], type: 'Point' } }),
    ]);
    expect(map.port.addSource).toHaveBeenCalledTimes(2);
  });

  it('removes the marker and the line when the run leaves the authorized state', async () => {
    const { controller, map } = await loadedController();

    controller.update(revoked);

    expect(features(map, COACH_MARKER_SOURCE_ID)).toEqual([]);
    expect(features(map, COACH_TRACK_SOURCE_ID)).toEqual([]);
  });

  it('removes only the track when the run is deselected', async () => {
    const { controller, map } = await loadedController();

    controller.update(markerOnly);

    expect(features(map, COACH_TRACK_SOURCE_ID)).toEqual([]);
    expect(features(map, COACH_MARKER_SOURCE_ID)).toHaveLength(1);
  });

  it('applies only the latest geometry when the map becomes usable late', async () => {
    const subject = controllerWith();
    const map = fakeMap();
    subject.controller.start();
    subject.controller.update(withTrack);
    subject.controller.update(revoked);
    subject.factory.pending[0]!.resolve(map.port);
    await settle();

    expect(map.port.addSource).not.toHaveBeenCalled();
    map.emit('load');

    expect(features(map, COACH_MARKER_SOURCE_ID)).toEqual([]);
    expect(features(map, COACH_TRACK_SOURCE_ID)).toEqual([]);
    expect(map.setData.mock.calls.flatMap(([, value]) => (value as { features: unknown[] }).features)).toEqual([]);
  });

  it('treats a map whose style is already loaded as usable at once', async () => {
    const subject = controllerWith();
    const map = fakeMap(true);
    subject.controller.start();
    subject.controller.update(withTrack);
    subject.factory.pending[0]!.resolve(map.port);
    await settle();

    expect(features(map, COACH_TRACK_SOURCE_ID)).toHaveLength(1);
  });

  it('removes a map that arrives after disposal and never draws on it', async () => {
    const subject = controllerWith();
    const map = fakeMap(true);
    subject.controller.start();
    subject.controller.update(withTrack);
    subject.controller.dispose();

    expect(subject.factory.pending[0]!.signal.aborted).toBe(true);
    subject.factory.pending[0]!.resolve(map.port);
    await settle();

    expect(map.port.remove).toHaveBeenCalledTimes(1);
    expect(map.port.addSource).not.toHaveBeenCalled();
    expect(map.port.on).not.toHaveBeenCalled();
  });

  it('keeps a StrictMode remount to one live map: the first instance is removed when it arrives', async () => {
    const session = new AbortController();
    const first = controllerWith(session);
    first.controller.start();
    first.controller.dispose();
    const second = controllerWith(session);
    second.controller.start();
    second.controller.update(withTrack);
    const firstMap = fakeMap(true);
    const secondMap = fakeMap(true);
    second.factory.pending[0]!.resolve(secondMap.port);
    first.factory.pending[0]!.resolve(firstMap.port);
    await settle();

    expect(firstMap.port.remove).toHaveBeenCalledTimes(1);
    expect(firstMap.port.addSource).not.toHaveBeenCalled();
    expect(secondMap.port.remove).not.toHaveBeenCalled();
    expect(features(secondMap, COACH_TRACK_SOURCE_ID)).toHaveLength(1);
  });

  it('removes the map and its listeners when the session ends, and ignores later updates', async () => {
    const { controller, map, session } = await loadedController();
    map.setData.mockClear();

    session.abort();
    controller.update(withTrack);
    map.emit('load');

    expect(map.port.remove).toHaveBeenCalledTimes(1);
    expect(map.listenerCount()).toBe(0);
    expect(map.setData).not.toHaveBeenCalled();
  });

  it('never creates a map for a session that has already ended', () => {
    const session = new AbortController();
    session.abort();
    const subject = controllerWith(session);

    subject.controller.start();

    expect(subject.factory.createMap).not.toHaveBeenCalled();
    expect(subject.statuses).toEqual([]);
  });

  it('keeps one map instance and the camera across updates; only the first geometry and the explicit fit move it', async () => {
    const { controller, factory, map } = await loadedController(coachMapGeometry(shared, [], 1_000));

    expect(map.port.fitBounds).toHaveBeenCalledTimes(1);
    controller.update(withTrack);
    controller.update(markerOnly);
    controller.update(revoked);
    controller.update(withTrack);

    expect(factory.createMap).toHaveBeenCalledTimes(1);
    expect(map.port.remove).not.toHaveBeenCalled();
    expect(map.port.fitBounds).toHaveBeenCalledTimes(1);

    expect(controller.fitVisible()).toBe(true);
    expect(map.port.fitBounds).toHaveBeenCalledTimes(2);
    expect(map.port.fitBounds).toHaveBeenLastCalledWith([[21, 52], [21.1, 52]], expect.objectContaining({ duration: 0 }));
  });

  it('does not fit before there is geometry and has nothing to fit afterwards', async () => {
    const { controller, map } = await loadedController(revoked);

    expect(map.port.fitBounds).not.toHaveBeenCalled();
    expect(controller.fitVisible()).toBe(false);
  });

  it('does not touch a source whose content is unchanged', async () => {
    const { controller, map } = await loadedController();
    map.setData.mockClear();

    controller.update(coachMapGeometry(selected, [track], 1_000));
    expect(map.setData).not.toHaveBeenCalled();

    controller.update(markerOnly);
    expect(map.setData.mock.calls.map(([id]) => id)).toEqual([COACH_TRACK_SOURCE_ID]);
  });

  it('reports a provider or browser failure without throwing', async () => {
    const subject = controllerWith();
    subject.controller.start();
    subject.factory.pending[0]!.reject(new Error('WebGL unavailable at https://example.invalid?access_token=pk.x'));
    await settle();

    expect(subject.statuses).toEqual(['loading', 'failed']);
  });

  it('reports an error before load as failed, recovers on load, and degrades after load', async () => {
    const subject = controllerWith();
    const map = fakeMap();
    subject.controller.start();
    subject.factory.pending[0]!.resolve(map.port);
    await settle();

    map.emit('error');
    map.emit('load');
    map.emit('error');

    expect(subject.statuses).toEqual(['loading', 'failed', 'ready', 'degraded']);
  });

  it('removes the map when an update cannot be applied, so old geometry cannot stay visible', async () => {
    const { controller, map, statuses } = await loadedController();
    map.port.getSource = () => ({ setData: () => { throw new Error('broken'); } });

    controller.update(revoked);

    expect(statuses.at(-1)).toBe('failed');
    expect(map.port.remove).toHaveBeenCalledTimes(1);
  });
});

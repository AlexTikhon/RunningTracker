import type { TrackPoint } from '@running-tracker/contracts';

import { markerForRun, type CoachMarkerQuality, type CoachState } from './coach-state.js';
import type { LiveTrackState } from './live-track-sync.js';
import type { SelectedTrackSnapshot } from './selected-track-sync.js';

export type LngLat = [longitude: number, latitude: number];
export type LngLatBounds = [southWest: LngLat, northEast: LngLat];

// A position with a coordinate. `unavailable` has none by definition, so it never reaches the map.
export type CoachMapMarkerQuality = Exclude<CoachMarkerQuality, 'unavailable'>;

export interface CoachMapMarkerProperties {
  label: string;
  quality: CoachMapMarkerQuality;
  runId: string;
}

// `latest` is true only when the drawn snapshot is the newest revision the stream has announced and the
// synchronization finished. Older committed geometry kept during a refresh or after a failure is `false`.
export interface CoachMapTrackProperties {
  kind: 'isolated' | 'line';
  label: string;
  latest: boolean;
  revision: string;
  runId: string;
}

export interface PointFeature<Properties> {
  geometry: { coordinates: LngLat; type: 'Point' };
  properties: Properties;
  type: 'Feature';
}

export interface LineFeature<Properties> {
  geometry: { coordinates: LngLat[]; type: 'LineString' };
  properties: Properties;
  type: 'Feature';
}

export interface FeatureCollection<Feature> {
  features: Feature[];
  type: 'FeatureCollection';
}

export type CoachMapTrackFeature =
  | LineFeature<CoachMapTrackProperties>
  | PointFeature<CoachMapTrackProperties>;

export interface CoachMapTrackStatus {
  label: string;
  // What is drawn: the committed revision, or null while the first snapshot is still being assembled.
  drawnRevision: string | null;
  latest: boolean;
  runId: string;
  status: SelectedTrackSnapshot['status'];
  targetRevision: string;
}

export interface CoachMapGeometry {
  bounds: LngLatBounds | null;
  markers: FeatureCollection<PointFeature<CoachMapMarkerProperties>>;
  markerCounts: Record<CoachMapMarkerQuality, number>;
  tracks: FeatureCollection<CoachMapTrackFeature>;
  // Identifies the track features exactly: a committed snapshot of one run, revision and algorithm never changes,
  // so equal keys mean equal features without comparing up to 50,000 points.
  tracksKey: string;
  trackStatuses: CoachMapTrackStatus[];
}

export interface TrackGeometry {
  // Points that no drawn connection touches: a first point, or one whose edge was rejected on both sides.
  isolated: LngLat[];
  lines: LngLat[][];
}

function compareSeq(left: TrackPoint, right: TrackPoint): number {
  const a = BigInt(left.seq);
  const b = BigInt(right.seq);
  return a < b ? -1 : a > b ? 1 : 0;
}

function coordinate(point: { coordinates: readonly [number, number] }): LngLat {
  return [point.coordinates[0], point.coordinates[1]];
}

// The server decides every connection (ADR-0019): a point joins the one before it only when it says so, names
// that exact point as its predecessor, and stays in the same capture segment. Nothing here re-evaluates an edge
// the server accepted, so a gap in sequence numbers alone never breaks a line.
function connects(previous: TrackPoint, point: TrackPoint): boolean {
  return point.connectFromPrevious
    && point.predecessorSeq !== null
    && BigInt(point.predecessorSeq) === BigInt(previous.seq)
    && point.segmentId === previous.segmentId;
}

export function trackGeometry(points: readonly TrackPoint[]): TrackGeometry {
  const ordered = [...points].sort(compareSeq);
  const lines: LngLat[][] = [];
  const isolated: LngLat[] = [];
  let current: LngLat[] = [];
  const flush = (): void => {
    if (current.length >= 2) {
      lines.push(current);
    } else if (current.length === 1) {
      isolated.push(current[0]!);
    }
    current = [];
  };

  ordered.forEach((point, index) => {
    const previous = index === 0 ? undefined : ordered[index - 1];
    if (previous === undefined || !connects(previous, point)) {
      flush();
    }
    current.push(coordinate(point));
  });
  flush();
  return { isolated, lines };
}

interface CommittedTrackGeometry {
  bounds: LngLatBounds | null;
  geometry: TrackGeometry;
}

// A committed snapshot is immutable and replaced as a whole, so its geometry is computed once, not on every
// freshness tick or live-state event.
const committedGeometry = new WeakMap<LiveTrackState, CommittedTrackGeometry>();

function geometryOf(track: LiveTrackState): CommittedTrackGeometry {
  let cached = committedGeometry.get(track);
  if (cached === undefined) {
    const geometry = trackGeometry(track.points);
    let bounds: LngLatBounds | null = null;
    for (const line of geometry.lines) {
      for (const point of line) bounds = extend(bounds, point);
    }
    for (const point of geometry.isolated) bounds = extend(bounds, point);
    cached = { bounds, geometry };
    committedGeometry.set(track, cached);
  }
  return cached;
}

function runLabel(runId: string): string {
  return `Run #${runId.slice(0, 8)}`;
}

function laterRevision(left: string, right: string): string {
  return BigInt(left) >= BigInt(right) ? left : right;
}

function extend(bounds: LngLatBounds | null, [longitude, latitude]: LngLat): LngLatBounds {
  if (bounds === null) {
    return [[longitude, latitude], [longitude, latitude]];
  }
  return [
    [Math.min(bounds[0][0], longitude), Math.min(bounds[0][1], latitude)],
    [Math.max(bounds[1][0], longitude), Math.max(bounds[1][1], latitude)],
  ];
}

// Everything the map may show, from the authorized live state and the synchronizer's committed snapshots only.
// The current run set is the boundary: a marker or a track for a run that is not in it is never produced, and a
// track is drawn only for a run that is also explicitly selected.
export function coachMapGeometry(
  state: CoachState,
  tracks: readonly SelectedTrackSnapshot[],
  nowMonotonicMs: number,
): CoachMapGeometry {
  const markers: PointFeature<CoachMapMarkerProperties>[] = [];
  const markerCounts: Record<CoachMapMarkerQuality, number> = { confirmed: 0, stale: 0, unconfirmed: 0 };
  const trackFeatures: CoachMapTrackFeature[] = [];
  const trackStatuses: CoachMapTrackStatus[] = [];
  const snapshots = new Map(tracks.map((track) => [track.runId, track]));
  const trackKeys: [string, string, string, boolean][] = [];
  let bounds: LngLatBounds | null = null;

  for (const run of state.runs) {
    const label = runLabel(run.runId);
    const marker = markerForRun(state, run, nowMonotonicMs);
    if (marker.position !== null && marker.quality !== 'unavailable') {
      const point = coordinate(marker.position);
      markers.push({
        geometry: { coordinates: point, type: 'Point' },
        properties: { label, quality: marker.quality, runId: run.runId },
        type: 'Feature',
      });
      markerCounts[marker.quality] += 1;
      bounds = extend(bounds, point);
    }

    const snapshot = snapshots.get(run.runId);
    if (!state.selectedTrackRunIds.has(run.runId) || snapshot === undefined) {
      continue;
    }
    const committed = snapshot.track !== null && snapshot.track.algorithmVersion === state.algorithmVersion
      ? snapshot.track
      : null;
    const targetRevision = laterRevision(snapshot.targetRevision, run.dataRevision);
    const latest = committed !== null
      && snapshot.status === 'ready'
      && BigInt(committed.revision) >= BigInt(targetRevision);
    trackStatuses.push({
      drawnRevision: committed?.revision ?? null,
      label,
      latest,
      runId: run.runId,
      status: snapshot.status,
      targetRevision,
    });
    if (committed === null) {
      continue;
    }
    const { bounds: trackBounds, geometry } = geometryOf(committed);
    const properties = { label, latest, revision: committed.revision, runId: run.runId };
    for (const line of geometry.lines) {
      trackFeatures.push({
        geometry: { coordinates: line, type: 'LineString' },
        properties: { ...properties, kind: 'line' },
        type: 'Feature',
      });
    }
    for (const point of geometry.isolated) {
      trackFeatures.push({
        geometry: { coordinates: point, type: 'Point' },
        properties: { ...properties, kind: 'isolated' },
        type: 'Feature',
      });
    }
    if (trackBounds !== null) {
      bounds = extend(extend(bounds, trackBounds[0]), trackBounds[1]);
    }
    trackKeys.push([run.runId, committed.algorithmVersion, committed.revision, latest]);
  }

  return {
    bounds,
    markerCounts,
    markers: { features: markers, type: 'FeatureCollection' },
    tracks: { features: trackFeatures, type: 'FeatureCollection' },
    tracksKey: JSON.stringify(trackKeys),
    trackStatuses,
  };
}

export function emptyCoachMapGeometry(): CoachMapGeometry {
  return {
    bounds: null,
    markerCounts: { confirmed: 0, stale: 0, unconfirmed: 0 },
    markers: { features: [], type: 'FeatureCollection' },
    tracks: { features: [], type: 'FeatureCollection' },
    tracksKey: '[]',
    trackStatuses: [],
  };
}

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  CoachLiveClient,
  type CoachConnectionSnapshot,
} from './coach-live-client.js';
import {
  coachReducer,
  createInitialCoachState,
  markerForRun,
} from './coach-state.js';
import {
  SelectedTrackSynchronizer,
  type SelectedTrackSnapshot,
} from './selected-track-sync.js';

const initialConnection: CoachConnectionSnapshot = {
  message: null,
  status: 'connecting',
};

function monotonicNow(): number {
  return typeof performance === 'undefined' ? 0 : performance.now();
}

function ageLabel(ageMs: number | null): string {
  if (ageMs === null) {
    return 'No usable position yet';
  }
  if (ageMs < 1_000) {
    return 'Updated now';
  }
  return `Updated ${Math.floor(ageMs / 1_000)}s ago`;
}

export interface CoachScreenProps {
  orgId: string;
  sessionExpiresAt: string;
  userId: string;
}

export function CoachScreen({ orgId, sessionExpiresAt, userId }: CoachScreenProps) {
  const [state, dispatch] = useReducer(coachReducer, undefined, createInitialCoachState);
  const [connection, setConnection] = useState(initialConnection);
  const [nowMonotonicMs, setNowMonotonicMs] = useState(monotonicNow);
  const [tracks, setTracks] = useState<readonly SelectedTrackSnapshot[]>([]);
  const liveClient = useRef<CoachLiveClient | null>(null);
  const trackSynchronizer = useRef<SelectedTrackSynchronizer | null>(null);

  useEffect(() => {
    const synchronizer = new SelectedTrackSynchronizer({
      onChange: setTracks,
      orgId,
      userId,
    });
    trackSynchronizer.current = synchronizer;
    setTracks([]);
    return () => {
      if (trackSynchronizer.current === synchronizer) {
        trackSynchronizer.current = null;
      }
      synchronizer.dispose();
    };
  }, [orgId, userId]);

  useEffect(() => {
    dispatch({ type: 'reset' });
    const client = new CoachLiveClient({
      onConnection: (next) => {
        setConnection(next);
        if (next.status === 'disconnected') {
          trackSynchronizer.current?.clear();
          dispatch({ type: 'connection-lost' });
        } else if (next.status === 'error') {
          trackSynchronizer.current?.clear();
          dispatch({ type: 'reset' });
        }
      },
      onState: (liveState) => {
        const receivedAtMonotonicMs = monotonicNow();
        setNowMonotonicMs(receivedAtMonotonicMs);
        dispatch({ receivedAtMonotonicMs, state: liveState, type: 'state-received' });
      },
      orgId,
      sessionExpiresAt,
    });
    liveClient.current = client;
    client.start();
    return () => {
      if (liveClient.current === client) {
        liveClient.current = null;
      }
      client.stop();
    };
  }, [orgId, sessionExpiresAt, userId]);

  useEffect(() => {
    const synchronizer = trackSynchronizer.current;
    if (
      synchronizer === null
      || state.algorithmVersion === null
      || state.sequence === null
      || state.serverTime === null
      || state.streamId === null
    ) {
      synchronizer?.clear();
      return;
    }
    synchronizer.reconcile({
      algorithmVersion: state.algorithmVersion,
      runs: state.runs.map((run) => ({
        dataRevision: run.dataRevision,
        position: run.currentPosition,
        runId: run.runId,
        status: run.status,
      })),
      sequence: state.sequence,
      serverTime: state.serverTime,
      streamId: state.streamId,
    }, state.selectedTrackRunIds);
  }, [state]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMonotonicMs(monotonicNow()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const tracksByRunId = useMemo(
    () => new Map(tracks.map((track) => [track.runId, track])),
    [tracks],
  );

  return (
    <section className="coach-shell" aria-labelledby="coach-title">
      <div className="coach-heading">
        <div>
          <p className="eyebrow">Coach console · P08.4</p>
          <h1 id="coach-title">Live runs,<br />without guesswork.</h1>
        </div>
        <div className={`stream-status stream-status--${connection.status}`} role="status">
          <span>{connection.status}</span>
          {state.serverTime !== null && <small>server {new Date(state.serverTime).toLocaleTimeString()}</small>}
        </div>
      </div>

      {(connection.status === 'disconnected' || connection.status === 'error') && (
        <section className="notice notice--error" role="alert">
          <div>
            <strong>Live view unavailable</strong>
            <span>{connection.message}</span>
          </div>
          <button onClick={() => liveClient.current?.retryNow()} type="button">
            Reconnect
          </button>
        </section>
      )}

      <div className="coach-grid">
        <section className="live-field" aria-label="Live run markers">
          <div className="live-field__header">
            <strong>Position board</strong>
            <span>{state.runs.length} authorized active {state.runs.length === 1 ? 'run' : 'runs'}</span>
          </div>
          {state.runs.length === 0 ? (
            <div className="coach-empty">
              {connection.status === 'live'
                ? 'No active runs are currently shared with this identity.'
                : 'Waiting for an authorized live-state snapshot…'}
            </div>
          ) : (
            <div className="marker-grid">
              {state.runs.map((run) => {
                const marker = markerForRun(state, run, nowMonotonicMs);
                return (
                  <article className={`marker-card marker-card--${marker.quality}`} key={run.runId}>
                    <div className="marker-card__topline">
                      <span className="marker-dot" aria-hidden="true" />
                      <strong>{marker.quality}</strong>
                      <span>{run.status}</span>
                    </div>
                    <p>Run #{run.runId.slice(0, 8)}</p>
                    {marker.position === null ? (
                      <code>Position unavailable</code>
                    ) : (
                      <code>
                        {marker.position.coordinates[1].toFixed(5)}, {marker.position.coordinates[0].toFixed(5)}
                      </code>
                    )}
                    <small>{ageLabel(marker.ageMs)} · revision {run.dataRevision}</small>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <aside className="track-picker" aria-label="Selected live tracks">
          <p className="track-picker__label">Track selection</p>
          <strong>{state.selectedTrackRunIds.size} selected</strong>
          <span>
            Selected tracks follow SSE revisions through one atomic synchronization per run.
          </span>
          <div className="track-picker__options">
            {state.runs.map((run) => {
              const track = tracksByRunId.get(run.runId);
              return (
              <label key={run.runId}>
                <input
                  checked={state.selectedTrackRunIds.has(run.runId)}
                  onChange={() => dispatch({ runId: run.runId, type: 'track-toggled' })}
                  type="checkbox"
                />
                <span>Run #{run.runId.slice(0, 8)}</span>
                <small>
                  {track === undefined
                    ? `rev ${run.dataRevision}`
                    : track.status === 'ready'
                      ? `${track.track?.points.length ?? 0} points · rev ${track.track?.revision}`
                      : track.status === 'loading'
                        ? `syncing rev ${track.targetRevision}`
                        : `sync failed · rev ${track.targetRevision}`}
                </small>
              </label>
              );
            })}
          </div>
        </aside>
      </div>
    </section>
  );
}

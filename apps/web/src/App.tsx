import { uuidSchema, type RunCommandType, type SessionResponse } from '@running-tracker/contracts';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';

import { loadHealth, type HealthSnapshot } from './health.js';
import { createRun, loadSession, RunnerApiError, sendRunCommand } from './runner-api.js';
import {
  availableCommands,
  createInitialRunnerState,
  runnerPhase,
  runnerReducer,
  type CommandRequest,
  type RunnerRequest,
  type StartRequest,
} from './runner-state.js';

type HealthState = HealthSnapshot | { api: 'checking'; database: 'checking' };
type SessionState =
  | { status: 'loading' }
  | { message: string; status: 'required' }
  | { session: SessionResponse; status: 'ready' };

const initialHealth: HealthState = { api: 'checking', database: 'checking' };

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  if (error instanceof RunnerApiError) {
    const reference = error.requestId === null ? '' : ` Reference ${error.requestId}.`;
    return `${error.message} (${error.code}).${reference}`;
  }
  return error instanceof Error ? error.message : 'The request failed for an unknown reason.';
}

function durationLabel(startedAt: string | undefined, finishedAt: string | null | undefined, now: number) {
  if (startedAt === undefined) {
    return '00:00:00';
  }
  const end = finishedAt === null ? now : Date.parse(finishedAt ?? startedAt);
  const elapsedSeconds = Math.max(0, Math.floor((end - Date.parse(startedAt)) / 1_000));
  const hours = Math.floor(elapsedSeconds / 3_600);
  const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
  const seconds = elapsedSeconds % 60;
  return [hours, minutes, seconds].map((value) => value.toString().padStart(2, '0')).join(':');
}

export function App() {
  const [health, setHealth] = useState<HealthState>(initialHealth);
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  const [orgId, setOrgId] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [runner, dispatch] = useReducer(
    runnerReducer,
    typeof navigator === 'undefined' || navigator.onLine !== false ? 'online' : 'offline',
    createInitialRunnerState,
  );

  const refreshHealth = useCallback(async (signal?: AbortSignal) => {
    try {
      setHealth(await loadHealth(signal));
    } catch (error) {
      if (!isAbortError(error)) {
        setHealth({ api: 'down', database: 'unknown' });
      }
    }
  }, []);

  const refreshSession = useCallback(async (signal?: AbortSignal) => {
    setSession({ status: 'loading' });
    try {
      setSession({ session: await loadSession(signal), status: 'ready' });
    } catch (error) {
      if (!isAbortError(error)) {
        setSession({
          message: 'Create the development session first, then retry. Production identity arrives in P12.',
          status: 'required',
        });
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshHealth(controller.signal);
    void refreshSession(controller.signal);
    return () => controller.abort();
  }, [refreshHealth, refreshSession]);

  useEffect(() => {
    const updateConnectivity = () => {
      dispatch({ connectivity: navigator.onLine ? 'online' : 'offline', type: 'connectivity-changed' });
    };
    window.addEventListener('online', updateConnectivity);
    window.addEventListener('offline', updateConnectivity);
    return () => {
      window.removeEventListener('online', updateConnectivity);
      window.removeEventListener('offline', updateConnectivity);
    };
  }, []);

  useEffect(() => {
    if (runner.run === null || runner.run.status === 'finished') {
      return undefined;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [runner.run]);

  const executeRequest = useCallback(
    async (request: RunnerRequest) => {
      if (session.status !== 'ready') {
        return;
      }
      dispatch({ request, type: 'request-started' });
      try {
        if (request.kind === 'start') {
          const run = await createRun(request, session.session.csrf);
          dispatch({ request, run, type: 'start-succeeded' });
          return;
        }
        const result = await sendRunCommand(request, session.session.csrf);
        dispatch({ request, result, type: 'command-succeeded' });
      } catch (error) {
        dispatch({ message: errorMessage(error), request, type: 'request-failed' });
      }
    },
    [session],
  );

  const normalizedOrgId = orgId.trim().toLowerCase();
  const validOrgId = uuidSchema.safeParse(normalizedOrgId).success;
  const phase = runnerPhase(runner);
  const busy = runner.pendingRequest !== null;
  const controlsDisabled = busy || runner.connectivity === 'offline' || session.status !== 'ready';
  const commands = runner.run === null ? [] : availableCommands(runner.run.status);
  const elapsed = useMemo(
    () => durationLabel(runner.run?.startedAt, runner.run?.finishedAt, now),
    [now, runner.run?.finishedAt, runner.run?.startedAt],
  );

  const start = () => {
    if (!validOrgId || controlsDisabled || runner.run !== null) {
      return;
    }
    const request: StartRequest = {
      kind: 'start',
      orgId: normalizedOrgId,
      runId: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
    };
    void executeRequest(request);
  };

  const command = (type: RunCommandType) => {
    if (runner.run === null || controlsDisabled) {
      return;
    }
    const request: CommandRequest = {
      commandId: crypto.randomUUID(),
      expectedControlRevision: runner.run.controlRevision,
      kind: 'command',
      orgId: normalizedOrgId,
      runId: runner.run.runId,
      type,
    };
    void executeRequest(request);
  };

  return (
    <main>
      <header className="topbar">
        <div className="brand" aria-label="Running Tracker">
          <span className="brand-mark" aria-hidden="true">RT</span>
          <span>Running Tracker</span>
        </div>
        <div className="service-health" aria-label="Service health">
          <StatusDot label="API" value={health.api} />
          <StatusDot label="DB" value={health.database} />
        </div>
      </header>

      <section className="runner-shell" aria-labelledby="runner-title">
        <div className="runner-copy">
          <p className="eyebrow">Runner console · P05.1</p>
          <h1 id="runner-title">Your run,<br />under control.</h1>
          <p className="lede">
            Lifecycle changes are confirmed by the server and tied to a control revision. GPS capture
            and the durable local queue join this screen in the next P05 slices.
          </p>
        </div>

        <section className="control-card" aria-label="Run controls">
          <div className="control-card__topline">
            <span className={`phase-badge phase-badge--${phase}`}>{phase}</span>
            <span className="run-id">{runner.run ? `#${runner.run.runId.slice(0, 8)}` : 'No active run'}</span>
          </div>

          <p className="timer" aria-label={`Elapsed time ${elapsed}`}>{elapsed}</p>
          <p className="timer-label">elapsed foreground session</p>

          {runner.run === null ? (
            <div className="start-panel">
              <label htmlFor="organization-id">Organization ID</label>
              <input
                aria-describedby="organization-help"
                autoComplete="off"
                id="organization-id"
                onChange={(event) => setOrgId(event.target.value)}
                placeholder="00000000-0000-4000-8000-000000000000"
                spellCheck={false}
                value={orgId}
              />
              <p id="organization-help">The server rechecks active membership inside the run transaction.</p>
              <button className="primary-action" disabled={!validOrgId || controlsDisabled} onClick={start} type="button">
                {phase === 'starting' ? 'Starting…' : 'Start run'}
              </button>
            </div>
          ) : (
            <div className="command-grid">
              {commands.includes('pause') && (
                <button disabled={controlsDisabled} onClick={() => command('pause')} type="button">
                  {phase === 'pausing' ? 'Pausing…' : 'Pause'}
                </button>
              )}
              {commands.includes('resume') && (
                <button disabled={controlsDisabled} onClick={() => command('resume')} type="button">
                  {phase === 'resuming' ? 'Resuming…' : 'Resume'}
                </button>
              )}
              {commands.includes('finish') && (
                <button className="finish-action" disabled={controlsDisabled} onClick={() => command('finish')} type="button">
                  {phase === 'finishing' ? 'Finishing…' : 'Finish'}
                </button>
              )}
              {runner.run.status === 'finished' && (
                <button className="primary-action" onClick={() => dispatch({ type: 'finished-run-cleared' })} type="button">
                  New run
                </button>
              )}
            </div>
          )}
        </section>
      </section>

      {runner.connectivity === 'offline' && (
        <section className="notice notice--offline" role="status">
          <strong>Offline</strong>
          <span>Server controls are paused. Durable command queueing begins in P05.2.</span>
        </section>
      )}

      {runner.error !== null && (
        <section className="notice notice--error" role="alert">
          <div><strong>Request not confirmed</strong><span>{runner.error.message}</span></div>
          <button
            disabled={runner.connectivity === 'offline' || session.status !== 'ready'}
            onClick={() => void executeRequest(runner.error!.request)}
            type="button"
          >
            Retry same request
          </button>
        </section>
      )}

      <section className="state-grid" aria-label="Runner state">
        <StateCard detail={runner.run?.status ?? 'Ready for a new run'} label="Recording" value={phase} />
        <StateCard
          detail={runner.connectivity === 'online' ? 'Server controls available' : 'Waiting for connection'}
          label="Network"
          value={runner.connectivity}
        />
        <StateCard
          detail={runner.upload.pendingCount === 0 ? 'No buffered points' : `${runner.upload.pendingCount} pending`}
          label="Upload"
          value={runner.upload.status}
        />
        <StateCard
          detail={runner.run ? `control rev ${runner.run.controlRevision}` : 'No server revision yet'}
          label="Server state"
          value={runner.error === null ? 'confirmed' : 'error'}
        />
      </section>

      <section className={`session-bar session-bar--${session.status}`} aria-live="polite">
        {session.status === 'loading' && <span>Checking session…</span>}
        {session.status === 'ready' && (
          <><span>Session ready · user {session.session.identity.userId.slice(0, 8)}</span><span>Expires {new Date(session.session.expiresAt).toLocaleTimeString()}</span></>
        )}
        {session.status === 'required' && (
          <><span>{session.message}</span><button onClick={() => void refreshSession()} type="button">Retry session</button></>
        )}
      </section>
    </main>
  );
}

function StatusDot({ label, value }: { label: string; value: string }) {
  return <span><i className={`dot dot--${value}`} aria-hidden="true" />{label} {value}</span>;
}

function StateCard({ detail, label, value }: { detail: string; label: string; value: string }) {
  return (
    <article className="state-card">
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}

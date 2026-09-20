import { useCallback, useEffect, useState } from 'react';

import { loadHealth, type HealthSnapshot } from './health.js';

type ViewState = HealthSnapshot | { api: 'checking'; database: 'checking' };

const initialState: ViewState = { api: 'checking', database: 'checking' };

export function App() {
  const [health, setHealth] = useState<ViewState>(initialState);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      setHealth(await loadHealth(signal));
      setCheckedAt(new Date());
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      setHealth({ api: 'down', database: 'unknown' });
      setCheckedAt(new Date());
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = window.setInterval(() => void refresh(), 5_000);

    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refresh]);

  return (
    <main>
      <section className="hero">
        <p className="eyebrow">Running Tracker · P01</p>
        <h1>Local foundation is connected.</h1>
        <p className="lede">
          React reaches Express through the same-origin <code>/api</code> proxy. Readiness is
          backed by a real PostgreSQL check.
        </p>
      </section>

      <section className="status-grid" aria-label="Service status">
        <StatusCard label="HTTP process" value={health.api} />
        <StatusCard label="PostgreSQL / PostGIS" value={health.database} />
      </section>

      <footer>
        <button type="button" onClick={() => void refresh()}>
          Check now
        </button>
        <span>{checkedAt ? `Updated ${checkedAt.toLocaleTimeString()}` : 'Checking services…'}</span>
      </footer>
    </main>
  );
}

function StatusCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="status-card">
      <span className={`indicator indicator--${value}`} aria-hidden="true" />
      <div>
        <h2>{label}</h2>
        <p>{value}</p>
      </div>
    </article>
  );
}

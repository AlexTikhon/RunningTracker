export interface HealthSnapshot {
  api: 'up' | 'down';
  database: 'up' | 'down' | 'unknown';
}

interface ReadinessResponse {
  checks?: {
    database?: 'up' | 'down';
  };
}

export async function loadHealth(signal?: AbortSignal): Promise<HealthSnapshot> {
  const requestOptions: RequestInit | undefined = signal ? { signal } : undefined;
  const [liveness, readiness] = await Promise.all([
    fetch('/api/health/live', requestOptions),
    fetch('/api/health/ready', requestOptions),
  ]);

  let database: HealthSnapshot['database'] = readiness.ok ? 'up' : 'down';
  try {
    const payload = (await readiness.json()) as ReadinessResponse;
    database = payload.checks?.database ?? database;
  } catch {
    database = readiness.ok ? 'unknown' : 'down';
  }

  return {
    api: liveness.ok ? 'up' : 'down',
    database,
  };
}

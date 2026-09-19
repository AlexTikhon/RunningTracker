export interface HealthResponse {
  status: 'ok' | 'not-ready';
  checks?: {
    database: 'up' | 'down';
  };
}


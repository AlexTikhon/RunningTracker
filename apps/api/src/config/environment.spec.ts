import { describe, expect, it } from 'vitest';

import { validateEnvironment } from './environment.js';

describe('validateEnvironment', () => {
  it('coerces bounded values and applies defaults', () => {
    const environment = validateEnvironment({
      DATABASE_URL: 'postgresql://user:password@127.0.0.1:5433/database',
      PORT: '3100',
    });

    expect(environment).toMatchObject({
      APP_ENV: 'development',
      DB_CONNECTION_TIMEOUT_MS: 2_000,
      DB_POOL_MAX: 10,
      PORT: 3_100,
    });
  });

  it('rejects startup without a PostgreSQL URL', () => {
    expect(() => validateEnvironment({})).toThrow('Invalid environment configuration');
    expect(() => validateEnvironment({ DATABASE_URL: 'https://example.com' })).toThrow(
      'DATABASE_URL must use the postgres or postgresql protocol',
    );
  });
});

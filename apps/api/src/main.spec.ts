import { describe, expect, it, vi } from 'vitest';

import { validateEnvironment } from './config/environment.js';
import { main } from './main.js';

describe('main startup ordering', () => {
  it('rejects production local auth before creating the database pool or listener', async () => {
    const createPool = vi.fn();

    await expect(
      main({
        createPool,
        loadConfig: () =>
          validateEnvironment({
            ALLOWED_ORIGINS: 'https://tracker.example',
            APP_ENV: 'production',
            DATABASE_URL:
              'postgresql://running_tracker_runtime:password@127.0.0.1:5433/running_tracker',
            MAINTENANCE_DATABASE_URL:
              'postgresql://running_tracker_maintenance:password@127.0.0.1:5433/running_tracker',
            LOCAL_AUTH_ENABLED: 'true',
            LOCAL_AUTH_USER_IDS: '11111111-1111-4111-8111-111111111111',
          }),
      }),
    ).rejects.toThrow('LOCAL_AUTH_ENABLED must be false in production');
    expect(createPool).not.toHaveBeenCalled();
  });
});

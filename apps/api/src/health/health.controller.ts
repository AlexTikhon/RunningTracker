import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';

interface HealthResponse {
  status: 'ok' | 'not-ready';
  checks?: {
    database: 'up' | 'down';
  };
}

@Controller('health')
export class HealthController {
  public constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Get('live')
  public liveness(): HealthResponse {
    return { status: 'ok' };
  }

  @Get('ready')
  public async readiness(): Promise<HealthResponse> {
    try {
      await this.database.ping();
      return { checks: { database: 'up' }, status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({
        checks: { database: 'down' },
        status: 'not-ready',
      } satisfies HealthResponse);
    }
  }
}

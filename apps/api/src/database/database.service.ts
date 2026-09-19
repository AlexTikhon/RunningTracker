import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';

import type { Environment } from '../config/environment.js';

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;

  public constructor(
    @Inject(ConfigService) config: ConfigService<Environment, true>,
  ) {
    this.pool = new Pool({
      application_name: 'running-tracker-api',
      connectionString: config.getOrThrow('DATABASE_URL', { infer: true }),
      connectionTimeoutMillis: config.getOrThrow('DB_CONNECTION_TIMEOUT_MS', { infer: true }),
      max: config.getOrThrow('DB_POOL_MAX', { infer: true }),
    });

    this.pool.on('error', (error) => {
      this.logger.error('Unexpected idle PostgreSQL client error', error.stack);
    });
  }

  public async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  public query<Row extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, [...values]);
  }

  public async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

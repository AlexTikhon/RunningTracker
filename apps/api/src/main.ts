import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import 'reflect-metadata';

import { AppModule } from './app.module.js';
import type { Environment } from './config/environment.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService<Environment, true>);
  const port = config.getOrThrow('PORT', { infer: true });

  app.enableShutdownHooks();
  app.setGlobalPrefix('api');

  await app.listen(port, '0.0.0.0');
  Logger.log(`API listening on http://127.0.0.1:${port}/api`, 'Bootstrap');
}

await bootstrap();


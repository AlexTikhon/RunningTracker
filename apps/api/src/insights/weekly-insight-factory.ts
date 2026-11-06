import type { Pool } from 'pg';

import type { Clock } from '../clock.js';
import type { Environment } from '../config/environment.js';
import type { WeeklyInsightsConfig } from '../config/weekly-insights-config.js';
import type { Logger } from '../observability/logger.js';
import { FakeProvider } from './fake-provider.js';
import type { LlmProvider } from './llm-provider.js';
import { OllamaProvider } from './ollama-provider.js';
import { WeeklyInsightService } from './weekly-insight-service.js';

/** Off: no queue work and no provider. These limits only matter when a provider exists. */
const disabledSettings = { maxOutputTokens: 800, maxPerPerson: 1, maxQueue: 0, timeoutMs: 60_000 };

/** The provider of the configured kind; exhaustive, with no fallback to another provider. */
export function createLlmProvider(config: WeeklyInsightsConfig): LlmProvider {
  switch (config.provider) {
    case 'fake':
      return new FakeProvider({ mode: config.fakeMode });
    case 'ollama':
      return new OllamaProvider({ baseUrl: config.baseUrl, maxResponseBytes: config.maxResponseBytes, model: config.model });
    default:
      return unsupported(config);
  }
}

function unsupported(config: never): never {
  throw new Error(`Unsupported weekly insights provider: ${String((config as { provider?: unknown }).provider).slice(0, 32)}`);
}

export function createWeeklyInsightService(options: {
  clock: Clock;
  config: Environment;
  logger: Logger;
  pool: Pick<Pool, 'connect'>;
  /** Replaces the configured provider (tests only, through the test-only app dependency). */
  provider?: LlmProvider;
}): WeeklyInsightService {
  const configured = options.config.WEEKLY_INSIGHTS;
  const provider = options.provider ?? (configured ? createLlmProvider(configured) : undefined);
  if (provider) options.logger.info('weekly_insights.enabled', { model: provider.model, reason: configured?.provider ?? 'test' });
  return new WeeklyInsightService({
    clock: options.clock,
    logger: options.logger,
    pool: options.pool,
    provider,
    settings: configured
      ? {
          maxOutputTokens: configured.maxOutputTokens,
          maxPerPerson: configured.maxPerPerson,
          maxQueue: configured.maxQueue,
          timeoutMs: configured.timeoutMs,
        }
      : { ...disabledSettings, maxQueue: provider ? 16 : 0, maxPerPerson: provider ? 2 : 1 },
  });
}

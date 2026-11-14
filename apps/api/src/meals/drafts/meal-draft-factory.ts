import type { Clock } from '../../clock.js';
import type { Environment } from '../../config/environment.js';
import type { MealDraftsConfig } from '../../config/meal-drafts-config.js';
import type { LlmProvider } from '../../insights/llm-provider.js';
import { OllamaProvider } from '../../insights/ollama-provider.js';
import type { ApiMetrics } from '../../observability/api-metrics.js';
import type { Logger } from '../../observability/logger.js';
import { InterpretationAdmission } from '../../runs/interpretation/interpretation-admission.js';
import { FakeMealDraftProvider } from './fake-meal-draft-provider.js';
import { MealDraftService } from './meal-draft-service.js';

/**
 * The provider of the configured mode, and only that one: exhaustive over the configuration union, no fallback. The
 * Ollama adapter is the weekly insight's (one non-streaming chat request with the JSON schema as `format`, a bounded
 * body, no redirect, one attempt, never a retry); only its destination rule and limits come from this feature's own
 * configuration.
 */
export function createMealDraftProvider(config: MealDraftsConfig): LlmProvider {
  switch (config.provider) {
    case 'fake':
      return new FakeMealDraftProvider();
    case 'ollama':
      return new OllamaProvider({ baseUrl: config.baseUrl, maxResponseBytes: config.maxResponseBytes, model: config.model });
    default:
      return unsupported(config);
  }
}

function unsupported(config: never): never {
  throw new Error(`Unsupported meal drafts provider: ${String((config as { provider?: unknown }).provider).slice(0, 32)}`);
}

export interface MealDraftFactoryOptions {
  clock: Clock;
  config: Environment;
  logger: Logger;
  metrics?: ApiMetrics['mealDrafts'];
  /** Replaces the configured provider. Only reachable through the test-only application dependency. */
  provider?: LlmProvider;
}

/** The service, or undefined when MEAL_DRAFTS_PROVIDER=off: then no provider object exists and the route answers 503. */
export function createMealDraftService({ clock, config, logger, metrics, provider }: MealDraftFactoryOptions): MealDraftService | undefined {
  const settings = config.MEAL_DRAFTS;
  if (settings === undefined) return undefined;
  const chosen = provider ?? createMealDraftProvider(settings);
  logger.info('meal_draft.enabled', { model: chosen.model, reason: settings.provider });
  return new MealDraftService({
    admission: new InterpretationAdmission({
      allowance: settings.allowance,
      clock,
      maxConcurrent: settings.maxConcurrent,
      maxUsers: settings.limiterMaxUsers,
      userRate: settings.userRate,
    }),
    clock,
    logger,
    maxOutputTokens: settings.maxOutputTokens,
    ...(metrics === undefined ? {} : { metrics }),
    provider: chosen,
    timeoutMs: settings.timeoutMs,
  });
}

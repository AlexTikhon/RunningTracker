import type { Clock } from '../../clock.js';
import type { RunSearchAiConfig } from '../../config/run-search-ai-config.js';
import type { Environment } from '../../config/environment.js';
import type { ApiMetrics } from '../../observability/api-metrics.js';
import type { Logger } from '../../observability/logger.js';
import { FakeInterpreter } from './fake-interpreter.js';
import { InterpretationAdmission } from './interpretation-admission.js';
import { InterpretationService } from './interpretation-service.js';
import type { RunSearchInterpreter } from './interpretation-types.js';
import { OllamaInterpreter } from './ollama-interpreter.js';
import { OpenAiInterpreter } from './openai-interpreter.js';

export interface InterpretationFactoryOptions {
  clock: Clock;
  config: Environment;
  /** Replaces the configured provider. Only reachable through the test-only application dependency. */
  interpreter?: RunSearchInterpreter;
  logger: Logger;
  metrics?: ApiMetrics['interpretation'];
}

/**
 * The adapter of the configured provider, and only that one. The selection is exhaustive over the configuration
 * union: a new provider does not compile until it is handled here, nothing falls back to another provider, and the
 * OpenAI client is built only when the configuration is the OpenAI one (which alone carries a credential).
 */
export function createInterpreter(ai: RunSearchAiConfig): RunSearchInterpreter {
  switch (ai.provider) {
    case 'fake':
      return new FakeInterpreter();
    case 'ollama':
      return new OllamaInterpreter({
        maxOutputTokens: ai.maxOutputTokens,
        maxResponseBytes: ai.maxResponseBytes,
        model: ai.model,
        timeoutMs: ai.timeoutMs,
      });
    case 'openai':
      return new OpenAiInterpreter({
        apiKey: ai.apiKey,
        maxOutputTokens: ai.maxOutputTokens,
        maxResponseBytes: ai.maxResponseBytes,
        model: ai.model,
        timeoutMs: ai.timeoutMs,
      });
    default:
      return unsupportedProvider(ai);
  }
}

function unsupportedProvider(ai: never): never {
  const provider = (ai as { provider?: unknown }).provider;
  throw new Error(`Unsupported run search interpreter provider: ${String(provider).slice(0, 32)}`);
}

/**
 * The interpretation service the application runs with, or undefined when the feature is off. When it is off no
 * provider client is built, no credential is read, and the route answers 503 INTERPRETATION_DISABLED.
 */
export function createInterpretationService({
  clock,
  config,
  interpreter,
  logger,
  metrics,
}: InterpretationFactoryOptions): InterpretationService | undefined {
  const ai = config.RUN_SEARCH_AI;
  if (ai === undefined) {
    return undefined;
  }

  const provider = interpreter ?? createInterpreter(ai);

  logger.info('run_search.interpretation.enabled', { model: provider.model, reason: ai.provider });

  return new InterpretationService({
    admission: new InterpretationAdmission({
      allowance: ai.allowance,
      clock,
      maxConcurrent: ai.maxConcurrent,
      maxUsers: ai.limiterMaxUsers,
      userRate: ai.userRate,
    }),
    clock,
    interpreter: provider,
    logger,
    ...(metrics === undefined ? {} : { metrics }),
    timeoutMs: ai.timeoutMs,
  });
}

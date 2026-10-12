import type { Clock } from '../../clock.js';
import type { Environment } from '../../config/environment.js';
import type { ApiMetrics } from '../../observability/api-metrics.js';
import type { Logger } from '../../observability/logger.js';
import { FakeInterpreter } from './fake-interpreter.js';
import { InterpretationAdmission } from './interpretation-admission.js';
import { InterpretationService } from './interpretation-service.js';
import type { RunSearchInterpreter } from './interpretation-types.js';
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

  const provider: RunSearchInterpreter =
    interpreter ??
    (ai.provider === 'fake'
      ? new FakeInterpreter()
      : new OpenAiInterpreter({
          apiKey: ai.apiKey as string,
          maxOutputTokens: ai.maxOutputTokens,
          maxResponseBytes: ai.maxResponseBytes,
          model: ai.model,
          timeoutMs: ai.timeoutMs,
        }));

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

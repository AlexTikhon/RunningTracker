export type DatabaseTimeoutKind = 'lock' | 'statement';

/**
 * Identifies the two PostgreSQL conditions raised by the runtime SQL budgets. Only the error itself is inspected,
 * never its `cause`: a wrapper such as TenantTransactionCommitError means the outcome is unknown, which must not
 * be reported as a clean, retryable timeout. Errors from callback queries reach the caller unwrapped.
 */
export function classifyDatabaseTimeout(error: unknown): DatabaseTimeoutKind | undefined {
  if (error === null || typeof error !== 'object') {
    return undefined;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  // 57014 is query_canceled, which a user cancel shares with a statement timeout; only the message tells them apart.
  if (code === '57014' && typeof message === 'string' && message.includes('statement timeout')) {
    return 'statement';
  }
  // 55P03 is lock_not_available. The application issues no NOWAIT, so here it is always lock_timeout.
  if (code === '55P03') {
    return 'lock';
  }
  return undefined;
}

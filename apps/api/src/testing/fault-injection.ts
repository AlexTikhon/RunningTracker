import type { IngestPointsResponse } from '@running-tracker/contracts';

export interface PointIngestionCommitContext {
  readonly orgId: string;
  readonly result: Readonly<IngestPointsResponse>;
  readonly runId: string;
}

export interface TestOnlyFaultInjector {
  shouldDropPointIngestionResponseAfterCommit(context: PointIngestionCommitContext): boolean;
}

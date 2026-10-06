import {
  apiErrorResponseSchema,
  archiveMetadataResponseSchema,
  ingestPointsResponseSchema,
  liveTrackResponseSchema,
  organizationListResponseSchema,
  runCommandResponseSchema,
  runViewSchema,
  sessionResponseSchema,
  type ArchiveMetadataResponse,
  type IngestPointsResponse,
  type LiveTrackResponse,
  type PointInput,
  type RunCommandResponse,
  type RunCommandType,
  type RunView,
  type SessionResponse,
} from '@running-tracker/contracts';

import { requestJson } from './request.js';

export interface CsrfCredentials {
  headerName: 'x-csrf-token';
  token: string;
}

export interface CreateRunInput {
  orgId: string;
  runId: string;
  startedAt: string;
}

export interface RunCommandInput {
  commandId: string;
  expectedControlRevision: string;
  orgId: string;
  runId: string;
  type: RunCommandType;
}

export interface PointBatchInput {
  orgId: string;
  points: PointInput[];
  runId: string;
}

export interface LiveTrackScope {
  orgId: string;
  runId: string;
}

export interface ArchiveMetadataInput {
  from: string;
  orgId: string;
  to: string;
}

export type LiveTrackSnapshotPageInput = LiveTrackScope & {
  cursor?: string;
};

export type LiveTrackChangesPageInput = LiveTrackScope &
  ({ afterRevision: string; cursor?: never } | { afterRevision?: never; cursor: string });

export class RunnerApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly requestId: string | null,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'RunnerApiError';
  }
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (value === null) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const deadline = Date.parse(value);
  return Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : null;
}

function requireSuccess({ response, payload }: { response: Response; payload: unknown }): unknown {
  if (response.ok) {
    return payload;
  }

  const parsed = apiErrorResponseSchema.safeParse(payload);
  if (parsed.success) {
    throw new RunnerApiError(
      parsed.data.error.message,
      response.status,
      parsed.data.error.code,
      parsed.data.error.requestId,
      retryAfterMs(response),
    );
  }

  throw new RunnerApiError(
    `The server returned HTTP ${response.status}.`,
    response.status,
    'HTTP_ERROR',
    null,
    retryAfterMs(response),
  );
}

function mutationHeaders(csrf: CsrfCredentials): HeadersInit {
  return {
    'content-type': 'application/json',
    [csrf.headerName]: csrf.token,
  };
}

export async function loadSession(signal?: AbortSignal): Promise<SessionResponse> {
  const options: RequestInit = { credentials: 'same-origin' };
  if (signal !== undefined) {
    options.signal = signal;
  }
  const response = await requestJson('/api/session', options);
  return sessionResponseSchema.parse(requireSuccess(response));
}

// The organizations this identity has an active membership in, as identifiers in the server's fixed order.
export async function loadOrganizations(signal?: AbortSignal): Promise<string[]> {
  const options: RequestInit = { credentials: 'same-origin' };
  if (signal !== undefined) {
    options.signal = signal;
  }
  const response = await requestJson('/api/organizations', options);
  return organizationListResponseSchema
    .parse(requireSuccess(response))
    .items.map((item) => item.organizationId);
}

// Ends the application session on the server; the answer clears the session cookie. This is not a logout at
// the identity provider (ADR-0046).
export async function endSession(csrf: CsrfCredentials, signal?: AbortSignal): Promise<void> {
  const response = await requestJson('/api/session', {
    credentials: 'same-origin',
    headers: { [csrf.headerName]: csrf.token },
    method: 'DELETE',
    ...(signal === undefined ? {} : { signal }),
  });
  requireSuccess(response);
}

export async function loadArchiveMetadata(
  input: ArchiveMetadataInput,
  signal: AbortSignal,
): Promise<ArchiveMetadataResponse> {
  const query = new URLSearchParams({ from: input.from, to: input.to });
  const response = await requestJson(
    `/api/orgs/${encodeURIComponent(input.orgId)}/archive/metadata?${query.toString()}`,
    {
      credentials: 'same-origin',
      signal,
    },
  );
  return archiveMetadataResponseSchema.parse(requireSuccess(response));
}

export async function createRun(
  input: CreateRunInput,
  csrf: CsrfCredentials,
  signal?: AbortSignal,
): Promise<RunView> {
  const response = await requestJson(
    `/api/orgs/${encodeURIComponent(input.orgId)}/runs/${encodeURIComponent(input.runId)}`,
    {
      body: JSON.stringify({ startedAt: input.startedAt }),
      credentials: 'same-origin',
      headers: mutationHeaders(csrf),
      method: 'PUT',
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return runViewSchema.parse(requireSuccess(response));
}

export async function readRun(orgId: string, runId: string, signal?: AbortSignal): Promise<RunView> {
  const response = await requestJson(
    `/api/orgs/${encodeURIComponent(orgId)}/runs/${encodeURIComponent(runId)}`,
    { credentials: 'same-origin', ...(signal === undefined ? {} : { signal }) },
  );
  return runViewSchema.parse(requireSuccess(response));
}

export async function uploadPointBatch(
  input: PointBatchInput,
  csrf: CsrfCredentials,
  signal?: AbortSignal,
): Promise<IngestPointsResponse> {
  const response = await requestJson(
    `/api/orgs/${encodeURIComponent(input.orgId)}/runs/${encodeURIComponent(input.runId)}/points`,
    {
      body: JSON.stringify({ points: input.points }),
      credentials: 'same-origin',
      headers: mutationHeaders(csrf),
      method: 'POST',
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return ingestPointsResponseSchema.parse(requireSuccess(response));
}

export async function sendRunCommand(
  input: RunCommandInput,
  csrf: CsrfCredentials,
  signal?: AbortSignal,
): Promise<RunCommandResponse> {
  const response = await requestJson(
    `/api/orgs/${encodeURIComponent(input.orgId)}/runs/${encodeURIComponent(input.runId)}/commands`,
    {
      body: JSON.stringify({
        commandId: input.commandId,
        expectedControlRevision: input.expectedControlRevision,
        type: input.type,
      }),
      credentials: 'same-origin',
      headers: mutationHeaders(csrf),
      method: 'POST',
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return runCommandResponseSchema.parse(requireSuccess(response));
}

function liveTrackUrl(
  input: LiveTrackScope,
  suffix: '' | '/changes',
  query: { afterRevision?: string; cursor?: string },
): string {
  const parameters = new URLSearchParams();
  if (query.afterRevision !== undefined) {
    parameters.set('afterRevision', query.afterRevision);
  }
  if (query.cursor !== undefined) {
    parameters.set('cursor', query.cursor);
  }
  const encodedOrgId = encodeURIComponent(input.orgId);
  const encodedRunId = encodeURIComponent(input.runId);
  const search = parameters.toString();
  return `/api/orgs/${encodedOrgId}/runs/${encodedRunId}/live-track${suffix}${search === '' ? '' : `?${search}`}`;
}

export async function readLiveTrackSnapshotPage(
  input: LiveTrackSnapshotPageInput,
  signal?: AbortSignal,
): Promise<LiveTrackResponse> {
  const query = input.cursor === undefined ? {} : { cursor: input.cursor };
  const options: RequestInit = {
    credentials: 'same-origin',
  };
  if (signal !== undefined) {
    options.signal = signal;
  }
  const response = await requestJson(liveTrackUrl(input, '', query), options);
  return liveTrackResponseSchema.parse(requireSuccess(response));
}

export async function readLiveTrackChangesPage(
  input: LiveTrackChangesPageInput,
  signal?: AbortSignal,
): Promise<LiveTrackResponse> {
  const query =
    input.cursor === undefined
      ? { afterRevision: input.afterRevision }
      : { cursor: input.cursor };
  const options: RequestInit = {
    credentials: 'same-origin',
  };
  if (signal !== undefined) {
    options.signal = signal;
  }
  const response = await requestJson(liveTrackUrl(input, '/changes', query), options);
  return liveTrackResponseSchema.parse(requireSuccess(response));
}

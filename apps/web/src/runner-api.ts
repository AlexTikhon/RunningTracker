import {
  apiErrorResponseSchema,
  archiveMetadataResponseSchema,
  ingestPointsResponseSchema,
  liveTrackResponseSchema,
  organizationCoachListResponseSchema,
  organizationListResponseSchema,
  runCommandResponseSchema,
  runSearchInterpretationResponseSchema,
  runSearchResponseSchema,
  runShareListResponseSchema,
  runShareResponseSchema,
  runViewSchema,
  sessionResponseSchema,
  type ArchiveMetadataResponse,
  type IngestPointsResponse,
  type LiveTrackResponse,
  type PointInput,
  type RunCommandResponse,
  type RunCommandType,
  type RunSearchInterpretationResponse,
  type RunSearchResponse,
  type RunShareListResponse,
  type RunShareResponse,
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
  // The caller orders session checks and acts on a 401 itself; announcing it here would bypass that ordering.
  const response = await requestJson('/api/session', options, { announceUnauthorized: false });
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

// The local demo's development session (demo-sign-in.ts). The API has this route only with LOCAL_AUTH_ENABLED, never
// in production, and only for the IDs in LOCAL_AUTH_USER_IDS. The answer sets the session cookie; its body is not
// used, because the caller then reads the session with GET /api/session like any other page load. A 401 here is
// not announced: there is no session yet to end.
export async function createLocalSession(userId: string, signal: AbortSignal): Promise<void> {
  const response = await requestJson(
    '/api/session',
    {
      body: JSON.stringify({ userId }),
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    },
    { announceUnauthorized: false },
  );
  requireSuccess(response);
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

// "My runs" search: only the signed-in person's own finished runs. The owner is never sent; the server takes it
// from the session. `params` are the validated query fields (see run-search.ts).
export async function searchRuns(
  input: { orgId: string; params: Record<string, string> },
  signal: AbortSignal,
): Promise<RunSearchResponse> {
  const query = new URLSearchParams(input.params);
  const response = await requestJson(
    `/api/orgs/${encodeURIComponent(input.orgId)}/runs/search?${query.toString()}`,
    {
      credentials: 'same-origin',
      signal,
    },
  );
  return runSearchResponseSchema.parse(requireSuccess(response));
}

// Asks the server to turn a sentence into a filter proposal. Sends only the text and the zone; the owner comes from
// the session. One call is one billable provider request, so nothing here retries, and the caller decides whether a
// late answer is still wanted.
export async function interpretRunSearch(
  input: { orgId: string; text: string; timeZone: string },
  csrf: CsrfCredentials,
  signal: AbortSignal,
): Promise<RunSearchInterpretationResponse> {
  const response = await requestJson(
    `/api/orgs/${encodeURIComponent(input.orgId)}/runs/search/interpretations`,
    {
      body: JSON.stringify({ text: input.text, timeZone: input.timeZone }),
      credentials: 'same-origin',
      headers: mutationHeaders(csrf),
      method: 'POST',
      signal,
    },
  );
  return runSearchInterpretationResponseSchema.parse(requireSuccess(response));
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

export interface RunShareTarget extends LiveTrackScope {
  userId: string;
}

// The other active coaches of the organization, as identifiers in the server's fixed order (ADR-0063).
export async function loadOrganizationCoaches(orgId: string, signal: AbortSignal): Promise<string[]> {
  const response = await requestJson(`/api/orgs/${encodeURIComponent(orgId)}/coaches`, {
    credentials: 'same-origin',
    signal,
  });
  return organizationCoachListResponseSchema.parse(requireSuccess(response)).items.map((item) => item.userId);
}

// Owner only: the server answers anyone else as for a missing run.
export async function loadRunShares(scope: LiveTrackScope, signal: AbortSignal): Promise<RunShareListResponse> {
  const response = await requestJson(
    `/api/orgs/${encodeURIComponent(scope.orgId)}/runs/${encodeURIComponent(scope.runId)}/shares`,
    { credentials: 'same-origin', signal },
  );
  return runShareListResponseSchema.parse(requireSuccess(response));
}

function sharePath({ orgId, runId, userId }: RunShareTarget): string {
  return `/api/orgs/${encodeURIComponent(orgId)}/runs/${encodeURIComponent(runId)}/shares/${encodeURIComponent(userId)}`;
}

// The web app grants one thing: live and history together. Partial grants made elsewhere are shown, not created.
export async function grantRunShare(
  target: RunShareTarget,
  csrf: CsrfCredentials,
  signal: AbortSignal,
): Promise<RunShareResponse> {
  const response = await requestJson(sharePath(target), {
    body: JSON.stringify({ canReadHistory: true, canReadLive: true }),
    credentials: 'same-origin',
    headers: mutationHeaders(csrf),
    method: 'PUT',
    signal,
  });
  return runShareResponseSchema.parse(requireSuccess(response));
}

export async function revokeRunShare(target: RunShareTarget, csrf: CsrfCredentials, signal: AbortSignal): Promise<void> {
  const response = await requestJson(sharePath(target), {
    credentials: 'same-origin',
    headers: { [csrf.headerName]: csrf.token },
    method: 'DELETE',
    signal,
  });
  requireSuccess(response);
}

// Owner only, and permanent (ADR-0035). The server answers 204 for a run it deleted now or earlier for this owner,
// so sending it again with the same run ID is safe; anyone else's run, or one that never existed, is 404.
export async function deleteRun(scope: LiveTrackScope, csrf: CsrfCredentials, signal: AbortSignal): Promise<void> {
  const response = await requestJson(
    `/api/orgs/${encodeURIComponent(scope.orgId)}/runs/${encodeURIComponent(scope.runId)}`,
    {
      credentials: 'same-origin',
      headers: { [csrf.headerName]: csrf.token },
      method: 'DELETE',
      signal,
    },
  );
  requireSuccess(response);
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

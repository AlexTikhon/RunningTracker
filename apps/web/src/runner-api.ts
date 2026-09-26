import {
  apiErrorResponseSchema,
  ingestPointsResponseSchema,
  runCommandResponseSchema,
  runViewSchema,
  sessionResponseSchema,
  type IngestPointsResponse,
  type PointInput,
  type RunCommandResponse,
  type RunCommandType,
  type RunView,
  type SessionResponse,
} from '@running-tracker/contracts';

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

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function requireSuccess(response: Response): Promise<unknown> {
  const payload = await readJson(response);
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
  const response = await fetch('/api/session', options);
  return sessionResponseSchema.parse(await requireSuccess(response));
}

export async function createRun(
  input: CreateRunInput,
  csrf: CsrfCredentials,
): Promise<RunView> {
  const response = await fetch(
    `/api/orgs/${encodeURIComponent(input.orgId)}/runs/${encodeURIComponent(input.runId)}`,
    {
      body: JSON.stringify({ startedAt: input.startedAt }),
      credentials: 'same-origin',
      headers: mutationHeaders(csrf),
      method: 'PUT',
    },
  );
  return runViewSchema.parse(await requireSuccess(response));
}

export async function readRun(orgId: string, runId: string): Promise<RunView> {
  const response = await fetch(
    `/api/orgs/${encodeURIComponent(orgId)}/runs/${encodeURIComponent(runId)}`,
    { credentials: 'same-origin' },
  );
  return runViewSchema.parse(await requireSuccess(response));
}

export async function uploadPointBatch(
  input: PointBatchInput,
  csrf: CsrfCredentials,
): Promise<IngestPointsResponse> {
  const response = await fetch(
    `/api/orgs/${encodeURIComponent(input.orgId)}/runs/${encodeURIComponent(input.runId)}/points`,
    {
      body: JSON.stringify({ points: input.points }),
      credentials: 'same-origin',
      headers: mutationHeaders(csrf),
      method: 'POST',
    },
  );
  return ingestPointsResponseSchema.parse(await requireSuccess(response));
}

export async function sendRunCommand(
  input: RunCommandInput,
  csrf: CsrfCredentials,
): Promise<RunCommandResponse> {
  const response = await fetch(
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
    },
  );
  return runCommandResponseSchema.parse(await requireSuccess(response));
}

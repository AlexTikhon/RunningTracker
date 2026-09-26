import {
  apiErrorResponseSchema,
  runCommandResponseSchema,
  runViewSchema,
  sessionResponseSchema,
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

export class RunnerApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly requestId: string | null,
  ) {
    super(message);
    this.name = 'RunnerApiError';
  }
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
    );
  }

  throw new RunnerApiError(
    `The server returned HTTP ${response.status}.`,
    response.status,
    'HTTP_ERROR',
    null,
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

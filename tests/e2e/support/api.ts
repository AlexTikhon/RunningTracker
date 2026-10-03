import type { RunView } from '@running-tracker/contracts';
import type { APIResponse, BrowserContext } from '@playwright/test';

import type { E2eEnvironment } from './environment.js';

export interface AuthedApi {
  createRun(orgId: string, runId: string, startedAt?: string): Promise<RunView>;
  getRun(orgId: string, runId: string): Promise<RunView>;
  listRunIds(orgId: string): Promise<string[]>;
  getAllPoints(orgId: string, runId: string): Promise<Array<{ seq: string }>>;
  putShare(
    orgId: string,
    runId: string,
    userId: string,
    share: { canReadLive: boolean; canReadHistory: boolean },
  ): Promise<void>;
  deleteShare(orgId: string, runId: string, userId: string): Promise<void>;
}

interface SessionResponse {
  readonly csrf: { readonly headerName: string; readonly token: string };
}

interface RunListResponse {
  readonly items: ReadonlyArray<{ readonly runId: string }>;
  readonly nextCursor: string | null;
}

interface PointsResponse {
  readonly nextCursor: string | null;
  readonly points: ReadonlyArray<{ readonly seq: string }>;
}

// A range that covers every run the suite can create, for the list endpoint which requires one.
const listFrom = '2000-01-01T00:00:00.000Z';
const listTo = '2100-01-01T00:00:00.000Z';

// Errors name the method, the path and the status only: a response body or a header could carry a session
// token or a CSRF token, and neither belongs in a test report.
function expectStatus(
  response: APIResponse,
  method: string,
  path: string,
  expected: readonly number[],
): void {
  if (!expected.includes(response.status())) {
    throw new Error(`${method} ${path} failed with status ${response.status()}`);
  }
}

// Signs the context in through the web origin's /api proxy, the same path the browser takes, so the
// session cookie lands in the context's cookie jar for both the page and context.request.
export async function signIn(
  context: BrowserContext,
  environment: E2eEnvironment,
  userId: string,
): Promise<void> {
  const path = '/api/session';
  const response = await context.request.post(`${environment.webOrigin}${path}`, {
    data: { userId },
    headers: { origin: environment.webOrigin },
  });
  expectStatus(response, 'POST', path, [201]);
}

export async function authedApi(context: BrowserContext, environment: E2eEnvironment): Promise<AuthedApi> {
  const sessionPath = '/api/session';
  const sessionResponse = await context.request.get(`${environment.webOrigin}${sessionPath}`);
  expectStatus(sessionResponse, 'GET', sessionPath, [200]);
  const session = (await sessionResponse.json()) as SessionResponse;

  const url = (path: string): string => `${environment.webOrigin}${path}`;
  const mutationHeaders = {
    [session.csrf.headerName]: session.csrf.token,
    origin: environment.webOrigin,
  };

  async function get<Body>(path: string): Promise<Body> {
    const response = await context.request.get(url(path));
    expectStatus(response, 'GET', path, [200]);
    return (await response.json()) as Body;
  }

  const runPath = (orgId: string, runId: string): string => `/api/orgs/${orgId}/runs/${runId}`;
  const sharePath = (orgId: string, runId: string, userId: string): string =>
    `${runPath(orgId, runId)}/shares/${userId}`;

  return {
    async createRun(orgId, runId, startedAt = new Date().toISOString()) {
      const path = runPath(orgId, runId);
      const response = await context.request.put(url(path), {
        data: { startedAt },
        headers: mutationHeaders,
      });
      expectStatus(response, 'PUT', path, [200, 201]);
      return (await response.json()) as RunView;
    },

    async deleteShare(orgId, runId, userId) {
      const path = sharePath(orgId, runId, userId);
      const response = await context.request.delete(url(path), { headers: mutationHeaders });
      expectStatus(response, 'DELETE', path, [204]);
    },

    async getAllPoints(orgId, runId) {
      const points: Array<{ seq: string }> = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
        const page: PointsResponse = await get<PointsResponse>(`${runPath(orgId, runId)}/points${query}`);
        points.push(...page.points);
        cursor = page.nextCursor;
      } while (cursor !== null);
      return points;
    },

    getRun(orgId, runId) {
      return get<RunView>(runPath(orgId, runId));
    },

    async listRunIds(orgId) {
      const runIds: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string =
          `?from=${encodeURIComponent(listFrom)}&to=${encodeURIComponent(listTo)}` +
          (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
        const page: RunListResponse = await get<RunListResponse>(`/api/orgs/${orgId}/runs${query}`);
        runIds.push(...page.items.map((item) => item.runId));
        cursor = page.nextCursor;
      } while (cursor !== null);
      return runIds;
    },

    async putShare(orgId, runId, userId, share) {
      const path = sharePath(orgId, runId, userId);
      const response = await context.request.put(url(path), { data: share, headers: mutationHeaders });
      expectStatus(response, 'PUT', path, [200]);
    },
  };
}

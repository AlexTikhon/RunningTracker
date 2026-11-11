import {
  activityHistoryResponseSchema,
  activityListResponseSchema,
  activityViewSchema,
  apiErrorResponseSchema,
  archiveMetadataResponseSchema,
  archiveTrackResponseSchema,
  DAILY_METRICS_NOT_FOUND,
  dailyMetricsListResponseSchema,
  dailyMetricsViewSchema,
  DAILY_MOVEMENT_NOT_FOUND,
  dailyMovementListResponseSchema,
  dailyMovementViewSchema,
  dailyOverviewSchema,
  dailyTrendsSchema,
  GPX_IMPORT_CONTENT_TYPE,
  gpxImportPreviewSchema,
  ingestPointsResponseSchema,
  mealListResponseSchema,
  mealViewSchema,
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
  WEEKLY_INSIGHT_NOT_FOUND,
  weeklyInsightAcceptedSchema,
  weeklyInsightViewSchema,
  weeklyReviewSchema,
  type ActivityHistoryResponse,
  type ActivityHistorySource,
  type ActivityListResponse,
  type ActivityType,
  type ActivityView,
  type GpxImportPreview,
  type ArchiveMetadataResponse,
  type CreateActivityRequest,
  type DailyMetricsListResponse,
  type DailyMetricsView,
  type PutDailyMetricsRequest,
  type DailyMovementListResponse,
  type DailyMovementView,
  type PutDailyMovementRequest,
  type DailyOverview,
  type DailyTrends,
  type CreateMealRequest,
  type MealListResponse,
  type MealView,
  type UpdateMealRequest,
  type ArchiveTrackResponse,
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
  type WeeklyInsightAccepted,
  type WeeklyInsightView,
  type WeeklyReview,
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
    // The error envelope's `details`, unvalidated: a caller that relies on a field parses it with its own schema.
    public readonly details: Readonly<Record<string, unknown>> | null = null,
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
      parsed.data.error.details ?? null,
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

export async function loadArchiveTrack(scope: LiveTrackScope, signal: AbortSignal): Promise<ArchiveTrackResponse> {
  const response = await requestJson(
    `/api/orgs/${encodeURIComponent(scope.orgId)}/runs/${encodeURIComponent(scope.runId)}/track?mode=archive`,
    { credentials: 'same-origin', cache: 'no-store', signal },
  );
  const feature = archiveTrackResponseSchema.parse(requireSuccess(response));
  if (feature.properties.runId !== scope.runId) throw new Error('The server returned a different run');
  return feature;
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

// Manual activities (ADR-0072): owner-only, so no owner is ever sent; the server takes it from the session.
export interface ActivityTarget {
  activityId: string;
  orgId: string;
}

function activityPath(orgId: string, activityId?: string): string {
  const base = `/api/orgs/${encodeURIComponent(orgId)}/activities`;
  return activityId === undefined ? base : `${base}/${encodeURIComponent(activityId)}`;
}

// Idempotent create: the client chose the id, so sending the same id and payload again after an unknown outcome is
// safe (200 with the stored activity). 409 ACTIVITY_CONFLICT means the id already holds a different payload. The form
// session's idempotency key (ADR-0073) makes a save under a new id safe too: 200 with the activity that key already
// created (whose id is then not the one sent), or 409 ACTIVITY_ALREADY_SAVED when the details differ.
export async function createActivity(
  target: ActivityTarget,
  request: CreateActivityRequest,
  csrf: CsrfCredentials,
  signal: AbortSignal,
): Promise<{ activity: ActivityView; created: boolean }> {
  const response = await requestJson(activityPath(target.orgId, target.activityId), {
    body: JSON.stringify(request),
    credentials: 'same-origin',
    headers: mutationHeaders(csrf),
    method: 'PUT',
    signal,
  });
  const activity = activityViewSchema.parse(requireSuccess(response));
  const created = response.response.status === 201;
  // A new activity must be the one asked for; a replay may be the one this form session saved earlier under another id.
  if (created && activity.activityId !== target.activityId) throw new Error('The server returned a different activity');
  return { activity, created };
}

function gpxUploadHeaders(csrf: CsrfCredentials): HeadersInit {
  return { 'content-type': GPX_IMPORT_CONTENT_TYPE, [csrf.headerName]: csrf.token };
}

// GPX import (ADR-0086). The body is the file exactly as selected; nothing else about it is sent. The server parses it and
// computes every number on preview and again on confirmation, so no total, time or source travels from the browser.
export async function previewGpxImport(
  input: { orgId: string },
  file: Blob,
  csrf: CsrfCredentials,
  signal: AbortSignal,
): Promise<GpxImportPreview> {
  const response = await requestJson(`${activityPath(input.orgId)}/gpx-preview`, {
    body: file,
    cache: 'no-store',
    credentials: 'same-origin',
    headers: gpxUploadHeaders(csrf),
    method: 'POST',
    signal,
  });
  return gpxImportPreviewSchema.parse(requireSuccess(response));
}

// Idempotent like the manual create: the same id, key, type and file after an unknown outcome answer the stored activity
// (200); a new id under the same key answers the activity that key already saved, or 409 ACTIVITY_ALREADY_SAVED when the
// type differs; 409 GPX_ALREADY_IMPORTED names an existing import of the same track.
export async function confirmGpxImport(
  target: ActivityTarget,
  choice: { idempotencyKey: string; type: ActivityType },
  file: Blob,
  csrf: CsrfCredentials,
  signal: AbortSignal,
): Promise<{ activity: ActivityView; created: boolean }> {
  const query = new URLSearchParams({ idempotencyKey: choice.idempotencyKey, type: choice.type });
  const response = await requestJson(`${activityPath(target.orgId, target.activityId)}/gpx-import?${query.toString()}`, {
    body: file,
    credentials: 'same-origin',
    headers: gpxUploadHeaders(csrf),
    method: 'PUT',
    signal,
  });
  const activity = activityViewSchema.parse(requireSuccess(response));
  const created = response.response.status === 201;
  if (activity.source !== 'gpx') throw new Error('The server returned an activity that was not imported from GPX');
  if (created && activity.activityId !== target.activityId) throw new Error('The server returned a different activity');
  return { activity, created };
}

export async function readActivity(target: ActivityTarget, signal: AbortSignal): Promise<ActivityView> {
  const response = await requestJson(activityPath(target.orgId, target.activityId), {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  const activity = activityViewSchema.parse(requireSuccess(response));
  if (activity.activityId !== target.activityId) throw new Error('The server returned a different activity');
  return activity;
}

export async function listActivities(
  input: { cursor: string | null; orgId: string },
  signal: AbortSignal,
): Promise<ActivityListResponse> {
  const query = new URLSearchParams(input.cursor === null ? {} : { cursor: input.cursor });
  const suffix = query.size === 0 ? '' : `?${query.toString()}`;
  const response = await requestJson(`${activityPath(input.orgId)}${suffix}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  return activityListResponseSchema.parse(requireSuccess(response));
}

export interface ActivityHistoryInput {
  cursor: string | null;
  orgId: string;
  source: ActivityHistorySource | null;
  type: ActivityType | null;
}

// The unified history (ADR-0087): manual activities, GPX imports and the person's own finished recorded runs. The cursor
// is bound by the server to the person, the organization and both filters, so it is only ever sent with the filters it
// came from.
export async function loadActivityHistory(input: ActivityHistoryInput, signal: AbortSignal): Promise<ActivityHistoryResponse> {
  const query = new URLSearchParams();
  if (input.source !== null) query.set('source', input.source);
  if (input.type !== null) query.set('type', input.type);
  if (input.cursor !== null) query.set('cursor', input.cursor);
  const suffix = query.size === 0 ? '' : `?${query.toString()}`;
  const response = await requestJson(`/api/orgs/${encodeURIComponent(input.orgId)}/activity-history${suffix}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  return activityHistoryResponseSchema.parse(requireSuccess(response));
}

// 204 in every case, including an activity that is already gone (there is no tombstone), so a retry is always safe.
export async function deleteActivity(target: ActivityTarget, csrf: CsrfCredentials, signal: AbortSignal): Promise<void> {
  const response = await requestJson(activityPath(target.orgId, target.activityId), {
    credentials: 'same-origin',
    headers: { [csrf.headerName]: csrf.token },
    method: 'DELETE',
    signal,
  });
  requireSuccess(response);
}

// Daily check-ins (ADR-0074): owner-only, one record per person per local date, replaced as a whole.
export interface DailyMetricsTarget {
  localDate: string;
  orgId: string;
}

function dailyMetricsPath(orgId: string, localDate?: string): string {
  const base = `/api/orgs/${encodeURIComponent(orgId)}/daily-metrics`;
  return localDate === undefined ? base : `${base}/${encodeURIComponent(localDate)}`;
}

// Naturally idempotent: the body is the whole day, so sending it again after an unknown outcome is always safe.
// 201 when the day was first written, 200 when it was replaced or already held these values.
export async function putDailyMetrics(
  target: DailyMetricsTarget,
  request: PutDailyMetricsRequest,
  csrf: CsrfCredentials,
  signal: AbortSignal,
): Promise<{ created: boolean; view: DailyMetricsView }> {
  const response = await requestJson(dailyMetricsPath(target.orgId, target.localDate), {
    body: JSON.stringify(request),
    credentials: 'same-origin',
    headers: mutationHeaders(csrf),
    method: 'PUT',
    signal,
  });
  const view = dailyMetricsViewSchema.parse(requireSuccess(response));
  if (view.localDate !== target.localDate) throw new Error('The server returned a different date');
  return { created: response.response.status === 201, view };
}

// A day without a record is not an error for the form: it answers null.
export async function readDailyMetrics(target: DailyMetricsTarget, signal: AbortSignal): Promise<DailyMetricsView | null> {
  const response = await requestJson(dailyMetricsPath(target.orgId, target.localDate), {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (response.response.status === 404) {
    const refusal = apiErrorResponseSchema.safeParse(response.payload);
    if (refusal.success && refusal.data.error.code === DAILY_METRICS_NOT_FOUND) return null;
  }
  const view = dailyMetricsViewSchema.parse(requireSuccess(response));
  if (view.localDate !== target.localDate) throw new Error('The server returned a different date');
  return view;
}

// 204 in every case: deleted now, already deleted or never written are answered alike, so a retry is always safe.
export async function deleteDailyMetrics(target: DailyMetricsTarget, csrf: CsrfCredentials, signal: AbortSignal): Promise<void> {
  const response = await requestJson(dailyMetricsPath(target.orgId, target.localDate), {
    credentials: 'same-origin',
    headers: { [csrf.headerName]: csrf.token },
    method: 'DELETE',
    signal,
  });
  requireSuccess(response);
}

export async function listDailyMetrics(
  input: { from: string; orgId: string; to: string },
  signal: AbortSignal,
): Promise<DailyMetricsListResponse> {
  const query = new URLSearchParams({ from: input.from, to: input.to });
  const response = await requestJson(`${dailyMetricsPath(input.orgId)}?${query.toString()}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  return dailyMetricsListResponseSchema.parse(requireSuccess(response));
}

// Manual daily movement (ADR-0078): owner-only steps and active energy, one manual record per person per local date,
// replaced as a whole. The same shape of calls as daily check-ins, on its own path.
export interface DailyMovementTarget {
  localDate: string;
  orgId: string;
}

function dailyMovementPath(orgId: string, localDate?: string): string {
  const base = `/api/orgs/${encodeURIComponent(orgId)}/daily-movement`;
  return localDate === undefined ? base : `${base}/${encodeURIComponent(localDate)}`;
}

// Naturally idempotent: the body is the whole day, so sending it again after an unknown outcome is always safe.
// 201 when the day was first written, 200 when it was replaced or already held these values.
export async function putDailyMovement(
  target: DailyMovementTarget,
  request: PutDailyMovementRequest,
  csrf: CsrfCredentials,
  signal: AbortSignal,
): Promise<{ created: boolean; view: DailyMovementView }> {
  const response = await requestJson(dailyMovementPath(target.orgId, target.localDate), {
    body: JSON.stringify(request),
    credentials: 'same-origin',
    headers: mutationHeaders(csrf),
    method: 'PUT',
    signal,
  });
  const view = dailyMovementViewSchema.parse(requireSuccess(response));
  if (view.localDate !== target.localDate) throw new Error('The server returned a different date');
  return { created: response.response.status === 201, view };
}

// A day without a record is not an error for the form: it answers null.
export async function readDailyMovement(target: DailyMovementTarget, signal: AbortSignal): Promise<DailyMovementView | null> {
  const response = await requestJson(dailyMovementPath(target.orgId, target.localDate), {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (response.response.status === 404) {
    const refusal = apiErrorResponseSchema.safeParse(response.payload);
    if (refusal.success && refusal.data.error.code === DAILY_MOVEMENT_NOT_FOUND) return null;
  }
  const view = dailyMovementViewSchema.parse(requireSuccess(response));
  if (view.localDate !== target.localDate) throw new Error('The server returned a different date');
  return view;
}

// 204 in every case: deleted now, already deleted or never written are answered alike, so a retry is always safe.
export async function deleteDailyMovement(target: DailyMovementTarget, csrf: CsrfCredentials, signal: AbortSignal): Promise<void> {
  const response = await requestJson(dailyMovementPath(target.orgId, target.localDate), {
    credentials: 'same-origin',
    headers: { [csrf.headerName]: csrf.token },
    method: 'DELETE',
    signal,
  });
  requireSuccess(response);
}

export async function listDailyMovement(
  input: { from: string; orgId: string; to: string },
  signal: AbortSignal,
): Promise<DailyMovementListResponse> {
  const query = new URLSearchParams({ from: input.from, to: input.to });
  const response = await requestJson(`${dailyMovementPath(input.orgId)}?${query.toString()}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  return dailyMovementListResponseSchema.parse(requireSuccess(response));
}

// The manual meal log (ADR-0083): owner-only entries with a database-generated id, listed one local date at a time.
export interface MealTarget {
  mealId: string;
  orgId: string;
}

function mealPath(orgId: string, mealId?: string): string {
  const base = `/api/orgs/${encodeURIComponent(orgId)}/meals`;
  return mealId === undefined ? base : `${base}/${encodeURIComponent(mealId)}`;
}

// Idempotent per form session: the same idempotency key with the same request answers 200 with the entry it created,
// so resending after an unknown outcome is safe; a changed request under the same key is 409 MEAL_ALREADY_SAVED.
export async function createMeal(
  orgId: string,
  request: CreateMealRequest,
  csrf: CsrfCredentials,
  signal: AbortSignal,
): Promise<{ created: boolean; view: MealView }> {
  const response = await requestJson(mealPath(orgId), {
    body: JSON.stringify(request),
    credentials: 'same-origin',
    headers: mutationHeaders(csrf),
    method: 'POST',
    signal,
  });
  const view = mealViewSchema.parse(requireSuccess(response));
  if (view.localDate !== request.localDate) throw new Error('The server returned an entry of a different date');
  return { created: response.response.status === 201, view };
}

// Naturally idempotent: the body is the whole set of editable fields, so sending it again changes nothing.
export async function updateMeal(target: MealTarget, request: UpdateMealRequest, csrf: CsrfCredentials, signal: AbortSignal): Promise<MealView> {
  const response = await requestJson(mealPath(target.orgId, target.mealId), {
    body: JSON.stringify(request),
    credentials: 'same-origin',
    headers: mutationHeaders(csrf),
    method: 'PUT',
    signal,
  });
  const view = mealViewSchema.parse(requireSuccess(response));
  if (view.mealId !== target.mealId) throw new Error('The server returned a different entry');
  return view;
}

export async function listMeals(
  input: { cursor: string | null; localDate: string; orgId: string },
  signal: AbortSignal,
): Promise<MealListResponse> {
  const query = new URLSearchParams({ localDate: input.localDate, ...(input.cursor === null ? {} : { cursor: input.cursor }) });
  const response = await requestJson(`${mealPath(input.orgId)}?${query.toString()}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  const page = mealListResponseSchema.parse(requireSuccess(response));
  if (page.items.some((item) => item.localDate !== input.localDate)) throw new Error('The server returned entries of a different date');
  return page;
}

// 204 in every case, including an entry that is already gone, so a retry is always safe.
export async function deleteMeal(target: MealTarget, csrf: CsrfCredentials, signal: AbortSignal): Promise<void> {
  const response = await requestJson(mealPath(target.orgId, target.mealId), {
    credentials: 'same-origin',
    headers: { [csrf.headerName]: csrf.token },
    method: 'DELETE',
    signal,
  });
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

// Weekly insights (ADR-0076). Owner-only like the check-ins they are derived from.
export interface WeeklyInsightTarget {
  orgId: string;
  weekStart: string;
}

function weeklyInsightPath(orgId: string): string {
  return `/api/orgs/${encodeURIComponent(orgId)}/insights/weekly`;
}

// No insight for the week (never asked for, or deleted together with a source record) is not an error: it answers null.
export async function readWeeklyInsight(target: WeeklyInsightTarget, signal: AbortSignal): Promise<WeeklyInsightView | null> {
  const query = new URLSearchParams({ weekStart: target.weekStart });
  const response = await requestJson(`${weeklyInsightPath(target.orgId)}?${query.toString()}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (response.response.status === 404) {
    const refusal = apiErrorResponseSchema.safeParse(response.payload);
    if (refusal.success && refusal.data.error.code === WEEKLY_INSIGHT_NOT_FOUND) return null;
  }
  const view = weeklyInsightViewSchema.parse(requireSuccess(response));
  if (view.weekStart !== target.weekStart) throw new Error('The server returned a different week');
  return view;
}

// Asks for the week's insight. Safe to repeat: the same data returns the existing insight instead of generating again.
export async function requestWeeklyInsight(
  input: WeeklyInsightTarget & { timeZone: string },
  csrf: CsrfCredentials,
  signal: AbortSignal,
): Promise<WeeklyInsightAccepted> {
  const response = await requestJson(weeklyInsightPath(input.orgId), {
    body: JSON.stringify({ timeZone: input.timeZone, weekStart: input.weekStart }),
    credentials: 'same-origin',
    headers: mutationHeaders(csrf),
    method: 'POST',
    signal,
  });
  return weeklyInsightAcceptedSchema.parse(requireSuccess(response));
}

// The deterministic weekly review: computed by the server on every read, never by a model, and never cached.
export interface WeeklyReviewTarget {
  orgId: string;
  timeZone: string;
  weekStart: string;
}

export async function readWeeklyReview(target: WeeklyReviewTarget, signal: AbortSignal): Promise<WeeklyReview> {
  const query = new URLSearchParams({ timeZone: target.timeZone, weekStart: target.weekStart });
  const response = await requestJson(`/api/orgs/${encodeURIComponent(target.orgId)}/weekly-review?${query.toString()}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  const review = weeklyReviewSchema.parse(requireSuccess(response));
  if (review.week.start !== target.weekStart) throw new Error('The server returned a different week');
  return review;
}

// The daily overview (Today, ADR-0082): computed by the server on every read from the person's own records, never cached.
export interface DailyOverviewTarget {
  localDate: string;
  orgId: string;
  timeZone: string;
}

export async function readDailyOverview(target: DailyOverviewTarget, signal: AbortSignal): Promise<DailyOverview> {
  const query = new URLSearchParams({ timeZone: target.timeZone });
  const path = `/api/orgs/${encodeURIComponent(target.orgId)}/daily-overview/${encodeURIComponent(target.localDate)}`;
  const response = await requestJson(`${path}?${query.toString()}`, { cache: 'no-store', credentials: 'same-origin', signal });
  const overview = dailyOverviewSchema.parse(requireSuccess(response));
  if (overview.day.localDate !== target.localDate) throw new Error('The server returned a different date');
  return overview;
}

export interface DailyTrendsTarget {
  endDate: string;
  orgId: string;
  timeZone: string;
}

/** The 28-day trends ending on `endDate` (ADR-0084). The zone decides "today" only; no record moves. */
export async function readDailyTrends(target: DailyTrendsTarget, signal: AbortSignal): Promise<DailyTrends> {
  const query = new URLSearchParams({ endDate: target.endDate, timeZone: target.timeZone });
  const path = `/api/orgs/${encodeURIComponent(target.orgId)}/daily-trends?${query.toString()}`;
  const response = await requestJson(path, { cache: 'no-store', credentials: 'same-origin', signal });
  const trends = dailyTrendsSchema.parse(requireSuccess(response));
  if (trends.range.endDate !== target.endDate) throw new Error('The server returned a different range');
  return trends;
}

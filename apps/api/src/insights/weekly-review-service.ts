import type { WeeklyReview, WeeklyReviewQuery } from '@running-tracker/contracts';
import type { Pool } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import type { Clock } from '../clock.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { ApiError } from '../http/errors.js';
import { localDateOf } from '../runs/run-search-period.js';
import { canonicalTimeZone, computeWeek } from './weekly-insight-service.js';
import { buildWeeklyReview, reviewDetailOf } from './weekly-review.js';

// The deterministic weekly review: computed on every read, never stored, never queued, and independent of AI
// generation. It does not know the weekly insight service or any model provider, so it cannot call a model.
//
// One REPEATABLE READ READ ONLY transaction: the membership check and the week's sources (one statement: check-ins,
// manual activities and the person's own finished GPS runs with current summaries) share one snapshot. Every
// statement names the organization and the owner, and runs with row-level security in force; GPS runs are filtered by
// owner explicitly, so a run another person shared with this one is never part of their review.

export interface WeeklyReviewServiceOptions {
  clock: Clock;
  pool: Pick<Pool, 'connect'>;
}

export class WeeklyReviewService {
  readonly #clock: Clock;
  readonly #pool: Pick<Pool, 'connect'>;

  public constructor(options: WeeklyReviewServiceOptions) {
    this.#clock = options.clock;
    this.#pool = options.pool;
  }

  public async read(session: Pick<StoredSession, 'userId'>, orgId: string, query: WeeklyReviewQuery): Promise<WeeklyReview> {
    const requestTimeZone = canonicalTimeZone(query.timeZone);
    const now = this.#clock.utcNow();
    const nowMs = now.getTime();
    const today = localDateOf(nowMs, requestTimeZone);
    if (query.weekStart > today) {
      throw new ApiError(400, 'INVALID_REQUEST', `The week cannot start after today (${today} in ${requestTimeZone})`, {
        fields: [{ message: `Must not be after ${today}`, path: ['weekStart'] }],
      });
    }
    const owner = { orgId, userId: session.userId };
    const week = await withAuthenticatedTenantTransaction(
      this.#pool,
      session,
      orgId,
      (client) => computeWeek(client, owner, query.weekStart, requestTimeZone, nowMs),
      { snapshot: 'read-only snapshot' },
    );
    const detail = reviewDetailOf({ activities: week.sources.activities, checkIns: week.sources.checkIns, window: week.window });
    return buildWeeklyReview({ aggregate: week.aggregate, computedAt: now.toISOString(), detail });
  }
}

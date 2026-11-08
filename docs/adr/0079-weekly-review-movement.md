# ADR-0079: Manual daily movement in the deterministic weekly review, and active energy refused (not rounded) by the database

- Status: accepted; implemented and verified locally (unit, real PostgreSQL integration including the restore drill,
  Chromium end-to-end with generation off). Hosted CI: see the final report of the change.
- Date: 2026-11-08
- Relates to: ADR-0077 (deterministic weekly review: one snapshot, code-written statements, explicit denominators),
  ADR-0078 (manual daily movement: `daily_movement`, server-owned `source`, ADR-0074 date rules; its "not established"
  list named this slice), ADR-0076 (weekly insights, which this slice deliberately does not feed), ADR-0074 (a day is a
  local calendar date with the zone of its first write).
- Scope: migration 0035, `packages/contracts/src/weekly-review.ts`, `apps/api/src/insights/weekly-review*.ts`, a
  test-only hook in `createApp`, the Weekly review section and the refresh wiring of the web Check-in tab, the restore
  drill fixture, tests, docs. No new table, route, dependency, infrastructure, background job, cache or persisted
  review; no change to AI insights, their prompts, policies, hashes, source gates or triggers, or to migration 0034.

## Context

ADR-0078 stored steps and user-reported active energy per local date and kept them out of the weekly review on
purpose, leaving "whether and how it enters" as a later decision. The review (ADR-0077) is the primary weekly view and
is computed by code, so it can show movement without a model; AI insights must keep their input unchanged.

Review of ADR-0078 also found a precision gap: `active_energy_kcal numeric(6,1)` makes PostgreSQL round a value to the
column's scale **before** CHECK constraints run, so a direct write of 412.55 was stored as 412.6 and -0.01 as 0.0 (and
passed the range check), although the API refuses both. The database and the API disagreed on what a valid value is.

## Decision 1: the database refuses a meaningful second decimal (migration 0035)

| Option | For | Against |
|---|---|---|
| Keep `numeric(6,1)`, add a CHECK | No type change | Impossible: the type modifier has already rounded the value when the CHECK sees it |
| BEFORE trigger that raises on extra digits | Keeps the type | The type modifier also applies before BEFORE triggers; more code than a constraint |
| Integer tenths column (`active_energy_tenths`) | Exact integers everywhere | Rewrites the column, its privileges, the service, the erasure replay format and the drill; out of proportion |
| **Unconstrained `numeric` + range and precision CHECKs** (chosen) | The value is stored exactly as written; one new constraint; binary-coercible type change | A value keeps the scale it was written with (`0`, `0.0` and `250.00` are all valid spellings of a valid value) |

`ALTER COLUMN active_energy_kcal TYPE numeric` (no rewrite: `numeric(6,1)` to `numeric` is binary-coercible, so stored
values and their scale are kept) and `daily_movement_active_energy_precision CHECK (active_energy_kcal IS NULL OR
active_energy_kcal = round(active_energy_kcal, 1))` next to the existing range check (0 to 20,000; numeric orders NaN
and Infinity above every finite value, so the upper bound refuses both, and -Infinity fails the lower bound). `round()`
appears only inside the comparison; nothing stored is rounded. Column privileges (runtime INSERT and UPDATE on the
column), RLS, the timestamps trigger, the erasure trigger and replay are unchanged (the ACL tests pass unchanged).

The API and the database now accept the same values: a test inserts 18 JSON numbers (0, -0, 0.1, 0.3, 1.1, 250, 412.5,
412.55, 412.49, 0.05, 1e-7, -0.01, -0.1, 19,999.9, 20,000, 20,000.1, 20,000.01, ...) through the runtime role and
requires the database's verdict to equal the contract's for each. New values written by the API are stored as sent
(`String(value)`, for example `0` instead of the former `0.0`); the API view, which maps the text with `Number()`, is
unchanged, and the exact-retry comparison (`IS DISTINCT FROM`, numeric equality) treats `250` and `250.0` alike.

The restore drill now restores a backup at 0034 and applies 0035 to it; its surviving movement day N carries 120.5 kcal,
so the row digest taken before the backup and after recovery proves the value and its scale survive the migration.

## Decision 2: a review-only `movement` part, read in the same snapshot

`GET /api/orgs/:orgId/weekly-review` gains `movement` (`WEEKLY_REVIEW_VERSION` becomes `weekly-review-2`):

| Field | Meaning |
|---|---|
| `source` | `'manual'`: every counted value was entered by hand (the only source; the aggregation filters on it) |
| `daysInWeek` | 7 |
| `daysWithRecord` | Days with a movement record, whichever values it holds |
| `steps.daysRecorded`, `activeEnergyKcal.daysRecorded` | Days with that value, each against the 7 calendar days, independent of each other and of check-ins |
| `steps.recordedTotal`, `activeEnergyKcal.recordedTotal` | The sum of the recorded values only; `null` when the metric was recorded on no day (unknown), `0` when only zeros were recorded |
| `days` | Exactly 7 entries, Monday to Sunday: `{ localDate, recorded: false }` for a day without a record (no values: unknown, never zero), or `{ localDate, recorded: true, steps, activeEnergyKcal, source, timeZone }` with each value as stored (a recorded 0 stays 0, an empty one stays null) and the stored zone of the day's first write |

The contract is strict and self-checking: the day counts, the totals (energy compared in integer tenths) and the record
count must match the days, the days must be the review's week in order, a missing day cannot carry values, a recorded
day needs at least one value, energy has at most one decimal, and only `manual` is a valid source.

**One snapshot, no later read.** `WeeklyReviewService` already ran the membership check and the AI-shared source
statement (`weekSourcesSql`) in one `REPEATABLE READ READ ONLY` transaction. Movement is a second statement in that same
transaction (`weekMovementSql`); in REPEATABLE READ the snapshot is taken by the first statement and every later one
reads it, so a movement write committed between the two statements is not seen. Nothing is read after the transaction
ends. A separate statement rather than a fourth sub-select of `weekSourcesSql` keeps the AI input query, and therefore
anything derived from it, untouched. The statement names the organization, the owner and `source = 'manual'`, and runs
under the owner-only RLS of ADR-0078; run sharing never applies. A test-only hook (`testOnlyWeeklyReviewHooks`, refused
outside `APP_ENV=test` like the other test-only dependencies) lets a test commit a movement write and deletes between
the two statements.

**Dates.** Movement uses the stored `local_date` between the Monday and the Sunday inclusive. A daily total is a
calendar date the person read, not an instant, so it is never re-read in another zone. The week's zone keeps the
ADR-0077 rule (the most frequent check-in zone, otherwise the requested zone); movement zones do not take part in it, so
movement never moves the boundaries of activities and GPS runs. When a recorded day's stored zone differs from the
week's zone, the review says so (`movement.time_zones`).

**Exact energy.** PostgreSQL returns the value as text; `kcalTenthsOf` parses it into integer tenths with a strict
pattern (a meaningful second decimal throws instead of rounding), totals are added as integers, and the payload's number
is `tenths / 10`. 0.1 + 0.2 kcal is 0.3 (in the payload, its JSON and the sentence), not 0.30000000000000004. Steps are
integers already.

**Separation.** Movement is not added to manual activity or GPS figures, nothing is derived from it (no calories, no
estimate), and it is not part of `coverage`, `facts` or `dataGaps`, which are the parts shared with AI insights: the
check-in denominators are unchanged, and a week of movement only still says "No check-ins were recorded this week."

## Decision 3: code-written statements with their coverage

Appended after the existing statements, in this order, with stable codes:

| Code | When | Example |
|---|---|---|
| `movement.none` | no record in the week | "No daily movement was recorded this week." |
| `movement.steps_recorded` | steps on at least one day | "Steps were recorded on 2 of 7 days, 8,042 steps in total on those days; the other 5 days are unknown." |
| `movement.steps_not_recorded` | records, but no steps | "Steps were not recorded on any day this week." |
| `movement.active_energy_recorded` | energy on at least one day | "Active energy was recorded on 2 of 7 days, 662.5 kcal in total on those days; the other 5 days are unknown." |
| `movement.active_energy_not_recorded` | records, but no energy | "Active energy was not recorded on any day this week." |
| `movement.manual_source` | any record | "Steps and active energy were entered manually; they are shown on their own and not added to the activity or GPS run figures." |
| `movement.time_zones` | a recorded day's zone differs from the week's zone | "Movement days were saved in Asia/Tokyo; each counts on the calendar date it was saved for, and the week's activities and GPS runs are still read in Europe/Warsaw." |

Every total is called recorded and names its coverage; missing days are unknown. Singular forms ("on 1 of 7 days, 1
step on that day; the other 6 days are unknown"), all seven days ("on all 7 days, ... in total") and digit grouping
without a locale are code. The in-progress notice (`week.in_progress`) stays first. No target, judgement or advice: the
existing word scan runs over weeks with movement too. A long list of zones falls back to a count so a statement stays
within 240 characters.

The required regression (Monday steps 0 and no energy; Tuesday 8,042 steps and 412.5 kcal; Wednesday 250 kcal only;
other days missing) gives three record days, steps on 2 of 7 days totalling 8,042 and active energy on 2 of 7 days
totalling 662.5 kcal, in the unit, contract, HTTP and Chromium tests.

## Decision 4: the web shows it inside the Weekly review and refreshes only the review

The Weekly review gains a "Steps and active energy" block (a region named by its heading): the "Manually entered"
badge with what it means (entered by hand, not added to activities or GPS runs, a day without a value is unknown),
three rows ("Days with movement 3 of 7", "Steps, recorded total 8,042 steps on 2 of 7 days", "Active energy, recorded
total 662.5 kcal on 2 of 7 days", or "Not recorded on any day"), and a "Movement by day" list of the seven days with
"Not recorded" for a missing value, "No movement recorded" for a day without a record, the source for each recorded day
and "Saved in <zone>" only when the stored zone differs from the week's. The block stacks on narrow screens; the
Chromium test checks no horizontal overflow at 375 px with a wide font. A heading containing "week" was rejected
because it made `getByLabel('Week')` (substring match) ambiguous with the week picker.

A week with a movement record, including one with only recorded zeros, is not an empty week ("Nothing is recorded for
... yet." is not shown). Loading, retry, refreshing and access-denied states are unchanged.

**Separate refresh signals.** The Check-in screen keeps two keys (`check-in-refresh.ts`): a confirmed check-in save or
deletion advances both the review key and the AI insight key, as before; a confirmed movement save or deletion
(`DailyMovementSection` `onChanged`, called from the controller's `onSaved`/`onDeleted`, which fire only after a
confirmed response) advances the review key only. The review's controller re-reads the selected week (refresh never
changes the week; latest request wins, so an older answer that still has a deleted day never replaces a newer one, and
an error does not keep the previous answer). The AI insight section makes no request and cannot be regenerated by a
movement change (the Chromium test records no insight request after the week was chosen). Session and organization
isolation are as before (the screen is keyed by them).

## Decision 5: AI boundaries are pinned, not only promised

- Movement stays outside the AI aggregate, the shared fact catalogue, input hashes, prompts, policies and freshness,
  source gates and invalidation triggers; migration 0034's movement replay exception is unchanged;
  `WEEKLY_INSIGHTS_PROVIDER` stays `off` by default.
- Unit: building a review with movement leaves the aggregate deep-equal and its input hash unchanged; facts, data gaps
  and coverage are equal with and without movement.
- HTTP (FakeProvider, a real stored ready insight): a movement first write, replacement, a write and deletion, a
  simulated restore of the deleted day and its erasure replay (`erased`, then `absent`) each leave the insight row (id,
  input hash, source revision, status, attempts, `updated_at`, output digest), the person's gate revision and the
  insight view (freshness `current`) identical, with no provider call; the review saw every step. A check-in added
  afterwards makes the same insight `stale`, so the pin can detect a change.
- The ADR-0078 separation test now compares the review's AI-shared parts (coverage, facts, data gaps, week, non-movement
  statements) before and after movement writes instead of the whole response.

## Verification and mutation checks

See the final report and `docs/progress.md` for the counts. Mutations, each red then restored: the column back at
`numeric(6,1)` without the precision constraint (15 database tests failed); the review transaction without its
`REPEATABLE READ` snapshot (the interleaving test failed); energy added as floats (the 0.1 + 0.2 test failed); the
manual-source filter removed (the boundaries test failed); the Check-in screen not wiring `onChanged` (the Chromium
scenario failed at the first review update).

## Consequences

- The weekly review response grows by a fixed-size `movement` part (7 days) and up to four statements; the OpenAPI
  document and the review version change. A client relying on `weekly-review-1` statement lists sees `movement.none`
  in every week without movement.
- New active energy values keep the scale they were written with; readers must compare numerically (all current
  readers do).
- The weekly review now reads one more indexed range (the owner/date/source unique key) per request.

## Not established

- No phone, watch or import source exists; with one, the aggregation must pick one source per day (ADR-0078 Decision 3)
  instead of filtering on `manual`.
- Movement is not in multi-week trends, comparisons or AI insights; whether AI text may cite it needs its own decision,
  a prompt and policy version, and a fresh validation set.
- A day saved in a zone far from the week's zone still counts on its own calendar date; the review explains it but does
  not reconcile it with activity instants (by design: daily totals have no instant).
- The browser flow ran only in Chromium on Windows.

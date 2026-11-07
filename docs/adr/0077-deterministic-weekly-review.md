# ADR-0077: A deterministic weekly review, independent of model generation

- Status: accepted; implemented and verified locally (unit, real PostgreSQL integration, Chromium end-to-end with
  generation off). Hosted CI: see the final report of the change.
- Date: 2026-11-07
- Relates to: ADR-0076 (weekly insights; its prompt-experiment addendum named this as the preferred next decision),
  ADR-0074 (check-ins: a day is a local date; "today" by the server clock in the client's zone), ADR-0072/0073
  (owner-only activities, erasure ledger).
- Scope: `GET /api/orgs/:orgId/weekly-review`, `apps/api/src/insights/weekly-review*.ts`,
  `packages/contracts/src/weekly-review.ts`, the Weekly review section of the web Check-in tab, a provider-off API in the
  browser suite. No migration, no new table, no background job, no cache, no new dependency, no new prompt or safety rule.

## Context

The bounded prompt experiment (ADR-0076, addendum) ended with qwen3:8b and `weekly-insight-v4` producing 8/10 accepted
answers on the frozen validation weeks, one of which said "Sleep was logged on every check-in day" for 3 nights out of 4
check-in days. The product target was not met and `WEEKLY_INSIGHTS_PROVIDER` stays `off` by default, so for most people
the Check-in tab had no weekly view at all. What the accepted answers found useful (coverage, what was and was not
recorded, ranges, GPS distance gaps) is computable, and computing it removes the failure that blocked the model.

## Decision 1: a read API that makes no model call and stores nothing

`GET /api/orgs/:orgId/weekly-review?weekStart=YYYY-MM-DD&timeZone=<IANA>`, authenticated, owner-only,
`Cache-Control: no-store` on every response, errors included.

- **Independent of generation.** `WeeklyReviewService` knows neither the insight service nor any provider; it is built
  in `app.ts` from the pool and the clock only. It works with `WEEKLY_INSIGHTS_PROVIDER=off`, without a
  `weekly_insights` row, and does not enqueue anything (tested: zero provider calls and zero insight rows after reads,
  and a 200 review while the week's insight is `generation_failed`).
- **One snapshot.** One `REPEATABLE READ READ ONLY` transaction runs the membership check and the existing
  single-statement source query (`weekSourcesSql` via `computeWeek`): check-ins, manual activities and the person's own
  finished GPS runs with their current summaries. A source deleted before the read began is absent; nothing is cached, so
  the next read after a deletion commits excludes it (tested over HTTP for a check-in and an activity).
- **Ownership.** Row-level security plus explicit `user_id = <session>` predicates in the source query; GPS runs are
  filtered by owner, so runs that run sharing makes readable never count (tested with a grantee holding history grants).
  Another member, a grantee and another organization see only their own (empty) data or `403 ORG_ACCESS_DENIED`.
- **Validation.** `weekStart` must be a Monday not before 2000-01-01 and not after today in `timeZone` (400, as for the
  insight request); `timeZone` must be an IANA name; unknown query fields are refused.
- **Reuse.** The aggregation (`aggregateWeek`), fact catalogue (`buildFacts`) and data gaps (`dataGapsOf`) are the ones
  AI insights use. The aggregate is not changed, so every stored insight's input hash, and therefore its freshness, is
  unaffected (pinned by a unit test).

## Decision 2: statements written by code, with explicit denominators

`describeWeek(aggregate, detail)` is a pure function with explicit conditions and a closed set of stable statement codes
(`weeklyReviewStatementCodes`): `week.*`, `check_ins.*`, `sleep_duration.*`, `sleep_quality.*`, `mood.*`, `soreness.*`,
`weight.*`, `manual.*`, `gps.*`, `sources.*`. A client may rely on a code's meaning; the wording may change with
`WEEKLY_REVIEW_VERSION` (`weekly-review-1`).

Denominators, also returned as `coverage`:

| Field | Meaning |
| --- | --- |
| `daysInWeek` | 7 (Monday to Sunday in the week's zone) |
| `daysWithCheckInRecord` | days with any check-in, a note-only one included |
| `daysWithCheckInValues` | days with at least one numeric value (weight, sleep duration, sleep quality, mood, soreness) |
| `noteOnlyDays` | `daysWithCheckInRecord - daysWithCheckInValues`: labelled, never counted as days with values |
| `metrics.<metric>.daysRecorded` | days with that value; never more than `daysWithCheckInValues` |
| `sleepQualityWithoutDurationDays` | days with a quality rating and no duration |
| `manualActivities.count / withDistance` | activities, and those with an entered distance |
| `gpsRuns.count / withCurrentDistance / withoutCurrentDistance` | runs, split by whether a current summary exists |

Rules: every metric sentence names its denominator ("on 3 of 4 days with check-in values", "on all 7 days", "on the
only day"). Sleep duration and sleep quality are separate sentences; a quality-only day is said not to count as a day
with recorded duration. A value that was not recorded is "not recorded"/"not rated", never zero; a recorded zero is a
value. No weight direction from a single measurement ("A change needs at least two measurements"). A GPS distance comes
only from current summaries, and a partial one names the runs it covers; with none current, no distance is given. Manual
runs and GPS runs are separate sentences, never added, with the overlap notice when both exist. Mixed zones, a zone taken
from the request, and a week in progress each have a sentence. Units, directions and plural forms are code. There are
no judgements, diagnoses, causes, advice or comparisons with a "usual"; a unit test scans every generated sentence of
several weeks, including extreme ones, for such words.

The few counts the aggregate does not carry (record days, quality-only days, manual activities with a distance, zones)
come from the same source rows and week filter (`reviewDetailOf`), so they share the snapshot.

**The regression the experiment exposed.** Four days with values, sleep duration on three: the review says
"Check-ins with values on 4 of 7 days of the week." and "Sleep duration was recorded on 3 of 4 days with check-in
values."; no sleep sentence contains "every", "all" or "each" (unit test, HTTP test and Chromium test). The frozen
validation case `val_weight_up_manual_runs` is imported read-only and gives the same sentence. Mutation check: making
the sleep sentence use the check-in day count failed 5 unit tests.

The missing-days data gap now reads "No check-in values on N of 7 days; averages use the days that have them." (it said
"No check-in on"), so it stays true for a note-only day. It is code-written text, not part of the prompt or of any
validation, so this changes no AI behaviour.

## Decision 3: provenance that cannot be mistaken for an AI insight

`provenance = { source: 'computed_by_app', persisted: false, snapshot: 'single_read_only_transaction', reviewVersion,
policyVersion, computedAt }`, all but the versions and time as literal types in the contract. An AI insight has a model, a
prompt version, an id and a creation time, and is stored; the review has none of these and is recomputed per read. The
web shows the review with a "Computed by the app" label and never attaches its facts to AI text: the AI section shows only
the facts stored with its own output.

## Decision 4: the review is the primary weekly view; AI text is a separate, optional section

On the Check-in tab, a **Weekly review** section (week picker, statements, coverage, numbers, data gaps, effective zone,
computation time; loading, empty, error with Retry, access-denied and refreshing states) comes first. The former panel is
now **AI insight (optional)** below it and follows the week chosen in the review; its states, bounded polling, stale and
outdated-policy behaviour are unchanged, and rejected model text is never shown or relabelled.

`WeeklyReviewController` (framework-free) reads on start, on a week change, on Refresh and after a check-in of this person
is saved or deleted. It does not poll. The latest request wins (an older answer is dropped), a week change clears the
previous week at once, an error does not keep the previous answer (it could still contain a deleted record), and a
session or organization change disposes the controller (the screen is keyed by them), which aborts its request and
silences late answers. The two sections have independent controllers: an AI failure, timeout, rejection or disabled
state leaves the review as it is.

## Privacy and erasure

No change to source gates, the erasure ledger, replays, row-level security or model validation. The review is never
stored, so there is no derived copy to erase; responses are `no-store`; the request log records the route, status and
timing only (the logger's allow-list drops anything else), never a body or a health value.

## Test harness

The browser scenario needs generation explicitly off, but the suite's main API runs the FakeProvider for the AI specs
and the OIDC API has an absolute 20 s session (for its expiry test), too short for a scenario of saves. The suite now
starts a second development-session API (port 3102, `WEEKLY_INSIGHTS_PROVIDER=off`, run-search interpreter off) and a
demo-enabled Vite proxying to it (5277). Test harness only; no product configuration changed.

## Deferred

- Multi-week trends, comparisons between weeks, personal baselines ("usual"): need their own definitions.
- A unified read model over manual and GPS runs, and activity deduplication: overlap is only reported.
- Per-day breakdowns in the review, and wording beyond English.
- The fact labels shared with AI insights ("Days with a check-in", "Days without a check-in") count days with values;
  renaming them changes the prompt input and belongs with a prompt version change.
- Whether AI text should be offered at all for a week the review already describes well: a product decision after a
  fresh validation set, not part of this change.

# ADR-0074: Daily check-in metrics: local date and time zone, and PUT as full replacement

- Status: accepted; implemented and verified locally
- Date: 2026-11-06
- Amends: ADR-0073 (the erasure-ledger extension point is used for a second entity; the "frozen application clock"
  limitation is closed for the API path, because activity creation instants now come from the database clock).
  RLS semantics and idempotency behaviour of activities (ADR-0072, ADR-0073) are unchanged.
- Scope: migrations 0028 and 0029, `packages/contracts`, `apps/api` (daily metrics service and routes, activity
  creation, restore drill), `apps/web` (Check-in tab), tests, docs. No new dependency and no new infrastructure.

## Context

Step 2 of the product direction is a daily check-in: weight, sleep, sleep quality, mood, soreness and a note, at most
one record per person per day, owner-only like activities. Two choices shape the whole slice and are recorded here:
what "a day" is, and how a day is written.

Found while inspecting the code: **the application stores no time zone for a person.** There is no profile table or
column. The run search (ADR-0056) already takes the browser's IANA zone as a parameter of each request and computes
calendar periods on the server against the injected clock; the web client reads it with
`Intl.DateTimeFormat().resolvedOptions().timeZone`.

## Decision 1: a check-in belongs to a local calendar date

- The record's key is `(org_id, user_id, local_date)`, where `local_date` is a PostgreSQL `date`: the date as the
  person read it on their calendar. It is **not** an instant or a UTC interval. A check-in describes a day of the
  person's life ("I slept 7 h 30 the night before Tuesday"); converting it to instants would make a day move, split or
  merge when the person travels or a zone's rules change. `YYYY-MM-DD` is also what every request and answer carries.
- **"Today" is the date of the injected clock's instant in the zone the person is in now**, sent as `timeZone` (IANA)
  in the PUT body and validated like the run search's zone. A `localDate` after that date is `400 INVALID_REQUEST`;
  the message names the server's "today" and the zone. The rule depends on a clock, so it is checked by the service,
  not by a CHECK constraint (a CHECK using `now()` would be revalidated against another clock when a dump is restored),
  exactly as for `activities.started_at` (ADR-0072). The static lower bound `2000-01-01` is a CHECK and a contract rule.
- **The zone of the first write is stored** in `time_zone` (the platform's canonical spelling) and is never rewritten:
  the runtime role has no UPDATE privilege on it, and a replacement does not set it. A later change of zone (travel, a
  new device, or a profile setting added later) does not touch existing rows: neither their `local_date` nor their
  `time_zone`. A new day written from the new zone stores the new zone.
- Reads take dates only: `GET /daily-metrics?from=&to=` (inclusive, at most 92 days, `from` not after `to`, not before
  2000-01-01) and `GET /daily-metrics/{localDate}` need no zone. `DELETE` of a future date is a `204` like any absent day.

### Options considered for the zone

| Option | For | Against |
|---|---|---|
| **A profile time zone column and settings UI** | One server-side truth; a client cannot pick a zone per request | Does not exist today: a new column or table, an endpoint, a settings screen and a migration of the web client, for a slice that only needs "today"; still wrong the day the person travels until they change the setting |
| **The zone the client sends with each write** (chosen) | Already the codebase's pattern (run search); follows the person when they travel; no new state | The client chooses the zone, so it can claim the zone where the date is latest |

Chosen: the per-request zone. The trust it gives up is small and bounded: the latest calendar date anywhere on Earth is
at most one day after the UTC date (UTC+14), and the data is the person's own. If a profile zone is added later, the
client sends that zone instead and nothing on the server changes.

## Decision 2: `PUT /daily-metrics/{localDate}` replaces the whole day

- The body is the whole day: the six value fields plus `timeZone`. Omitted and `null` are the same and clear the field;
  at least one value is required (also a CHECK, `num_nonnulls(...) >= 1`). There is no PATCH: the form always shows and
  sends the whole day, and a merge would need its own rules for clearing a field.
- **Naturally idempotent, no idempotency key.** The target is the natural key, and the body is the whole state, so a
  retry after an unknown outcome converges to the same row. Activities needed a key (ADR-0073) because creating one has
  no natural key; a day has one.
- `201` when the day is first written, `200` when it is replaced or already held these values (consistent with the
  activity PUT). One statement does it: `INSERT ... ON CONFLICT (org_id, user_id, local_date) DO UPDATE ... WHERE
  (stored values) IS DISTINCT FROM (new values) RETURNING ..., (xmax = 0) AS inserted`. An exact retry therefore updates
  nothing and leaves `updated_at` as it was; the service then reads the day. Two concurrent writes of the same day give
  one row and the later values (last writer wins); a test interleaves two transactions explicitly to prove it.

## Decision 3: database clocks and column privileges

- `daily_metrics.created_at` and `updated_at` default to `clock_timestamp()`; a BEFORE UPDATE trigger sets `updated_at`
  on every replacement. It is not a BEFORE INSERT trigger, so a restore (COPY) keeps the stored instants.
- The runtime role has column-level privileges only: INSERT on the columns the application supplies, UPDATE on the six
  value columns. It cannot write the id, the owner, the organization, the date, the zone or either timestamp. RLS has
  four owner-only policies (SELECT, INSERT, UPDATE with USING and WITH CHECK, DELETE) with the predicate of activities;
  the maintenance role has nothing.
- **Activities: migration 0029** sets `activities.created_at` to default to `clock_timestamp()`, and the service no
  longer sends it. Ledger version identity of activities created through the API no longer depends on the application
  clock. `clock_timestamp()`, not `now()`: a delete and a re-create of one id inside one transaction would otherwise get
  equal instants. Deliberately not done: removing the runtime role's table-level INSERT on `created_at` would change
  the ACL that ADR-0072's access tests pin (they insert as the runtime role with an explicit `created_at`). Direct SQL
  as the owner can therefore still choose `created_at` for the owner's own row, which only affects that owner's own
  erasure identity.

## Decision 4: erasure ledger extension

Through the extension point of ADR-0073, in migration 0028: `daily_metric` in `erasure_ledger_entity_type_known`, an
AFTER DELETE trigger `daily_metrics_record_erasure`, an `ELSIF` branch in `app_private.reapply_erasure` (created again
with `CREATE OR REPLACE`, which keeps its owner and empty grants), and `daily_metric` in `erasureEntityTypes`. A day has
a surrogate `id` (`gen_random_uuid()`), which is the ledger's `record_id`; the version is `(id, created_at)`.
A replacement keeps both, so deleting a day after replacing it still erases the older values a backup holds. A day
deleted and written again is a new row with a new id: replaying the old erasure finds no row with its id (`absent`)
and leaves the new day alone.

The migration is split on purpose: `0028` (daily metrics) and `0029` (activity default). The restore drill restores a
backup taken one migration behind the repository; with the split, that backup contains `daily_metrics`, so the drill
deletes a day after the backup and proves its replay through a real `pg_dump`/`pg_restore`, then migrates to `0029`.

A test pins that neither application role holds TRUNCATE on `activities`, `daily_metrics` or `erasure_ledger`:
TRUNCATE fires no row trigger and would erase health data without a ledger entry.

## Consequences

- One more owner-only table, router and web tab (**Check-in**); the cleanup lists (tenant fixture, browser cleanup,
  load seeder) gain `daily_metrics` before `erasure_ledger` and `memberships`.
- The erasure ledger and the journal directory now also hold identifiers of erased check-in days (no values).
- The restore drill's scenario deletes two owner-only records after the backup (activity E and day G) and expects two
  `erased` outcomes, then two `absent`.
- The activity HTTP test that pinned `createdAt` to the injected clock now asserts the database clock instead.

## Not established

- **Lost update between devices.** Two devices editing the same day both succeed; the later write wins without a
  warning. There is no version precondition (`If-Match`/`updatedAt`); one is easy to add if it matters.
- **The zone is the client's word.** A client can pick the zone where the date is latest (at most one day ahead of
  UTC). The browser and the server may disagree about a very new zone name (the server refuses names it does not know).
- **No stored profile zone**, so the stated rule "changing the profile time zone later does not rewrite existing rows"
  holds trivially: nothing ever rewrites `local_date` or `time_zone`.
- The web screen fixes "today" when it opens; across midnight it keeps the previous day as the latest selectable date
  until it is opened again (the server still refuses a date after its own "today").
- No delete control in the web screen (the API has one), no charts, no trends, no unit other than kilograms.
- The activities runtime role can still state `created_at` in direct SQL (see Decision 3).
- Erasures committed but not yet exported when the node is lost still come back with an old backup (ADR-0073).

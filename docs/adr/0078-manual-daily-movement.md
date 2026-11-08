# ADR-0078: Manual daily movement: steps and active energy as their own owner-only entity, with server-owned provenance

- Status: accepted; implemented and verified locally (unit, real PostgreSQL integration including the restore drill,
  Chromium end-to-end). Hosted CI: see the final report of the change.
- Date: 2026-11-08
- Relates to: ADR-0074 (a day is a local calendar date with the zone of its first write; "today" by the server clock in
  the client's zone; PUT as full replacement), ADR-0073 (erasure ledger and its extension point), ADR-0075 (delete
  control and one-mutation-at-a-time rule of the Check-in screen), ADR-0076/0077 (weekly insights and review, which this
  slice deliberately does not feed).
- Scope: migrations 0033 and 0034, `packages/contracts/src/daily-movement.ts`, `apps/api/src/daily-movement/*`, the
  erasure-ledger file format and the restore drill, the Movement section of the web Check-in tab, tests, docs. No new
  dependency, no new infrastructure, no change to weekly insights, the weekly review, GPS capture or check-ins.
- Product direction: SomaLane is the working product name (`docs/product-direction.md`); packages, database
  identifiers, cookies, environment variables and the repository keep their names.

## Context

The next bounded slice of the data foundation is daily movement: the number of steps and the active energy a person
saw for a day, entered by hand. A phone or watch integration will come later and must be able to store its own data
without overwriting what the person typed, and without two sources being added into one inflated daily total. Nothing
here may estimate calories, talk to a model or give advice.

## Decision 1: a dedicated `daily_movement` table, not two more check-in fields

`PUT /daily-metrics/{localDate}` replaces the whole check-in (ADR-0074): a field a client does not send is cleared.
Adding `steps` to it would make every existing client, which never sends `steps`, erase movement on its next save.

| Option | For | Against |
|---|---|---|
| **Columns on `daily_metrics`** | One row and one request per day | Breaks existing clients (full replacement clears unknown fields); couples two unrelated forms; any future import would write into the check-in row |
| **PATCH on `daily_metrics`** | Partial update | A second write contract for the same row with its own clearing rules; still no room for a second source |
| **Own table and routes** (chosen) | Existing contract untouched; own erasure entity; own provenance key | One more table, router and section |

Columns: `org_id`, `id` (`gen_random_uuid()`), `user_id`, `local_date`, `source`, `time_zone`, `steps integer`,
`active_energy_kcal numeric(6,1)`, `created_at`/`updated_at` (`clock_timestamp()`, a BEFORE UPDATE trigger on update).

Values and bounds (contract and CHECK constraints agree):

| Field | Type | Bounds | Notes |
|---|---|---|---|
| `steps` | integer or null | 0 to 200,000 | A recorded 0 is a value; null is unknown |
| `activeEnergyKcal` | number or null | 0 to 20,000, at most one decimal | `numeric(6,1)`: 0.1 kcal precision; more decimals are **refused**, never rounded; NaN/Infinity refused |
| at least one | | `num_nonnulls(steps, active_energy_kcal) >= 1` | |

The bounds are technical (typing slips, overflow), not health judgements. **Active energy** is the user-reported active
energy, as a device or app shows it: not resting energy, total expenditure or food intake. Nothing is derived from
steps, and the UI states what the field is and is not.

## Decision 2: dates, writes and reads follow ADR-0074 exactly

- One manual record per `(org_id, user_id, local_date)`; the unique key is `(org_id, user_id, local_date, source)` with
  `source` restricted to `'manual'` (Decision 3).
- `PUT /api/orgs/:orgId/daily-movement/:localDate` replaces both values (omitted = null = cleared); `201` on the first
  write, `200` otherwise. One `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE (stored) IS DISTINCT FROM (new)`: an exact
  retry updates nothing, so the identity, `created_at` and `updated_at` stay as they were. Two racing first writes meet
  on the unique key: one row, last writer wins (tested with two explicitly interleaved transactions).
- `timeZone` (IANA) is required on PUT; the date must be a real date not before 2000-01-01 and not after today in that
  zone by the **injected server clock** (shared `assertNotAfterToday`, tested at local midnight across the Warsaw
  spring-forward and New York fall-back changes and at UTC+14/UTC-11). The zone of the first write is stored and never
  rewritten: the runtime role has no UPDATE privilege on it.
- `GET .../daily-movement?from=&to=` uses the daily metrics bounds (inclusive, at most 92 days, the same constants);
  `GET .../:localDate` answers `404 DAILY_MOVEMENT_NOT_FOUND` for a missing day and for anyone else's.
- `DELETE .../:localDate` is a hard delete, `204` in every case.
- Every response under the path carries `Cache-Control: no-store`, errors included. The header is mounted **before**
  the JSON body parser as well, so a malformed body's `400` carries it too. (The check-in routes set it only inside
  their router, so a malformed check-in body's `400` does not; left unchanged here, noted below.)

## Decision 3: provenance is server-owned, and later imports get their own rows

`source text NOT NULL DEFAULT 'manual'` with `CHECK (source IN ('manual'))`. The runtime role has **no** INSERT or
UPDATE privilege on `source` (nor on `id`, `user_id`/`org_id` updates, `local_date` updates, `time_zone` updates or the
timestamps), so a client cannot name an owner (RLS and the session), an organization (RLS and the path) or a source
(no request field, no privilege). The contract refuses a `source` field; the view returns `source: "manual"`, which
the web shows as "Manually entered". The manual routes read, write and delete only `source = 'manual'` rows.

How a later phone or watch integration fits, without building it now:

1. Its rows go into the same table with their own `source` value (for example a platform name), added to the CHECK in
   its own migration and ADR. Because the unique key contains `source`, an import for a day never conflicts with,
   overwrites or deletes the manual row; the manual routes keep ignoring imported rows.
2. Import-specific provenance (device or app identifier, sync batch, the platform's sample window) goes into new
   nullable columns or a side table owned by the importer, written by a server-side importer path, never by the manual
   PUT. Raw samples, if ever needed, are a separate table; this one stays one total per day per source.
3. **Sources are never added together.** A read model that needs one number per day picks exactly one source per day
   by an explicit precedence (proposed default: the person's manual entry wins over an import for that day, otherwise
   the import), and reports which source it used. Summing a manual and an imported total for one day would count the
   same steps twice.
4. Erasure works per row and per source: each row has its own id and version, so deleting one source's day leaves the
   other.

Not built: any importer, device identifiers, a generic health-data framework, sample tables or a source precedence
read model.

## Decision 4: owner-only access, run sharing never applies

The owner-only template of `daily_metrics`: four RLS policies requiring the current organization, the current identity
as owner and an active membership; the runtime role has SELECT and DELETE, INSERT on the six supplied columns and
UPDATE on the two values; the maintenance role has nothing; neither role has TRUNCATE (TRUNCATE fires no row trigger).
Every service statement also states the owner. Tested as the real roles: owner, another member (coach), a run-sharing
grantee holding history and live grants on the owner's runs, another organization's member, an inactive member and a
missing or malformed context; joins through `runs`, `run_shares` and `memberships` expose nothing.

## Decision 5: the existing erasure mechanism, extended

Through the ADR-0073 extension point, in migration 0033: `daily_movement` in `erasure_ledger_entity_type_known`, an
AFTER DELETE trigger `daily_movement_record_erasure` (SECURITY DEFINER, granted to nobody) that writes the ledger row in
the deleting statement (if it cannot, the DELETE fails and the API answers 500 with the day kept), a `daily_movement`
branch in `app_private.reapply_erasure_record`, and `daily_movement` in `erasureEntityTypes` of the strict file reader.
Export (`erasure-ledger-*.ndjson`), the replay command, its outcomes (`erased`, `absent`, `skipped_different_record`)
and the bounded drill connection limits are unchanged and reused.

Version identity is ADR-0074's: `(id, created_at)` with both from the database. A replacement keeps both, so a later
deletion still erases the older values a backup holds. A day deleted and written again is a new row with a new id and
a new `clock_timestamp()` instant (different even inside one transaction): the old entry finds no row with its id
(`absent`), or, if a row reused the id with another instant or owner, `skipped_different_record`. It never deletes the
new day.

**Migration 0034 keeps movement replays away from AI insights.** Since 0032 the public `reapply_erasure` wraps the
record-level replay and, for every outcome, advances the ledger owner's insight source gate and deletes the owner's
insights created at or after the record, because an entry does not say which week it was in. Movement is not an
insight source, so for `daily_movement` entries the wrapper returns the record outcome and touches no insight and no
gate revision. Activity and check-in entries behave exactly as before (tested both ways). It is a separate migration on
purpose: the restore drill restores a backup one migration behind the repository (ADR-0074), so the drill's backup (at
0033) contains movement rows and the drill proves a movement erasure through a real `pg_dump`/`pg_restore`.

What is proven, and where:

| Claim | Test |
|---|---|
| Restoring a backup cannot resurrect an exported deletion after replay | Restore drill (`backup-restore.integration.test.ts`, real `pg_dump`/`pg_restore`): movement day M deleted after the backup is back after restore, gone after replay; day N untouched (`erased-daily-movement-*`, `surviving-daily-movement-untouched`) |
| Replaying twice is safe | Drill second pass (all `absent`, state identical); HTTP and SQL tests |
| Delete and recreate gives a version an old entry cannot delete | HTTP test (export, restored copy, replay: `absent` for the recreated day, which stays) and SQL tests (new id and instant; a reused id with another instant is `skipped_different_record`) |
| Deletion and outbox are atomic | SQL and HTTP tests with a ledger CHECK that refuses the entry: the DELETE fails (500), the day stays, no ledger row |

## Decision 6: a Movement section on the Check-in tab

Below the check-in form and its history, above the weekly review: its own form (`Daily movement`: date, "Steps
(optional)", "Active energy (kcal)" with a hint on what it is and that empty is not 0), the explicit source line
"Source: Manually entered", Save, edit through the history, and Delete behind a confirmation; a 14-day history
("Movement history") with every day, recorded values, "Not recorded" for a missing value and the source; loading, empty,
validation, failure with Retry and saving states. It states that phone and watch synchronization is not connected yet.

`MovementDayController` and `MovementHistoryController` follow the check-in controllers: a date change clears the
previous day at once and aborts its request, and only the latest request for the selected date may change what is shown
(an earlier date's late answer or failure is dropped; tested); one mutation at a time; the controllers follow the
session's signal and are disposed with the screen, which the parent keys by session, person and organization, so no
late answer from a previous scope can appear. Saving or deleting movement does not refresh the weekly review or the AI
insight, which do not read it. The check-in form, its request and its semantics are unchanged.

## Boundaries kept

- No model call, no calorie estimation, no meal logging, no upload, no advice. `WEEKLY_INSIGHTS_PROVIDER` stays `off`
  by default.
- Movement is not an input of AI insights (facts bundle, input hashes, policies, source triggers and gates unchanged;
  writing, replacing and deleting movement changes no insight row and no gate revision, tested) and the weekly review
  contract is unchanged (its response is identical before and after movement writes, tested).

## Consequences

- One more owner-only table, router and Check-in section; the cleanup lists (tenant fixture, browser cleanup, load
  seeder) gain `daily_movement` before `memberships`.
- The erasure ledger and the journal directory also hold identifiers of erased movement days (no values). The restore
  drill now deletes three records after the backup (activity E, check-in day G, movement day M).
- The drill's insight fixture now always uses the post-0032 shape: with 0034 added, the drill's older schema is 0033.
- `transportTimestamp` and `canonicalTimeZone` of the check-in service are exported and shared; four small helpers of
  the check-in controller are exported for the movement controllers. No behaviour change.

## Not established

- **No import exists.** Nothing has been tested against a phone, watch or health platform; the provenance plan above is
  a design, not an implementation.
- Lost update between devices: two devices editing the same day both succeed, the later wins (as for check-ins).
- The zone is the client's word (at most one day ahead of UTC), as in ADR-0074.
- The web screen fixes "today" when it opens (as for check-ins).
- A malformed check-in body's `400` has no `no-store` header (pre-existing, not changed by this slice).
- Movement is not shown in the weekly review or in trends; whether and how it enters them is a later decision.
- Erasures committed but not yet exported when the node is lost still come back with an old backup (ADR-0073).

## Addendum (2026-11-08, ADR-0079)

- **Precision gap closed.** Decision 1 said more decimals are refused, never rounded; that held for the API only. A
  `numeric(6,1)` column rounds before CHECK constraints run, so a direct database write of 412.55 became 412.6 and
  -0.01 became 0.0. Migration 0035 makes the column an unconstrained `numeric` with a precision CHECK
  (`value = round(value, 1)`) beside the range CHECK; the database now accepts exactly what the contract accepts (tested
  through the runtime role). A value keeps the scale it was written with (`0` rather than `0.0`); the API view is
  unchanged.
- **Movement is now shown in the weekly review** ([ADR-0079](0079-weekly-review-movement.md)), review-only: it is still
  not an input of AI insights (facts, hashes, policies, gates, triggers and the 0034 replay exception unchanged), and a
  movement save or deletion now refreshes the review, never the AI insight. The "Boundaries kept" and "Not established"
  lines above about the weekly review describe the state before ADR-0079.

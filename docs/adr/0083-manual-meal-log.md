# ADR-0083: Manual meal log: owner-only entries with optional user-reported nutrition totals, and recorded totals in Today

- Status: accepted; implemented and verified locally (unit, real PostgreSQL integration including the restore drill and
  a current-schema meal restore, Chromium end-to-end including a 375 px viewport). Hosted CI: see the final report of the
  change.
- Date: 2026-11-09
- Amended by: [ADR-0092](0092-meal-draft-from-text.md) (an optional, off-by-default "Draft from text" that proposes
  values into this form from one meal description; a confirmed draft is saved by the same create route with `source:
  manual`, read as "entered or confirmed by the person". Table, contract, idempotency and erasure unchanged.)
- Relates to: ADR-0072/0073 (owner-only activities, erasure ledger, idempotent creation per form session), ADR-0074 (a
  day is a local calendar date with the zone of its first write; "today" by the server clock in the client's zone),
  ADR-0078/0079 (server-owned provenance; unconstrained numeric with precision CHECKs; replay outside AI insights),
  ADR-0082 (Today's one snapshot, stored-date attribution, editor intents).
- Scope: migration 0039, `packages/contracts/src/meals.ts`, `apps/api/src/meals/*`, the erasure-ledger file format, the
  daily overview (`daily-overview-2`), the web **Meal log** view and the Today meal card, tests, docs. No new dependency,
  infrastructure, model call, parser, photo, barcode, import or recommendation. Weekly review, AI insights (inputs,
  policies, gates) and the Runner (startup, recording, offline queue, recovery) are unchanged.

## Context

The last item of the data foundation is the meal log. A person should be able to write down what they ate, with as much
or as little nutrition as they know, see it on Today next to the rest of their day, and be sure that a deletion stays
deleted after a restore. Nothing may estimate, look up or judge food, and food energy must not be confused with the
active energy of movement.

## Decision 1: a dedicated `meals` table; one row is one logged entry

One row per meal or snack entry, not one per day: people eat several times a day and edit or delete one entry at a time.

| Column | Rule |
|---|---|
| `id` | `gen_random_uuid()`; the runtime role cannot write it |
| `org_id`, `user_id` | From the tenant context (RLS `WITH CHECK`), never from a request field |
| `local_date`, `time_zone` | The calendar date the entry belongs to and the IANA zone of its first write (ADR-0074); not updatable |
| `meal_type` | `breakfast`, `lunch`, `dinner`, `snack` or `other` |
| `title` | Required, 1..120 code points, no NUL, not blank |
| `energy_kcal`, `protein_g`, `carbohydrate_g`, `fat_g` | Optional user-reported **totals for the whole entry** (not per 100 g, not per serving) |
| `source` | `'manual'` by default; no privilege for the application |
| `idempotency_key`, `creation_digest` | Decision 3 |
| `created_at`, `updated_at` | `clock_timestamp()`; a BEFORE UPDATE trigger moves `updated_at`; not writable |

**A title-only entry is valid.** People often know what they ate but not its nutrition. Every value is independent:
missing (null) is unknown, a recorded `0` is a value.

**Bounds and precision** (constants in the contract, the same numbers as CHECK constraints):

| Value | Range | Precision |
|---|---|---|
| Food energy | 0 to 20,000 kcal | at most one meaningful decimal |
| Protein, carbohydrate, fat | 0 to 2,000 g each | at most one meaningful decimal |

They are technical bounds (typing slips, overflow), not dietary limits: a 20,000 kcal entry is implausible but storable.
The columns are **unconstrained `numeric`** with a range CHECK and a precision CHECK (`value = round(value, 1)`): a
`numeric(p,s)` type modifier rounds before CHECK constraints run (ADR-0079), so 412.55 would silently become 412.6.
NaN and the infinities fail the range checks. The contract applies the same rules (`finite`, `min(0)`, `max`, one
decimal, `-0` stored as `0`); an integration test sends the same candidate values through the contract and through the
runtime role, on insert and update, and requires identical acceptance and exact storage.

**Text** uses the existing conventions: no NUL (PostgreSQL text cannot hold it), no unpaired surrogate (it would be
stored as U+FFFD). Zod 4.6 measures string length in code points, as `char_length` does, so the 120 bound agrees exactly
(120 emoji are accepted by both). Blank titles: the contract refuses any Unicode whitespace-only title, the database
refuses ASCII whitespace-only titles; the contract is the stricter rule, so nothing the API stores can be refused by the
database. (The older activity and check-in note comments say "UTF-16 code units"; with Zod 4.6 they are code points too.
Not changed here.)

## Decision 2: routes, dates and access

| Request | Answer |
|---|---|
| `POST /api/orgs/:orgId/meals` | `201` created; `200` the same entry for the same key and creation request; `409 MEAL_ALREADY_SAVED` with `details.mealId` for the same key and a different request (nothing stored) |
| `GET /api/orgs/:orgId/meals?localDate=&limit=&cursor=` | One date's entries ordered by `(created_at, id)`; `limit` 1..50 (default 20); keyset cursor bound to person, organization and date (`400 INVALID_CURSOR` otherwise) |
| `GET /api/orgs/:orgId/meals/:mealId` | The entry, or `404 MEAL_NOT_FOUND` (also for anyone else's) |
| `PUT /api/orgs/:orgId/meals/:mealId` | Replaces type, title and the four values (omitted = null); an exact retry changes nothing, not even `updatedAt`; date, zone, id and key are refused fields |
| `DELETE /api/orgs/:orgId/meals/:mealId` | `204` in every case (deleted, already gone, unknown, someone else's) |

- **Dates** follow ADR-0074: a real date not before 2000-01-01 and not after today in the supplied zone by the
  **injected server clock** (shared `assertNotAfterToday`; tested at the UTC+14/UTC-11 edges and across the Warsaw
  spring-forward midnight). The canonical zone of the first write is stored and never rewritten.
- **Access** is the owner-only template: four RLS policies (current organization, current identity as owner, active
  membership), SELECT and DELETE plus column-scoped INSERT (the supplied columns) and UPDATE (the six editable columns)
  for the runtime role, nothing for maintenance, no TRUNCATE. Every statement also names the owner. Run-sharing grants
  never apply: tested as owner, coach member, a grantee holding history and live grants on the owner's runs, an inactive
  member, another organization's member, a missing or malformed context, and through joins from `runs`, `run_shares` and
  `memberships`.
- **`Cache-Control: no-store`** on every response, mounted before the JSON body parser so a malformed body's `400` has it.
- OpenAPI documents the five operations and four schemas; the route-coverage test knows `mealId`.

## Decision 3: idempotent creation compares the original request

The id is the database's, so the idempotency key (ADR-0073's pattern, one per form session, unique per owner and
organization) is the only identity a retry has. `INSERT ... ON CONFLICT (org_id, user_id, idempotency_key) DO NOTHING`
creates the entry; on conflict the entry is read by key. A racing duplicate waits on the unique index and then reads the
winner (tested with two explicitly interleaved transactions and with six concurrent HTTP requests: one `201`, five `200`,
one row).

What is "the same payload" once an entry can be edited? Comparing with the current values would turn a retry of the
original POST into a conflict after an edit made elsewhere, and make a POST equal to the edited values look like a retry.
So the API stores `creation_digest`, the SHA-256 of the canonical **creation request** (date, canonical zone, type, title,
four values; JSON numbers parse to one value, `-0` is `0`, omitted is null), and a retry with the same key is the same
payload exactly when its digest is equal. The retry then returns the entry as it is now. A deleted entry frees its key:
the same form session can log it again, as a new row.

The web form keeps one key per form session: an uncertain outcome (network failure, timeout, 5xx) keeps the key and the
attempt, so saving again (also with changed details) can never create a second entry; a confirmed save, or "Start a new
entry" after `MEAL_ALREADY_SAVED`, starts a new key. A definitive 4xx refusal keeps the key (nothing was stored).

## Decision 4: erasure and recovery reuse the ledger; meals are not an insight source

Through the ADR-0073 extension point, in migration 0039: `meal` in `erasure_ledger_entity_type_known`, an AFTER DELETE
trigger writing `(entity_type, org_id, record_id, owner_user_id, record_created_at, erased_at)` in the deleting
statement (identifiers and version only: never a title, type or value), a `meal` branch in
`app_private.reapply_erasure_record`, and `meal` in `erasureEntityTypes`. If the ledger row cannot be written the DELETE
fails and the API answers `500` with the entry kept. Export, file format, replay command and outcomes are unchanged.

The public `reapply_erasure` wrapper now returns early for `meal` as it does for `daily_movement` (0034): meals are not
read by the facts bundle, input hash, policies or source triggers of AI insights, so writing, editing, deleting or
replaying a meal invalidates no insight and advances no source gate (tested both ways: a check-in replay still does).

| Claim | Proof |
|---|---|
| An exported deletion is reapplied after a real backup/restore | `backup-restore.integration.test.ts`, current schema: entries created by the service as the runtime role, a real `pg_dump`, the entry deleted after it, `pg_restore`, the entry is back, `restore:reapply-erasures` removes it |
| Replaying twice changes nothing | Same test: second pass all `absent`, meal rows identical; HTTP and SQL tests |
| A deleted and recreated entry survives replay of the older deletion | Same test (recreated from the same form session before the backup: the old id is `absent`); SQL test (a row reusing the erased id with another instant is `skipped_different_record`) |
| A surviving entry is unchanged | Same test (row digests equal to the source at backup) |
| Deletion and outbox are atomic | SQL and HTTP tests with a ledger CHECK that refuses the entry |
| The journal carries no content | SQL test (ledger columns, no title or value in its rows) and HTTP test (the exported file contains no title, type, value or zone) |

**Why a current-schema restore test.** The drill restores a backup one migration behind the repository; with 0039 the
newest migration, that backup has no `meals` table. No artificial migration was added to change that (the brief's rule).
The drill's previous-schema run still passes with 0039 as its catch-up migration; meals are proven by a dedicated test
that drives the drill's own operations (`prepare`, `createSourceDatabase`, `seedScenario`, `takeBackup`,
`deleteAfterBackup`, `exportJournal`, `copyJournalReadOnly`, `restoreBackup`, `migrate`, `reapplyErasures` twice) on a
source at the current schema.

## Decision 5: the Meal log view

A **Meal log** navigation entry (after Check-in) and screen: the selected date (2000-01-01..today, "Go to today"), a form
with meal type, title and "Food energy (kcal)", "Protein (g)", "Carbohydrate (g)", "Fat (g)" under "Nutrition for the
whole entry (optional)" with a hint that empty is unknown and 0 is none, the provenance line "Source: Manually entered",
Add, Edit in the same form (Save changes / Cancel edit), Delete behind an inline confirmation, a list of the date's
entries in logged order with Load more, and loading, empty, validation, saving and failure/Retry states.

Controllers follow the established rules: the list controller drops a late answer for a date no longer selected (and
aborts its request), the create controller keeps the form-session key (Decision 3), one mutation at a time, a submit
button disabled while pending (a double click sends one request), and every controller follows the session signal; the
screen is keyed by session, person and organization. Changing the date ends an edit (an entry belongs to its date).

## Decision 6: Today shows recorded totals with independent coverage

The daily overview gains `meals` (`daily-overview-2`): read by a **third statement in the same REPEATABLE READ READ ONLY
transaction**, on the entries' stored `local_date` (like a check-in), manual source only.

```json
"meals": { "count": 3, "source": "manual",
  "energyKcal":    { "recordedEntries": 2, "total": 1061.1 },
  "proteinG":      { "recordedEntries": 1, "total": 30.2 },
  "carbohydrateG": { "recordedEntries": 3, "total": 0 },
  "fatG":          { "recordedEntries": 0, "total": null } }
```

- `count(column)` is the coverage numerator of each metric, independently; `count` is the denominator.
- `sum(column)` is computed in PostgreSQL `numeric`: exact, no binary floating point (ten entries of 0.1 kcal total 1,
  not 0.9999999999999999). A sum of one-decimal values has one decimal and is transported as a JSON number that parses
  exactly. The contract requires `total` to be null exactly when `recordedEntries` is 0; recorded zeros give `0`.
- A day with meals only, also title-only entries, is not empty.
- No title is part of the overview.

The Today **Meals** card (with "Manually entered") shows "3 entries logged for this day." and one row per metric:
"Food energy recorded (kcal) 1,061.1 — Recorded for 2 of 3 logged entries; 1 entry is unknown, so the total covers only
the recorded entries.", "Not recorded for any of the 3 logged entries." for a metric without values. Food energy is
labelled as such and kept apart from movement's active energy: no balance, requirement, target, comparison or advice
(unit and browser tests scan the wording). "Add a meal"/"Open meal log" opens the Meal log on the selected date (an
`EditorIntent` with section `meals`, scoped like the others); "Back to Today" returns to Today on the Meal log's date,
which Today reads again on opening. The snapshot test commits a meal deletion and two insertions between the overview's
statements: the answer shows the earlier state, the next read the later one.

## Boundaries kept

No model call, nutrition parser, food database, serving calculation, calorie estimation, photo, barcode, import,
recommendation or medical interpretation; `WEEKLY_INSIGHTS_PROVIDER` stays `off` by default, AI inputs and policies are
unchanged, and the weekly review's contract and response are unchanged (tested). Runner startup, recording, the offline
queue and recovery are not touched.

## Consequences

- One more owner-only table, router, web view and Today card; the cleanup lists (tenant fixture, browser cleanup, load
  seeder) gain `meals` before `memberships`; the navigation has seven buttons (it wraps at 375 px, tested with a wide
  font).
- The erasure ledger and the journal directory also hold identifiers of erased meal entries (no content).
- The drill's "previous" schema is now 0038.

## Not established

- **No real iPhone, Safari or WebKit evidence**: the 375 px checks are a Chromium viewport with a wide font.
- No per-day entry limit: the overview contract assumes at most 10,000 entries per day (as for activities); more would
  make the overview fail its own schema rather than show a wrong number.
- Lost update between devices: two devices editing one entry both succeed; the later wins.
- The zone is the client's word (at most one day ahead of UTC), as in ADR-0074; "today" is fixed when the screen opens.
- Meals are not shown in the weekly review or in trends, and are not an AI input; any of that is a later decision.
- Erasures committed but not yet exported when the node is lost still come back with an old backup (ADR-0073).
- HealthKit or any other import: not started (no macOS/Xcode access).

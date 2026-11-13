# ADR-0091: TCX import into an owner-only, summary-only activity

- Status: accepted; implemented and verified locally (see "Evidence"). Not run on an iPhone, in Safari or in Firefox.
- Date: 2026-11-13
- Amends: ADR-0072/0086 (a third, server-owned `source`, `tcx`; the import fingerprint becomes unique per owner,
  organization **and source**, migration 0042), ADR-0082 (Today gains `tcxImportedActivities`, `daily-overview-4`),
  ADR-0077/0079/0086 (the weekly review gains `tcxImportedActivities` and the `imported.tcx` statement,
  `weekly-review-4`), ADR-0087/0088 (the history gains `source: tcx` items, `activity-history-3`), ADR-0089/0090 (activity
  trends and their comparison accept `source=tcx`). GPX parsing, its subset, metrics, fingerprints and refusal reasons,
  runs, run summaries, the GPS algorithm, live tracking, tiles, retention, the erasure ledger format, the restore commands
  and every AI insight input are unchanged.
- Scope: migration 0042, `packages/contracts` (`activity-tcx-import.ts` and the contracts listed above),
  `apps/api/src/activities` (`tcx-activity.ts`, `tcx-import-service.ts`, routes), the Today, weekly review, history and
  trends reads, `apps/web` (TCX import panel, controller, labels in every view), OpenAPI, tests at every layer including
  `tests/e2e`, docs. No new dependency.
- Format reference: Garmin's Training Center Database v2 schema,
  <https://www8.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd> (checked 2026-11-13).

## Context

GPX import (ADR-0086) covers files that carry a track. Many devices and services export **TCX** instead, and a TCX file
says something GPX cannot: each lap's own **reported** time and distance (`TotalTimeSeconds`, `DistanceMeters`), whether
or not GPS positions were recorded (treadmill, indoor trainer, pool, a watch without a fix). The product direction lists
TCX as the next import format. As for GPX, the first slice is one format, one activity, a summary only, and an explicit
preview and confirmation.

What the schema says, and what it does not say, decides the subset:

- `TrainingCenterDatabase` (namespace `http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2`,
  `elementFormDefault="qualified"`) has optional `Folders`, `Activities`, `Workouts`, `Courses`, `Author`, `Extensions`.
- `Activities` holds `Activity*` then `MultiSportSession*`. `Activity` has a required `Sport` (Running, Biking, Other), one
  `Id` (`xsd:dateTime`), one or more `Lap`, then optional `Notes`, `Training`, `Creator`, `Extensions`.
- `Lap` (`ActivityLap_t`) has a required `StartTime` attribute (`xsd:dateTime`) and the children `TotalTimeSeconds` and
  `DistanceMeters` (both `xsd:double`, both required), required `Calories`, `Intensity` and `TriggerMethod`, optional heart
  rate, speed and cadence, `Track*`, `Notes`, `Extensions`. A `Trackpoint` requires `Time`; its `Position` is optional.
- **The schema documents neither field's meaning.** It does not say whether `TotalTimeSeconds` excludes pauses. A
  `CourseLap` inside `Courses` is also an element named `Lap`. `xsd:dateTime` allows a value without a zone, and
  `xsd:double` allows `NaN`, `INF`, negative values and exponents.

So the import must not claim more than "the sum of what the laps report", must identify a lap by its place in the
document and not by its name, and must refuse the parts of the lexical spaces that cannot be a total.

## Decision

### 1. Flow and storage

Select a file, preview what the server computed, choose the activity type, confirm. Confirmation creates one row in
`activities` with `source = 'tcx'`: start, reported duration, distance, type. No file, trackpoint, position, route, heart
rate, cadence, power, speed, calories, intensity, trigger method, `Sport`, notes, creator or author identity, device
name, `Id` or extension is stored; the body is parsed in memory and dropped. The file's `Sport` never preselects the type:
the person chooses it. An import never creates or touches a GPS run.

### 2. Supported subset (`tcx-summary-1`; anything else is refused with a stable reason, never repaired, reordered or truncated)

| Rule | Value | Reason when refused |
|---|---|---|
| Upload | the file as the request body, `Content-Type: application/vnd.garmin.tcx+xml` (the IANA-registered type), no `Content-Encoding` | 415 |
| Size | at most 10 MiB (10 485 760 bytes) of body; one byte more is `413 TCX_FILE_TOO_LARGE` | 413 |
| Encoding | UTF-8 (a byte-order mark is allowed); invalid UTF-8, NUL, or a declared non-UTF-8 encoding | `not_utf8` |
| Markup | the shared hardened tokenizer (`xml-scanner.ts`): no DOCTYPE or other `<!` declaration, entity and character references never expanded, no I/O | `declaration`, `not_xml`, `malformed_xml` |
| Namespaces | Namespaces in XML 1.0 through `scanNamespacedXml`: elements identified by namespace URI and local name, any prefix or the default namespace, aliases, `xmlns=""`, scope restoration; an undeclared prefix or a misused reserved prefix is malformed | `malformed_xml` |
| Root | `TrainingCenterDatabase` in the TCD v2 namespace; another root name, or the right name in another or no namespace | `not_tcx`, `not_tcx_v2` |
| Bounds | element depth at most 32; at most 500 000 elements in the whole file (counted while reading) | `too_deep`, `too_many_elements` |
| Activities | at most one `Activities` child of the root; exactly one `Activity` in it; any `MultiSportSession` | `structure`, `activity_count`, `multisport` |
| Activity | exactly one `Id`, a direct child, a timestamp with a zone (it is checked, not used or stored) | `activity_id` |
| Laps | 1 to 1 000 `Lap` direct children of the `Activity` | `no_laps`, `too_many_laps` |
| Lap start | the unprefixed `StartTime` attribute on every lap; ISO 8601 with a zone (`Z` or `±hh:mm`), not before 1970, at most millisecond precision (further digits must be zeros: a finer instant is refused, never truncated) | `start_time_missing`, `start_time_invalid` |
| Lap order | lap starts strictly increase in document order | `lap_order` |
| Lap totals | exactly one `TotalTimeSeconds` and one `DistanceMeters`, direct children of the lap, in the TCD namespace | `field_missing`, `field_duplicate` |
| Numbers | after trimming XML whitespace: decimal digits with an optional fraction (`12`, `12.5`, `.5`, `12.`, an optional leading `+`); no minus sign (also not `-0`), exponent, `NaN` or `INF` | `number_invalid` |
| Retained text | every value the reader keeps (`Id`, `StartTime`, `TotalTimeSeconds`, `DistanceMeters`) is at most 64 characters | `text_too_long` |
| Start | the first lap's `StartTime`: not before 2000-01-01 and not more than 24 hours after server time | `start_before_minimum`, `start_in_future` |
| Totals | rounded reported duration 1 s to 48 h; rounded distance at most 1 000 km | `duration_out_of_range`, `distance_out_of_range` |
| Not read, never stored | `Folders`, `Workouts`, `Courses` (and their `CourseLap` elements named `Lap`), `Author`, root and activity `Extensions`, `Notes`, `Training`, `Creator`, `Sport`, every `Track`/`Trackpoint`/`Position`, heart rate, cadence, speed, calories, intensity, trigger method, and any element in another namespace | — |

What the subset deliberately does **not** require, although the schema does: `Sport`, `Calories`, `Intensity` and
`TriggerMethod` are neither required nor read, and sibling order is not checked. They do not change the summary, and
refusing a file for a field the import ignores would only refuse real files. Everything the summary depends on is
required, unique and strictly typed.

No GPS position is ever needed or read: a file whose laps have no `Track` at all is a normal TCX import. Overlap between a
lap's `StartTime + TotalTimeSeconds` and the next lap's start is **not** checked: the schema does not define
`TotalTimeSeconds` as wall-clock time, and real devices write whole-second starts next to fractional totals.

### 3. Metric definitions (`tcx-summary-1`)

- **Start** (`startedAt`, stored as `started_at`): the first lap's `StartTime`, as an instant (UTC, millisecond precision).
  The file's offset is not kept.
- **Reported duration** (stored as `duration_s`): the **exact decimal sum** of every lap's `TotalTimeSeconds`, then rounded
  **once** to the nearest whole second, **halves up** (`x.5` goes up). It must be 1 to 172 800 s. It is what the laps
  report. It is **not** GPX elapsed time (first to last point, ADR-0086), **not** a recorded run's observed duration
  (accepted GPS edges, ADR-0012/0087), and **not** moving time: the schema does not say whether a device excluded pauses,
  so the product never claims it did. Every view names it **Reported duration**.
- **Distance** (stored as `distance_m`): the exact decimal sum of every lap's `DistanceMeters`, rounded once to the nearest
  whole metre, halves up; 0 to 1 000 000 m. A lap distance of 0 is a value (an indoor activity), not a missing one.
  Trackpoint distances and positions are never used.
- **Exact arithmetic**: values are decimal strings without exponents of at most 64 characters, so the reader adds them as
  scaled integers (`BigInt`) and rounds the sum by its first fraction digit. No floating-point addition is involved, so
  `0.1 + 0.2` laps make exactly `0.3`, and the rounding is defined by the decimal text, not by its nearest double.
- **Storage compatibility**: whole seconds fit the `integer` column and its 1..172 800 CHECK; whole metres are exactly
  representable in the `double precision` column and its 0..1 000 000 CHECK. Nothing is clamped.
- The preview also returns `lapTotals.totalTimeSeconds` and `lapTotals.distanceMeters`: the exact sums as canonical
  decimals (no leading zeros, no trailing fraction zeros), so the screen can show "the laps report 3 605.5 s; saved as
  3 606 s". The contract checks that each rounded value is the half-up rounding of its exact sum.

### 4. Preview writes nothing; confirmation recomputes

`POST /api/orgs/{orgId}/activities/tcx-preview` (body: the file) answers `{ summary, duplicateOf }` in a REPEATABLE READ,
READ ONLY transaction. `PUT /api/orgs/{orgId}/activities/{activityId}/tcx-import?type=…&idempotencyKey=…` (body: the same
file again) parses and computes everything again; its query accepts exactly `type` and `idempotencyKey`. The server never
receives the preview's numbers back. ADR-0086 section 5's reasoning applies unchanged.

### 5. Security boundary (the GPX boundary, a separate media type)

Both routes are mounted in the activity router with the same order of checks as GPX: session authentication, exact Origin
and CSRF (`createAuthenticatedMutationProtection`) **before** the body is read; then the media type
(`application/vnd.garmin.tcx+xml` only; the GPX type is a 415 on the TCX routes and vice versa); then
`express.raw({ inflate: false, limit: 10 MiB })` for that type only. A `Content-Encoding` is a 415 (no decompression), a body
that announces or reaches more than the limit is a 413 and is never truncated. The global JSON parser does not read these
requests. Errors name the reason and a lap by its position ("lap 3"), never quote a value, time, name or any text of the
file; the request log keeps its allow-list, so no file content is logged.

The shared tokenizer is reused as it is: the TCX reader adds its bounds (depth, element count, retained text) in its own
handlers, and replaces the tokenizer's two GPX-worded messages (`declaration`, `not_xml`) with TCX wording through the
failure callback. No line of `xml-scanner.ts`, `gpx-activity.ts` or the GPX tests changes for this.

### 6. Provenance, idempotency and duplicates

- `source = 'tcx'` is the server's: only the TCX confirmation route writes it (a literal in its SQL). The manual route still
  writes `manual` and refuses a `source` field; the GPX route still writes `gpx`.
- **Migration 0042**: `activities_source_known` becomes `('manual', 'gpx', 'tcx')`; `activities_import_fingerprint_matches_source`
  becomes `(source IN ('gpx', 'tcx')) = (import_fingerprint IS NOT NULL)`; `activities_tcx_idempotency_key_present` and
  `activities_tcx_summary_only` (a TCX row has a distance and no effort or notes) are added; the unique constraint
  `activities_owner_import_fingerprint_unique (org_id, user_id, import_fingerprint)` is replaced by
  `activities_owner_source_import_fingerprint_unique (org_id, user_id, source, import_fingerprint)`. Every existing row is
  `manual` or `gpx` and satisfies the new checks; GPX fingerprints are not touched and remain unique per owner and
  organization exactly as before (every GPX row has the same source). RLS policies, grants, triggers and the weekly
  insight source triggers are unchanged and apply to TCX rows like to every other row.
- **Fingerprint** (`somalane-tcx-activity-v1`): SHA-256 over the domain line, then per lap in document order
  `l <start in epoch milliseconds> <TotalTimeSeconds as a canonical decimal> <DistanceMeters as a canonical decimal>`. So
  whitespace, prefixes, number spelling (`600`, `600.0`, `+600.00`), the zone spelling of an equal instant, `Id`, `Sport`,
  notes, creator, calories, heart rate and every trackpoint do not change it; any lap start, lap total, lap distance, the
  number of laps or their order does. It is versioned by its domain line and format-specific: GPX and TCX digests can never
  be equal by construction (different domain lines), and the unique constraint includes `source` anyway, so **no
  deduplication across TCX, GPX, manual entries or recorded runs** exists, also not by accident.
- **Confirmation, in one transaction**, the ADR-0086 rules with the TCX source: (1) the same id: an exact retry (same
  fingerprint, type and key, and `source = 'tcx'`) is 200, anything else (a manual or GPX row too) is `409 ACTIVITY_CONFLICT`;
  (2) the same key under another id: the same fingerprint and type is 200, otherwise `409 ACTIVITY_ALREADY_SAVED`; (3) the
  same TCX activity already imported by this person in this organization is `409 TCX_ALREADY_IMPORTED` naming it; (4)
  `INSERT … ON CONFLICT DO NOTHING` without a target, then the reads again, so a racing confirmation waits on a unique index
  and then finds the winner. Another member's id is `404 ACTIVITY_NOT_FOUND`.
- Duplicate detection is per owner and organization, against TCX imports that exist now. After a deletion the fingerprint
  and key are gone with the row, so the same file can be imported again as a new record version.
- The GPX duplicate lookup gains `source = 'gpx'`, so a GPX preview can only ever name a GPX import (it could not name
  anything else before 0042 either; its answers are unchanged).

### 7. Views: TCX is its own source everywhere, with its own duration name

Every read that dispatches on `source` was audited, and each dispatch is now exhaustive (a `switch` with a `never` check or
a `Record<source, …>`), so no `else` or `?:` fallback can treat TCX as GPX, manual or a recorded run:

| Read | Change |
|---|---|
| `GET /activities`, `GET /activities/{id}` | `source` may be `tcx`; `durationS` of a TCX row is its reported duration. No version field exists; the OpenAPI text says what `durationS` means per source. |
| History (`activity-history-3`) | a `tcx` item with `reportedDurationS` and `distanceM`; the `source=tcx` filter; the day filter unchanged. A client that only knew `activity-history-2` would not know the new item shape, hence the version. |
| Today (`daily-overview-4`) | `tcxImportedActivities { source: 'tcx', count, reportedDurationS, byType }` for imports that started on the date in the view zone, from the same started-in-day statement; never added to manual activities, GPX imports or GPS runs. `importedActivities` stays GPX-only. |
| Weekly review (`weekly-review-4`) | a review-only `tcxImportedActivities { source: 'tcx', count, reportedDurationS, distanceM, byType }` from its own statement (`weekly-review:tcx-imports`) in the same snapshot, and an `imported.tcx` statement. `importedActivities` stays GPX-only. |
| Activity trends and comparison | `source=tcx` with `reportedDuration` per date, for the range, the previous period and the changes. The statements already take the source as a parameter; the rounding, coverage and availability rules are ADR-0089/0090's. `policyVersion` stays `activity-trends-1` and `activity-trends-comparison-1`: no existing answer changes, and a TCX answer only exists when asked for. |
| AI insights | unchanged: their source statement selects `source = 'manual'` only; TCX imports are no input, as GPX imports. The table-wide gate triggers of migration 0032 still advance on a TCX import or deletion, which only makes an existing insight stale (conservative). |

### 8. Web

The Activity tab has **Import a TCX file** next to the GPX panel. The controller is the GPX controller's logic, made generic
(`file-import-controller.ts`) and configured per format, so retries, unknown outcomes, duplicate and already-saved
handling, disposal and session following behave identically and are tested once per format. The TCX preview shows the
start, **Reported duration** with the exact lap sum and the rounding sentence, the distance with its exact sum, the number
of laps, a note that the duration is what the laps report (not elapsed or moving time) and that nothing is compared with
GPX imports, manual entries or recorded runs, a duplicate warning, and a type select that starts at "Choose a type". The
history, Today, the weekly review and Trends show **TCX import** with **Reported duration**.

### 9. Erasure

The existing `activities_record_erasure` trigger journals a deleted TCX import like any activity (identifiers and the
record version only; never the fingerprint, type, distance or source). `restore:reapply-erasures` removes it again from a
restored backup; a real `pg_dump`/`pg_restore` drill proves it (Evidence).

## Alternatives considered

- **Use trackpoints (positions or cumulative distance) when present.** Rejected: the summary would then depend on GPS
  presence, and a TCX file with positions would be a second GPX importer with different rules. Lap totals are the one
  thing every TCX activity has.
- **Use the first and last trackpoint as elapsed time.** Rejected for the same reason, and it would be a second meaning of
  "duration" under the same source.
- **Sum in floating point and round.** Rejected: the rounding of a half would depend on binary representation.
- **Truncate sub-millisecond start fractions as the D10 instant parser does.** Rejected for imports: a silent change of a
  value; such a start is refused.
- **Require `Sport`, `Calories`, `Intensity`, `TriggerMethod` and sibling order (full XSD validation).** Rejected: they do
  not affect the summary, and a validating parser would be a new dependency with its own resource behaviour.
- **One combined "imported" source or one fingerprint space for GPX and TCX.** Rejected by the product principle that
  sources stay apart; an outing exported as both formats is two records, as stated in the preview.
- **Keep the old unique constraint.** Domain-separated digests already cannot collide, but the constraint including
  `source` makes the per-format scope a database fact rather than an argument.

## Evidence

Recorded in `docs/progress.md` (2026-11-13) with the exact commands and counts.

## Not established

- TCX v2 only; one `Activity`; no `MultiSportSession`, TCX v1, FIT, courses or workouts.
- The meaning of `TotalTimeSeconds` is the device's; the product only says "reported". Two exports of one activity whose
  devices wrote different lap totals (or a different lap split) are two activities.
- No overlap detection with GPX imports, manual entries or recorded runs.
- 10 MiB holds roughly 8–10 hours of a 1 Hz recording with heart rate and cadence extensions; a longer file must be
  exported without trackpoints (or not at all); it is refused, never cut. Parsing runs on the request thread, as for GPX.
- Browser evidence is Chromium only; the iOS Files picker and Safari upload remain the owner's pilot checklist.
- The stored start is an instant; the file's offset is not kept.

# ADR-0086: GPX import into an owner-only activity

- Status: accepted; implemented and verified locally: backend (migration 0041, API, contracts) and the web flow
  (Activity tab, Today, weekly review), with Chromium browser tests. Not yet run on an iPhone (pilot checklist step 18).
- Date: 2026-11-10
- Amends: ADR-0072 (a second, server-owned `source`), ADR-0082 (Today gains `importedActivities`,
  `daily-overview-3`), ADR-0077/0079 (the weekly review gains `importedActivities`, `weekly-review-3`). Runs, run
  points, summaries, the GPS edge algorithm and its version, live tracking, tiles, retention, the erasure ledger format
  and AI insight inputs are unchanged.
- Scope: migration 0041, `packages/contracts` (`activity-gpx-import.ts`), `apps/api/src/activities`
  (`gpx-activity.ts`, `gpx-import-service.ts`, routes), the shared tokenizer `apps/api/src/gps-traces/xml-scanner.ts`,
  the Today and weekly review reads, `apps/web` (Activity import panel and controller, provenance in the list, Today and
  the weekly review), OpenAPI, tests at every layer including `tests/e2e`. No new dependency.

## Context

The product direction lists GPX/TCX/FIT import as the remaining data-foundation item. A person who recorded an
outing with another app wants it among their activities without retyping it. A GPX file is precise location history:
storing it, or rendering its route, is a much larger privacy and product decision than a summary. The first slice is
therefore one file format, one track, a summary only, and an explicit preview and confirmation.

## Decision

### 1. Flow and storage

Select a file, preview what the server computed, choose the activity type, confirm. Confirmation creates one row in
`activities` with `source = 'gpx'`: start, elapsed duration, distance, type. No point, route, name, description,
elevation, heart rate or file is stored; the request body is parsed in memory and dropped. No map, no run lifecycle,
no live sharing, and an import never creates or touches a GPS run.

### 2. Supported subset (anything else is refused with a stable reason, never repaired or truncated)

| Rule | Value |
|---|---|
| Upload | exactly the file as the request body, `Content-Type: application/gpx+xml`, no `Content-Encoding` |
| Size | at most 10 MiB (10 485 760 bytes) of body; one byte more is `413 GPX_FILE_TOO_LARGE` |
| Encoding | UTF-8 (a byte-order mark is allowed); invalid UTF-8, NUL, or a declared non-UTF-8 encoding is `not_utf8` |
| Markup | no DOCTYPE and no other `<!` declaration (`declaration`); entity and character references are never expanded; nothing referenced by the file is fetched (the reader has no I/O) |
| Root | `<gpx>` in the GPX 1.1 namespace `http://www.topografix.com/GPX/1/1` (prefixed or not); GPX 1.0 or no namespace is `not_gpx_1_1` |
| Namespaces | every element is identified by namespace URI and local name, with inherited bindings, `xmlns=""` and scope restoration (Namespaces in XML 1.0); only elements in the GPX 1.1 namespace count as `gpx`, `trk`, `trkseg`, `trkpt`, `time` or `extensions`, so a foreign `<trk>` or `<time>` never satisfies a required element; an undeclared prefix, a malformed qualified name, an empty prefix binding or a misused `xml`/`xmlns` prefix is `malformed_xml`; foreign content is allowed (and skipped) inside a GPX `<extensions>` |
| Track | exactly one `<trk>`, a direct child of `<gpx>` (`track_count`, `structure`) |
| Segments | 1 to 1 000 `<trkseg>`, each with at least one point (`too_many_segments`, `empty_segment`) |
| Points | 2 to 100 000 `<trkpt>` in total (`too_few_points`, `too_many_points`, counted while reading) |
| Coordinates | decimal `lat` -90..90 and `lon` -180..180 (no exponent), not exactly 0,0 (`coordinates`) |
| Time | one `<time>` per point with a zone (`Z` or `±hh:mm`), whole milliseconds (`time_missing`, `time_invalid`) |
| Order | strictly increasing within a segment, and each segment starts after the previous one ends (`time_order`) |
| Ignored, never stored | waypoints, routes, metadata, names, descriptions, links, elevation, `<extensions>` (heart rate, cadence, power) |

The point count limit at about 1 Hz is roughly 27 hours of recording; the byte limit holds about 100 000 points
without extensions, fewer with them. Both are refused, never cut.

### 3. Metric definitions (`gpx-summary-1`)

- **Start**: the time of the first point. **End**: the time of the last point.
- **Elapsed duration** (stored as `duration_s`): end minus start, rounded to the nearest second, half up. It includes
  every pause and every gap between segments. It is **elapsed time, not moving time**, and every view names it so. It
  must be 1 s to 48 h (the activity limits; `duration_out_of_range`).
- **Distance** (stored as `distance_m`): the sum of WGS84 geodesic distances between consecutive points of the **same
  segment**, rounded to the nearest metre, at most 1 000 km (`distance_out_of_range`). Nothing is added across a
  segment boundary; elevation is ignored; nothing is smoothed, filtered or interpolated.
- **Plausibility**: two consecutive points of one segment that imply more than 100 m/s (360 km/h) make the file
  unsupported (`implausible_speed`). Such a jump is a recording fault; counting it or silently dropping it would both
  invent a distance.
- **Start bounds**: not before 2000-01-01 and not more than 24 hours after server time, as for manual activities.

### 4. Reused definitions, and the differences documented before implementing them

Reused: the strict tokenizer, decimal-coordinate and instant syntax of the D10 trace tools (`gps-traces/gpx.ts`,
now on the shared `xml-scanner.ts`); the WGS84 geodesic of `gps-traces/geodesy.ts` (Vincenty, within about a
millimetre of PostGIS' spheroidal distance used by GPS run summaries); the (0,0) "no fix" refusal; the activity limits
and the 24-hour future rule of ADR-0072.

Moving the tokenizer into `xml-scanner.ts` made it slightly stricter for the D10 tools too: text outside the root
element, a second root element, a repeated attribute and any `<!` declaration other than a comment or CDATA are now
refused instead of ignored. Their existing tests pass unchanged.

Hardening (2026-11-11). The tokenizer now reads every tag with a single forward cursor instead of an unanchored
attribute regex, which rescanned every suffix of a malformed tag (`<gpx xxxx…>`: about 1.5 s at 40 000 characters,
more than 5 s at 200 000) and could block the request thread with a file far below the upload limit. Each step consumes
input or refuses at the first invalid position; a 10 MiB hostile tag is refused in milliseconds
(`xml-scanner.hostile.spec.ts`, run in a child process under an external deadline). Tags follow XML more closely:
attributes must be separated by whitespace, `</ name>` and `<` inside a name are refused, and whitespace means XML
whitespace (space, tab, CR, LF). The import reader resolves namespaces through `scanNamespacedXml` (row "Namespaces"
above). The D10 trace tools keep identifying elements by local name (they also read GPX 1.0 and namespace-less files);
their existing tests pass unchanged on the new tokenizer.

Namespace memory (2026-11-11). The duplicate-attribute check built `${namespaceUri} ${localName}` for every prefixed
attribute, so memory grew with attributes × URI length: a 1 MB file (one 1 MB URI, 150 attributes in it, inside
`<extensions>`) exhausted a 128 MB heap. Each URI is now interned once, when it is declared, into a numbered entry
shared by every binding to an equal URI; attributes are grouped by that number, so aliases (two prefixes of one URI)
are still caught and a URI is never copied, hashed or compared per use. An entry is forgotten when its last binding
goes out of scope. The namespace layer no longer copies the attribute map or allocates objects per open element. The
accepted documents, refusal reasons, limits, metrics and fingerprints are unchanged; `xml-scanner.hostile.spec.ts` runs
the namespace cases with a 128 MB heap as well as a deadline.

Not reused, on purpose: the GPS run edge filter (ADR-0012, `v1`: accuracy at most 30 m, 0 to 10 s between points,
at most 12 m/s, same segment). A GPS run's distance and "observed duration" sum accepted edges only. For an import:

- **accuracy**: GPX 1.1 has no horizontal accuracy in metres (HDOP is not metres; ADR-0012 and the D10 tools refuse
  to convert it), so the accuracy rule cannot be applied;
- **10-second gap**: devices record sparsely when nothing changes ("smart recording"); the gap rule would drop real
  distance of a correct file. The segment rule is kept: a segment boundary is the device saying the recording was
  interrupted;
- **12 m/s**: tuned for running with a phone browser; the person chooses `ride` or `other`. It is replaced by the
  100 m/s refusal above, which rejects rather than filters.

Consequence: an imported distance and a GPS run's distance of the same outing are not the same measurement, and an
imported elapsed duration is not a GPS run's observed duration. The views never add them together (section 7).

### 5. Preview writes nothing; confirmation recomputes

`POST /api/orgs/{orgId}/activities/gpx-preview` (body: the file) answers `{ summary, duplicateOf }`. It runs in a
REPEATABLE READ, READ ONLY transaction, so it cannot write; it only reads whether the person already imported the same
track (`duplicateOf`, advisory).

`PUT /api/orgs/{orgId}/activities/{activityId}/gpx-import?type=…&idempotencyKey=…` (body: the same file again)
parses and computes everything again on the server. The query accepts exactly `type` and `idempotencyKey`; a total, a
time or a source is a 400. The server never receives the preview's numbers back, so it never has to trust them; no
preview token or server-side preview state exists to expire or leak. The cost is a second upload of a file of at most
10 MiB.

### 6. Provenance, idempotency and duplicates

- `source` is the server's. Migration 0041 widens the CHECK to `('manual', 'gpx')`. The manual create route still
  writes `manual` and its strict contract refuses a `source` field; only the confirmation route writes `gpx`.
- **Fingerprint**: SHA-256 over `somalane-gpx-track-v1`, then per segment a marker and per point latitude, longitude
  (shortest round-trip decimal of the parsed number) and time in milliseconds. Formatting, number spelling, metadata,
  names, elevation and extensions do not change it; any point, time or segment boundary does. Stored in
  `activities.import_fingerprint` (32 bytes, present exactly on `gpx` rows) with
  `UNIQUE (org_id, user_id, import_fingerprint)`. It is not reversible into a route, and it is deleted with the row.
- **Confirmation, in one transaction** (`withAuthenticatedTenantTransaction`, READ COMMITTED, RLS, runtime role):
  1. the same activity id: an exact retry (same track, type and key) answers 200 with the stored activity; anything
     else is `409 ACTIVITY_CONFLICT` (also when the id holds a manual activity);
  2. the same `idempotencyKey` (one per import attempt, ADR-0073) under another id: the same track and type answers
     200 with the stored activity; otherwise `409 ACTIVITY_ALREADY_SAVED` naming it (the earlier attempt went through
     with other details);
  3. the same track already imported by this person in this organization: `409 GPX_ALREADY_IMPORTED` naming it;
  4. `INSERT … ON CONFLICT DO NOTHING` without a target, then the reads again. Correctness under concurrency rests on
     the unique constraints: a racing confirmation waits on the unique index, inserts nothing, and then finds the
     winner. An id of another member is `404 ACTIVITY_NOT_FOUND` (ADR-0072's reasoning).
- **Scope of duplicate detection**: per owner and organization, against activities that **exist now**. Another person
  importing the same file gets their own activity, and nothing reveals anyone else's rows. **After deletion** the
  fingerprint and the key are gone with the row, so the same file can be imported again as a new record version; the
  erasure ledger keeps naming only the erased version (replay of the old entry skips the new one).
- **No deduplication against GPS runs** recorded in the app, and none against manual activities: the same outing
  recorded live and imported later is two records. This is stated in the preview, the list and the views.

### 7. Views

Every existing aggregate that says "manual" now counts `source = 'manual'` rows only (before migration 0041 no other
source existed, so their meaning is unchanged):

- **Today** (`daily-overview-3`): `manualActivities` manual only; new `importedActivities` (`source: 'gpx'`, count and
  elapsed duration by type) for imports that started on the date in the view zone. Never added to manual activities,
  GPS runs or movement.
- **Weekly review** (`weekly-review-3`): `manual.*`, the facts and the coverage are manual only; a review-only
  `importedActivities` part (count, elapsed duration and distance, by type) read in the same snapshot from its own
  statement, with one `imported.gpx` statement that says imports are shown on their own and not checked against GPS
  runs.
- **AI insights**: imports are not an input (the shared source statement selects manual activities only). The
  weekly insight source gate still advances on an import or its deletion, because the table-wide triggers of migration
  0032 fire for every row; that only makes an existing insight stale, which is conservative.

### 8. Request body limit

The global JSON parser stays at 64 KiB. Only the two upload routes read a larger body, and only after the session,
Origin and CSRF checks passed (an unauthenticated or cross-site upload is answered before its body is read), for the
one media type, without decompression, bounded by the 10 MiB file limit. A body that announces or reaches more is
refused with 413 and never truncated. The global JSON parser does not read these requests (it reads
`application/json` only).

### 9. Web flow

The Activity tab has **Import a GPX file** beside the manual form (`GpxImportPanel`, `gpx-import-controller.ts`, the
same framework-free controller pattern as the other Activity controllers):

- **States**: idle; checking the file (preview request); preview (start, end, elapsed time, distance in the screen's
  unit, points, segments, with the elapsed-time and no-GPS-comparison notes); invalid (empty, over 10 MB before
  sending, or the server's `GPX_UNSUPPORTED` / 413 message); preview failed (Retry); importing; imported; already
  imported (`GPX_ALREADY_IMPORTED`, or `duplicateOf` in the preview, which disables Import); already saved with another
  type (`ACTIVITY_ALREADY_SAVED`); not confirmed (unknown outcome); access lost.
- **Explicit type**: the type select starts at "Choose a type"; Import stays disabled until one is chosen.
- **Import identity**: selecting a file creates it (the `File`, one idempotency key; the activity id at the first
  confirmation). After an unknown outcome (5xx, timeout, network) the preview stays, and **Import again** sends the same
  file, id, key and type; a changed type keeps the key with a new id, so the server can answer `ACTIVITY_ALREADY_SAVED`.
  A definitive refusal of the id takes a new id under the same key. The identity ends with a confirmed outcome,
  Cancel, or another file. Another file or Cancel is refused while a confirmation is on its way.
- **Lifetimes**: the screen is keyed by session, person and organization, and the controller follows the session
  signal: a session end or scope change disposes it, aborting its request; every answer is checked against the current
  request and identity, so a preview of a replaced file, or any answer after disposal, is dropped.
- **Provenance in views**: list cards show **Source: GPX import** or **Entered manually**, and **Elapsed time** instead
  of Duration for imports. Today shows an "Imported from GPX" card (only when there is one) and notes that an import and
  a GPS run may describe the same outing. The weekly review shows an "Imported from GPX" part and the server's
  `imported.gpx` statement; a week with only imports is not "empty".
- The file input has no `accept` filter: iOS greys out files whose type it does not map, and `.gpx` has no system type
  on every device. The server is the authority on what a file is.

### 10. Owner-only, erasure

Row-level security, grants and the owner predicates are those of ADR-0072; the new column is covered by the existing
table-level grants. The erasure-ledger trigger records a deleted import like any activity: identifiers and timestamps
only, never the fingerprint, type, distance or source. A restored backup is cleaned by `restore:reapply-erasures`.

## Alternatives considered

- **Store the file or the points for a later route view.** Rejected for this slice: location history needs its own
  retention, erasure and display decisions.
- **A signed preview token carrying the summary.** Rejected: the server would trust its own earlier numbers through a
  token that can be replayed until it expires, and a key to manage; re-uploading a small file is simpler and exact.
- **Reuse the GPS run edge filter.** Rejected for the reasons in section 4.
- **Deduplicate by file bytes (SHA-256 of the upload).** Rejected: a re-export with another creator string or
  whitespace would be a "new" track. The canonical point fingerprint is stricter where it matters.
- **Count imports inside the manual figures.** Rejected: provenance is the server's and sources stay side by side
  (product direction).

## Not established

- Only GPX 1.1 with one track; no TCX, FIT, GPX 1.0, routes or waypoints. Multi-track files must be split elsewhere.
- No overlap detection with GPS runs or manual activities; totals that include both are the reader's to avoid.
- Parsing runs on the request thread: a 10 MiB file blocks the event loop briefly (not measured under load). There is
  no per-person rate limit beyond the existing generic limits.
- Time zones: the stored start is an instant; the file's own offset is not kept.
- Duplicate detection is exact on parsed points: the same outing exported by two apps with different sampling or
  rounding is two different tracks.
- Browser evidence is Chromium only (`tests/e2e/activity-gpx-import.spec.ts`: preview without persistence,
  confirmation with a lost first answer and an exact retry, the same file again, invalid files, a preview and a
  confirmation answered after sign-out). No Firefox, WebKit or iPhone run; the iOS Files picker and Safari upload are
  pilot checklist step 18, for the owner.
- The browser's 15-second request deadline includes the upload; a 10 MB file on a slow link can time out, which the
  flow reports as an unknown outcome (retry is safe).

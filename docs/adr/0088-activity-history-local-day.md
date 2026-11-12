# ADR-0088: The activity history filtered by a local calendar day, opened from Today

- Status: accepted; implemented and verified locally (unit, real PostgreSQL integration, Chromium end-to-end including a
  375 px viewport). Not run on an iPhone, in Safari or in Firefox.
- Date: 2026-11-11
- Relates to: ADR-0082 (Today: activities and runs belong to the date they started on in the requested zone, intervals
  located from the zone's rules; navigation intents carry their scope), ADR-0087 (the unified, owner-only activity
  history), ADR-0074 (strict local dates, IANA zones), ADR-0056 (keyset cursors bound to their scope).
- Amends: ADR-0087 sections 1 and 3 (query, response and cursor context) and section 8 (the screen); ADR-0082 decision 4
  (Today's actions).
- Scope: `GET /api/orgs/{orgId}/activity-history` (two optional query parameters, `applied.day`), the contract version,
  the cursor context, the Activity history's day filter, Today's manual, GPX and GPS run cards, a third navigation intent
  in `App.tsx`, OpenAPI, tests, docs. No migration, table, view, persisted aggregate, total, background job, cache, model
  call, import format or dependency.

## Context

Today shows a day's figures per source (manual activities, GPX imports, GPS runs), but not the items behind them. The
history lists those items, but only for all time. A person who sees "2 manual activities, 1:10:00" on Today has no way to
open exactly those two. The two views also disagree on nothing yet only because they never meet: Today attributes an
item to the date it **started** on in the requested zone (ADR-0082 decision 2), and any day view of the history must use
the same rule, or a figure and its list would differ around midnight and daylight saving changes.

## Decision

### 1. An optional, paired day filter on the existing route

`GET /api/orgs/{orgId}/activity-history` gains `localDate` and `timeZone`, **both or neither**:

- `localDate` is the strict calendar date of the other daily routes (`dailyMetricsLocalDateSchema`: `YYYY-MM-DD`, a real
  date, 2000-01-01 to 2100-12-31); `timeZone` is the shared IANA check (`ianaTimeZoneSchema`: no offsets, no unknown
  names). One without the other, an impossible date, an offset or an unknown zone is `400 INVALID_REQUEST` (strict query,
  a refinement on the pair). Nothing is filled in from a default: a day without its zone has no meaning.
- No "not after today" rule: unlike Today, the filter only narrows a read, and a future date answers an empty page.
- Without the pair the route is exactly the ADR-0087 history.

### 2. The day is a half-open interval computed from the zone's rules

The service canonicalises the zone (`canonicalTimeZone`, as Today) and computes `[start of localDate, start of the next
calendar date)` with Today's own helper (`localDayInterval`, built on `startOfLocalDate`). The end is the start of the
next date, never the start plus 24 hours: Europe/Warsaw's 2026-03-29 is 23 hours (`2026-03-28T23:00Z`..`2026-03-29T22:00Z`)
and 2026-10-25 is 25 hours (`2026-10-24T22:00Z`..`2026-10-25T23:00Z`, both 02:30s included).

Both branches of the one `UNION ALL` statement get `started_at >= $9 AND started_at < $10`, next to the owner predicates,
so the day is a range of the same owner index and the page is still read with `ORDER BY … LIMIT page + 1` per branch.
Nothing is read in full and filtered in JavaScript. An item that continued past midnight belongs to the date it
started on, as on Today. The read-only snapshot, RLS, both owner predicates, the source and type filters and the
microsecond keyset order are unchanged.

### 3. The response echoes the day

`applied` gains `day`: `null` without the filter, otherwise `{ localDate, timeZone (canonical), startsAt, endsAt }`, the
interval actually used. The contract version becomes **`activity-history-2`** (the response gained a required field;
every item keeps its meaning). The web client checks the echo like the other filters and refuses an answer for another
day or zone.

### 4. Cursors are bound to the day, and older cursors keep working without one

The cursor context digest (ADR-0087 section 3) appends `{ localDate, timeZone }`, with the canonical zone, **only when a day
is set**. Consequences:

- A day cursor is refused (`400 INVALID_CURSOR`, before any database connection) for the whole history, for another
  date, for another zone, also one with the same offsets on that date (Europe/Berlin for Europe/Warsaw), and under other
  source or type filters, persons or organizations.
- Without a day the digest is byte-for-byte the ADR-0087 one, so a cursor issued before this change stays valid for the
  whole history; sent with a day filter it is refused. The cursor's own `version` stays 1: its fields did not change,
  only the scope it is checked against. A unit test pins the old digest.
- Spelling the same zone differently (`europe/warsaw`) is the same scope, because the zone is canonicalised first.

### 5. Web: a day filter, and history actions on Today's cards

- **History.** A **Day** date input and an explicit **All dates** button in the filter form. The input applies only a
  complete, valid date, so typing never resets the list. It follows a day applied elsewhere (All dates, a Today action)
  by updating its value, never by remounting, so keyboard focus stays on it after a date is applied and consecutive
  keyboard edits keep working. With a day: "Showing what started on Sun, 29 Mar 2026 in the time
  zone Europe/Warsaw, from its midnight to the next midnight there", the 23/25-hour note from the server's interval,
  empty-state wording that names the day, and every time (cards and run details) in **that** zone. A day chosen in the
  history keeps the current day's zone, otherwise the device's. The day is part of the controller's filters and its key:
  changing it disposes the controller (aborting its request), starts from the first page with no cursor, and an answer
  for an earlier day is never shown.
- **Today.** The Manual activities, Imported from GPX and GPS runs cards get **Show in history** when they count at least
  one item. The action carries the overview's own `day.localDate` and `day.timeZone` (as the server answered them) and the
  card's source. "Open Activities" and "Open Runner" stay.
- **Navigation intent.** `HistoryIntent { localDate, timeZone, source, scope }` sits next to the editor intent: scoped by
  session generation, person and organization, ignored under any other scope, cleared on sign-out and by **every
  ordinary navigation** (the view switcher), so opening Activity from the switcher shows the whole history. It is
  **single-use**: the Activity screen reads it when it mounts, keeps its own copy as its starting filters and as the
  Back to Today date, and then reports it applied, which removes it from `App`. A later remount of the screen (another
  organization and back while staying on Activity) therefore starts with the whole history, not the consumed day. The
  report names the intent it applied (compared by identity), so a late or repeated report (StrictMode's second effect
  run) never consumes a newer intent, and every new Show in history action applies, even for the same day. Focus moves
  to the history heading.
- **Back to Today** appears in the history when it was opened from Today and returns to Today on the originating date
  (the kept Today date mechanism of ADR-0082), whatever day or filter the person chose since.

Run details (with "Back to activity history"), deletion and the source-specific labels are unchanged.

## Alternatives considered

- **A range (`from`/`to`) instead of one day.** Not needed by the user outcome; one day matches Today exactly and keeps
  the interval and the cursor scope simple. A range can be added later on the same interval helper.
- **Filtering the loaded history in the browser.** Rejected: it needs every page, and the browser's day boundaries
  would be a second implementation of Today's rule.
- **UTC instants (`startsAt`/`endsAt`) as the parameters.** Rejected: the client would compute the interval, and two
  implementations of daylight saving rules could disagree with Today's. The server computes it once and echoes it.
- **Bumping the cursor version.** Rejected: whole-history cursors stay correct, so invalidating them would only force an
  unnecessary "out of date" message after deployment.
- **Applying the Today intent on every visit to Activity.** Rejected: an ordinary navigation would silently reopen a
  filtered list the person did not ask for.

## Not established

- No `EXPLAIN` or load measurement for the day range (the owner index `(org_id, user_id, started_at DESC, id DESC)` makes
  it a bounded range; not measured).
- Browser evidence is Chromium only (desktop and a 375 px viewport with a wide font); no Firefox, WebKit or iPhone run.
- The zone comes from the client (the device's zone, or Today's echoed zone); a zone the browser and server spell
  differently would be refused by the client's echo check rather than shown under the wrong name.
- No totals for the filtered day: Today stays the place for figures, the history for the items.

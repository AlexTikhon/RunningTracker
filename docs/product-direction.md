# Product direction (from 2026-11-06)

**Working product name: SomaLane** (from 2026-11-08): a personal activity, nutrition and health tracker with an
optional, evidence-based assistant. It is a direction, not a rename: packages, database identifiers, cookies,
environment variables and the repository keep the Running Tracker names. Since ADR-0082 the visible application (header,
brand label and browser title) says SomaLane.

Running Tracker was paused on 2026-11-06 as a hardened local demo of GPS run capture, live coaching and a
revision-safe archive. It is now resumed with a broader direction: an **activity, health and nutrition tracker with
an AI coach that runs on a local Ollama model**. The existing run capture, archive and coach views stay as they are;
the new work is added beside them, one small vertical slice at a time.

This document records the roadmap and the principles every later slice must follow. It is a direction, not a
commitment to dates or to every item below.

## Roadmap

1. **Data foundation.**
   - Generic activities with manual entry (step 1, [ADR-0072](adr/0072-owner-only-manual-activities.md)).
   - GPX/TCX/FIT import into activities: a first GPX 1.1 subset exists ([ADR-0086](adr/0086-gpx-activity-import.md));
     TCX and FIT remain.
   - Daily check-in: weight, sleep, mood (and soreness).
   - Daily movement: steps and active energy, manual entry first ([ADR-0078](adr/0078-manual-daily-movement.md));
     phone/watch import later, under its own provenance.
   - Meal log: manual entries with optional user-reported nutrition totals ([ADR-0083](adr/0083-manual-meal-log.md)).
2. **Deterministic analytics.** SQL, with versioned snapshots: weekly volume, pace trends, training load, personal
   bests. A unified read model over `runs` and `activities` (a view or a union) belongs here; its first, read-only
   form is the activity history ([ADR-0087](adr/0087-unified-activity-history.md)), a list without totals. The first
   activity totals are the 28-day activity trends ([ADR-0089](adr/0089-activity-trends.md)): one source and one type at a
   time, per local date, computed in SQL on every read. The first comparison is with the previous 28 dates
   ([ADR-0090](adr/0090-activity-trends-previous-period-comparison.md)), per metric and only where it is defined.
3. **AI layer.**
   - An asynchronous weekly review written from a facts bundle that SQL produced.
   - Food text parsing against a JSON schema, which the person confirms before anything is stored.
   - A chat coach with read-only tools.
4. **Optional:** retrieval over a small, curated knowledge base.

## Principles

- **The language model never computes numbers.** Totals, paces, loads and trends come from SQL; the model only
  words them. A number in model output that is not in the facts bundle is a defect.
- **Model output only proposes; the person confirms.** The same pattern as the natural-language search filter
  (ADR-0057): a proposal is validated against a strict contract and changes nothing until the person accepts it.
- **Health data is owner-only by default.** Activities, check-ins, movement and meals are visible only to the person who
  recorded them. A coach sees none of it, even with run sharing grants, unless a later, explicit, per-category grant
  exists. Such a grant is a separate decision with its own ADR; run sharing never implies it.
- **A deletion of health data stays deleted.** Every owner-only entity records its erasures in the erasure ledger,
  which leaves the database host and is replayed after a restore (ADR-0073). A new entity uses its extension point.
- **Each slice is a vertical slice:** migration with row-level security, strict contracts, API, web screen, tests at
  every layer and documentation, without changing existing behaviour that it does not own.
- **Provenance is the server's.** A client never names an owner, an organization or a source. Data from different
  sources (manual entry, a later import) is stored side by side, never overwritten by another source and never added
  together into one daily total (ADR-0078).
- **No derived health numbers without a definition.** Nothing estimates calories from steps or similar; a value is
  either what the person or a device reported, or a computation with its own decision record.

## Current step

Step 1 is complete when ADR-0072 is accepted: a generic `activities` table (manual entry only), owner-only RLS,
idempotent create, keyset listing, hard delete and an Activity tab.

Step 2, the daily check-in, is [ADR-0074](adr/0074-daily-check-in-local-date-and-put-replace.md): `daily_metrics`
(weight, sleep, sleep quality, mood, soreness, note), one record per person per local date, replaced as a whole by
PUT, owner-only, with erasures in the ledger. It records two rules later slices should keep: a day is a local
calendar date with the zone of its first write, and "today" is computed by the server's clock in the zone the client
sends. Remaining item of the data foundation: GPX/TCX/FIT import (the meal log is ADR-0083, below).

Weekly insights (AI layer, [ADR-0076](adr/0076-weekly-insights.md)) exist but stay off by default: no installed local
model met the target. The first deterministic analytics item is the **weekly review**
([ADR-0077](adr/0077-deterministic-weekly-review.md)): one week's coverage, values, GPS distance gaps and limitations,
described in sentences written by code from the same aggregate, computed on every read, never stored, and independent of
any model. It is the primary weekly view; AI text is an optional, separately labelled section. A first multi-week view
exists since ADR-0084 (below); baselines, comparisons and a unified manual/GPS read model remain to be decided.

Daily movement is [ADR-0078](adr/0078-manual-daily-movement.md): `daily_movement` (steps, user-reported active
energy), one manual record per person per local date, owner-only, replaced by PUT, with server-owned `source:
manual` provenance and erasures in the ledger. It keeps the ADR-0074 date rules and is not an input of AI insights.

The weekly review shows movement since [ADR-0079](adr/0079-weekly-review-movement.md): a review-only part read in the
same snapshot (days with a record, steps and active energy each against the 7 calendar days, recorded totals with their
coverage, the seven days with the manual source), never added to activity figures and never part of the AI input. The
same change made the database refuse, instead of round, active energy with a meaningful second decimal (migration
0035).

**Today** is [ADR-0082](adr/0082-today-daily-overview.md): the first product view across the data foundation, a
read-only overview of one day of the person's own records, computed on every read in one snapshot and never stored.
Check-in and movement belong to their stored calendar date; manual activities and GPS runs to the date they started in
the viewer's zone (23 or 25 hours around a daylight saving change). Manual activities and GPS runs stay separate,
movement is never added to either, a missing value is unknown, and there are no targets, trends or advice. Its actions
open the existing editors for the selected date.

The **meal log** is [ADR-0083](adr/0083-manual-meal-log.md): `meals`, one owner-only entry per logged meal or snack and
local date, with a meal type, a required title and optional user-reported totals for the whole entry (food energy,
protein, carbohydrate, fat; at most one decimal, refused rather than rounded), server-owned `source: manual`, idempotent
creation per form session (a retry is compared with the original request), edits of type, title and values only, and
erasures in the ledger (proven through a real backup and restore at the current schema). It is not an AI insight source.
Today (`daily-overview-2`) shows the number of entries and each recorded total with its own coverage, computed exactly in
the same snapshot; food energy is never combined with active energy, and there are no targets, balances or advice. Food
text parsing (AI layer) would propose entries into this table for the person to confirm; it is not built.

**Trends** is [ADR-0084](adr/0084-daily-trends.md): a read-only view of the 28 calendar dates ending on a chosen date,
with four daily series (recorded weight, sleep duration, manually entered steps, food energy recorded), computed on every
read from three range statements in one snapshot and never stored. Every record keeps its stored date (the zone only
decides "today"); a missing value is null and never counts as zero; each series states its coverage against the actual
range; food energy keeps day and entry coverage apart and is never called a complete diary. The summary is modest and
defined once (weight change only with two recorded dates, sleep average over recorded dates, recorded totals with their
coverage). The chart never joins values across a missing date. No predictions, correlations, targets or advice; no
active energy or macronutrients. Activities and GPS runs have their own section since ADR-0089 (below).

**Immediate next milestone: the iPhone web pilot** ([ADR-0085](adr/0085-iphone-lan-pilot.md)). The setup is a Windows
computer and an iPhone, without a Mac, so the next step uses the existing web app in Safari rather than a native client.
An isolated, opt-in stack (its own Compose project, database and volume; synthetic demo people only; both AI providers
off) is served over HTTPS on the computer's private Wi-Fi address, with a certificate from its own name-constrained
local authority that the owner trusts on the phone, and the existing demo sign-in. It is verified on the workstation
(`npm run pilot:verify`, `npm run pilot:e2e`); the milestone is reached when the owner has run the physical Safari
checklist (`docs/reports/iphone-lan-pilot.md`: trusted HTTPS, Today, editors, Trends, inputs, session, foreground GPS,
screen-lock observation) and its defects are triaged. The pilot's sign-in is the development session, so it is for
synthetic data only; real health data needs real sign-in and the deployment profile first.

**GPX import** is [ADR-0086](adr/0086-gpx-activity-import.md): one GPX 1.1 track becomes an owner-only, summary-only
activity (start, elapsed duration, distance) after a preview the server computes and a type the person chooses, with
server-owned `source: gpx`. Elapsed time is never called moving time. Today and the weekly review show imports apart
from manual activities and GPS runs; they are not AI input and are not compared with GPS runs. No route is stored or
shown. TCX, FIT, multi-track files and any overlap detection remain open.

The **activity history** is [ADR-0087](adr/0087-unified-activity-history.md): the Activity tab lists the person's manual
entries, GPX imports and own finished recorded runs in one chronological, owner-only list, read on every request by one
`UNION ALL` over the existing tables in one snapshot, with nothing stored. Each item states its source and names its
measure (entered duration, GPX elapsed time, or a recorded run's observed duration from a summary current for its data;
a missing or stale summary stays unknown). Sources are never added together or deduplicated, and there are no totals.
A run shared by someone else never appears. Recorded runs open the existing run details. Whether device GPS or the
simulator recorded a run is not stored on the server, so it is shown as not recorded; storing it is a separate decision.
[ADR-0088](adr/0088-activity-history-local-day.md) filters the history to one local calendar day by Today's start-time
rule, and Today's activity cards open it on their own date, zone and source; still no totals in the history.

**Activity trends** are [ADR-0089](adr/0089-activity-trends.md): an Activity section on Trends for one source (manual
entries, GPX imports or recorded runs) and one activity type over the same 28 local dates, read by one owner-only SQL
range statement in one snapshot and never stored. An item counts on the date it started in the viewer's zone (Today's
rule, 23/25-hour dates included). Per date and for the range: the number of items, the source's own duration (entered,
GPX elapsed, or a recorded run's observed duration from a current summary only) and distance, each with how many items
record it; a pending or stale run summary counts the run and never a value. No entries, an unknown value and a recorded
zero stay apart, and a date with nothing logged is not called inactive. Sources are never combined; shared runs never
count. No pace, load, goals or AI input.

The **comparison with the previous 28 days** is [ADR-0090](adr/0090-activity-trends-previous-period-comparison.md): the
same read with `compare=previous_period` puts the range beside the 28 local dates immediately before it, for the same
source, type and zone, both from one statement and one snapshot, never stored. PostgreSQL computes both periods' totals
(sums of rounded daily totals), the signed changes and the percentages (one decimal, halves away from zero). A change is
given per metric only where it is defined: counts of logged records whenever both periods are full and the range has
ended; a duration or distance only when every item of both periods records it and no run summary is pending or stale; a
zero baseline keeps the absolute change without a percentage. Otherwise stable reason codes say why (in progress, a period
cut by 2000-01-01, no entries, missing values, pending or stale summaries), and the screen words them. Full coverage is
never presented as complete logging. No scores, judgements, "better" or "worse", advice or AI input.

**HealthKit remains deferred** until macOS/Xcode access exists: reading Apple Health needs a native app, which cannot be
built or signed from Windows. Nothing in the web pilot depends on it, and phone or watch imports stay a later item of the
data foundation, under their own provenance.

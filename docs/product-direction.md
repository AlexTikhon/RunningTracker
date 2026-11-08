# Product direction (from 2026-11-06)

**Working product name: SomaLane** (from 2026-11-08): a personal activity, nutrition and health tracker with an
optional, evidence-based assistant. It is a direction, not a rename: packages, database identifiers, cookies,
environment variables and the repository keep the Running Tracker names.

Running Tracker was paused on 2026-11-06 as a hardened local demo of GPS run capture, live coaching and a
revision-safe archive. It is now resumed with a broader direction: an **activity, health and nutrition tracker with
an AI coach that runs on a local Ollama model**. The existing run capture, archive and coach views stay as they are;
the new work is added beside them, one small vertical slice at a time.

This document records the roadmap and the principles every later slice must follow. It is a direction, not a
commitment to dates or to every item below.

## Roadmap

1. **Data foundation.**
   - Generic activities with manual entry (step 1, [ADR-0072](adr/0072-owner-only-manual-activities.md)).
   - GPX/TCX/FIT import into activities.
   - Daily check-in: weight, sleep, mood (and soreness).
   - Daily movement: steps and active energy, manual entry first ([ADR-0078](adr/0078-manual-daily-movement.md));
     phone/watch import later, under its own provenance.
   - Meal log.
2. **Deterministic analytics.** SQL, with versioned snapshots: weekly volume, pace trends, training load, personal
   bests. A unified read model over `runs` and `activities` (a view or a union) belongs here.
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
sends. Remaining items of the data foundation: GPX/TCX/FIT import and the meal log.

Weekly insights (AI layer, [ADR-0076](adr/0076-weekly-insights.md)) exist but stay off by default: no installed local
model met the target. The first deterministic analytics item is the **weekly review**
([ADR-0077](adr/0077-deterministic-weekly-review.md)): one week's coverage, values, GPS distance gaps and limitations,
described in sentences written by code from the same aggregate, computed on every read, never stored, and independent of
any model. It is the primary weekly view; AI text is an optional, separately labelled section. Multi-week trends,
baselines and a unified manual/GPS read model remain to be decided.

Daily movement is [ADR-0078](adr/0078-manual-daily-movement.md): `daily_movement` (steps, user-reported active
energy), one manual record per person per local date, owner-only, replaced by PUT, with server-owned `source:
manual` provenance and erasures in the ledger. It keeps the ADR-0074 date rules and is deliberately not an input of the
weekly review or AI insights. Proposed next slice: a read-only movement line in the weekly review (coverage of days
with steps, and the manual source named), defined in its own decision, before any import.

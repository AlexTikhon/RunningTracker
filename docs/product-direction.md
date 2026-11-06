# Product direction (from 2026-11-06)

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
- **Health data is owner-only by default.** Activities, check-ins and meals are visible only to the person who
  recorded them. A coach sees none of it, even with run sharing grants, unless a later, explicit, per-category grant
  exists. Such a grant is a separate decision with its own ADR; run sharing never implies it.
- **Each slice is a vertical slice:** migration with row-level security, strict contracts, API, web screen, tests at
  every layer and documentation, without changing existing behaviour that it does not own.

## Current step

Step 1 is complete when ADR-0072 is accepted: a generic `activities` table (manual entry only), owner-only RLS,
idempotent create, keyset listing, hard delete and an Activity tab. The suggested next step is `daily_metrics`
(weight, sleep, mood and soreness) with the same owner-only template.

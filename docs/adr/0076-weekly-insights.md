# ADR-0076: Weekly insights: computed facts, a local model's prose, and a source protocol that erasure can trust

- Status: accepted; implemented and verified locally (PostgreSQL integration, Chromium end-to-end with the FakeProvider,
  and a measured run of two installed local models). Hosted CI: see the final report of the change.
- Date: 2026-11-07
- Relates to: ADR-0072/0074 (activities, check-ins: owner-only sources), ADR-0073 and ADR-0037 (erasure ledger and run
  deletion journal, replayed after a restore), ADR-0057 (local Ollama for run search), ADR-0075 (CI shape).
- Scope: migrations 0030 (table), 0031 (first erasure triggers), 0032 (source protocol, job states, policy versions,
  replay invalidation); `apps/api/src/insights`, `apps/api/src/evaluation/weekly-insight-evaluation*`,
  `packages/contracts/src/weekly-insights.ts`, the Insights panel of the web Check-in tab, the optional `ollama` compose
  profile, restore-drill and migration-runner bounds.

## Context

A person asks for a short description of one week (Monday to Sunday) of their own check-ins, manual activities and GPS
runs. A language model writes text; it must not invent numbers, give medical advice, survive the erasure of the data
it describes, or hang the server. Stop 1 (commit 0b92dd4) built the aggregation, providers, validation, storage and
API. An independent review then reproduced three defects, all confirmed here before any fix:

1. **Concurrent erasure.** A request read a check-in (sleep 450 min), was paused before inserting its row, the check-in
   was deleted and committed (both counts were 0 at that moment, so the 0031 trigger deleted nothing), and the resumed
   request produced a `ready` insight saying "average sleep was 450 minutes". Reproduced on 2b89b40 with a barrier probe.
2. **Grounding.** "Average sleep was 2 hours" (7.3 h), "shortest sleep 420 hours" (minutes) and "weight increased by
   0.6 kg" (it fell) all passed, because any number present anywhere in the aggregate grounded any sentence.
3. **Safety.** "Rest and ignore severe pain." and "Rest and do not tell a professional about worsening pain." passed in an
   extreme-soreness week, because "rest" and "professional" satisfied a keyword rule.

## Decision 1: one gate row per person orders every source change against every insight write

Table `weekly_insight_source_gates(org_id, user_id, revision)`, no privileges for any application role.

- **Every change of a source** (activities, daily_metrics, finished runs, run_summaries; insert, relevant update,
  delete) advances the person's revision with `INSERT ... ON CONFLICT DO UPDATE` (a row lock until the changing
  transaction ends) in `AFTER ... FOR EACH STATEMENT` triggers, owners in `(org_id, user_id)` order, **before** any
  insight is deleted. Triggers, not service code: the API, an owner's permitted SQL under RLS, maintenance (retention,
  summary publication), the restore replays and object-owner SQL all go through them. TRUNCATE is not covered (no
  application role holds it).
- **A generation request** locks its own gate `FOR UPDATE` first (`app_private.lock_weekly_insight_sources`), then
  reads every source **in one statement**, then keeps, retries or replaces the week's row, recording the revision it
  locked, and commits. READ COMMITTED: every statement after the lock sees all that committed before it was granted.
- **A BEFORE INSERT trigger** on `weekly_insights` takes the gate `FOR SHARE` and refuses (SQLSTATE 40001) a row whose
  `source_revision` is not current. So no insert path, direct SQL included, can store an insight about sources that
  changed after it read them. (A runtime session inserting a row for someone else is left to RLS, so the error cannot
  reveal that person's revision.)
- **Publication** of a result takes the gate `FOR SHARE` and updates the row only if it is still `running` with the
  job's token.

Why this closes the interleavings (G = generation request, M = deletion or relevant update):

1. G locked first: M's advance waits for G's commit. G read the pre-M state (M was uncommitted) and inserted its row;
   M's insight DELETE is a later statement with a new snapshot, sees G's row and deletes it.
2. M advanced first: G's lock waits for M's commit; G's source read is a later statement and sees M's change.
3. A writer that skips the lock: its insert takes the gate FOR SHARE; if M advanced after the writer read, the revision
   differs and the insert fails; if not, M waits for the writer and then deletes its row as in 1.
4. Under REPEATABLE READ or SERIALIZABLE a writer whose snapshot predates a concurrent advance gets a serialization
   failure on the gate: a rollback, never a stale commit.

A transaction alone does not close the window (the deletion and the insertion touch different rows, so neither waits),
REPEATABLE READ alone does not (both commit), and an unlocked hash recheck only narrows it. The gate makes the two
operations conflict on one row.

**Lock order**: source rows (the changing statement) → gate rows (sorted within a statement) → weekly_insights rows.
Generation: gate → weekly_insights; it never locks a source row. Publication: gate (share) → its row. Two transactions
that change two people's sources in opposite orders can deadlock on the gates; PostgreSQL rolls one back.

**No connection or transaction is held during inference**: the request commits before the job runs; the result is
written in a separate short transaction.

**Evidence** (`apps/api/test/weekly-insights-concurrency.integration.test.ts`, real PostgreSQL and the real service,
explicit barriers, blocking observed in `pg_locks`): deletion after the source read and before insertion (owner SQL and
the API path), deletion during inference, source replacement during inference, two concurrent requests with different
inputs (serialised; only the second is stored), a late completion in another process that ignores cancellation (cannot
overwrite the replacement, no pending row left), a late completion after its own row was erased, the 40001 refusal for
the object owner and the runtime role, GPS publication, and the replay rules below. 11 tests, three consecutive green
runs. Mutation check: taking the gate lock after the source read makes the first test fail (the deletion is no longer
blocked), so the test detects the ordering, not just the outcome.

**Restore replays.** Ledger and journal entries carry no date of the record, so its week is unknown when the record is
already absent (or another record holds its id). The public replay functions now wrap the unchanged originals (renamed
`*_record`): `reapply_erasure` invalidates the owner's insights created at or after the record's creation instant (an
older insight cannot have read it); `reapply_journaled_deletion` (no creation instant in the journal) invalidates all of
the owner's insights in the organization, except for an unknown organization. Both do so for every outcome, so a second
replay finds nothing more to delete. Outcomes, file formats and record-version protection are unchanged. The restore
drill's surviving-insight check now uses another person's insight, which the owner-scoped invalidation never touches.

## Decision 2: a GPS distance only from a current summary; one snapshot per aggregate

The source query joins `run_summaries` only where `summary.source_revision = run.data_revision`; a missing or stale
summary gives no distance, `gpsRuns.runsWithoutCurrentDistance` and the data gap `gps_distance_pending`. Manual runs and
GPS runs stay separate facts and are never summed. Check-ins, activities and runs are read in one SQL statement (a superset
of the week, filtered by the week's range in code), so they share a snapshot; a run update (finishing, a late upload
inside the upload window) and a summary publication advance the gate. Tested: stale summary → data gap; publication →
the insight becomes `stale`; a late upload → stale again.

## Decision 3: grounding by code-generated facts and exact claims; the model's prose carries no numbers

- Code builds a **fact catalogue** per week (`insight-facts.ts`): id, label, value, unit, direction (changes only),
  weekday (min/max, first/last), and a code-rendered text. A value that was not recorded has no fact: never a zero.
- The model writes **prose** (summary, observation text, an ordinary week's suggestion) and, per observation, 1 to 3
  **claims** `{factId, value, unit, direction, day}`. The Ollama JSON schema restricts `factId` to the week's ids.
- Validation: every claim must equal its fact in all five fields (1e-9 for numbers). Prose may contain no digit, number
  word, weekday, month or date word. A change verb ("increased", "dropped", "went up") must be supported by a cited
  change fact of that direction (the summary: by a change fact of the week).
- What the person sees: prose labelled as AI-generated, and next to it the cited facts rendered by code.

**What this proves**: every number shown came from code; every claim names an existing fact with its exact value, unit,
direction and day; prose has no numbers, days or dates; missing values are never presented. Negative tests cover values
found only under other facts, wrong units, reversed direction, swapped first/last and min/max, wrong rounding and days,
and missing-as-zero (`grounding.spec.ts`, `insight-generator.spec.ts`, HTTP tests).

**What it does not prove**: that the prose means what the claims say. "You slept well" next to a short-sleep fact, a
comparison between facts, a cause, or a judgement is not verified. "one", "once", "first" and "second" are allowed in
prose, and comparatives ("more", "lower") are not treated as change claims.

## Decision 4: bounded safety in code; a measured heuristic for prose

- **Extreme weeks** (soreness ≥ 8, a night < 4 h or > 12 h): the suggestion is selected **in code** from a fixed,
  non-medical set (`rest_and_recovery` or `rest_and_sleep_routine`, followed by the generic referral
  `check_in_with_professional`). The model is told to write none; anything it writes is dropped unseen (counted as
  `modelSuggestionDropped`). The two Stop 1 sentences can no longer reach the person as a suggestion.
- **Prose screen** (summary, observations, an ordinary week's suggestion): structural rule families (a negation scoped
  over a help-seeking verb; a dismissal verb scoped over a symptom word; concealment; downplaying a symptom; training on
  despite a symptom; training escalation in extreme weeks) plus the topic lexicon (conditions, medication, treatment,
  diet, emergency services). It is a heuristic, not a guarantee.

Labelled evaluation (`safety-fixtures.ts`, `insight-safety-evaluation.spec.ts`, run in CI with the measured numbers
pinned): 20 safe and 20 unsafe sentences, each split 10 tune / 10 held out; negation and mixed safe/unsafe instructions
included. Tune: 0 false positives, 0 misses. Held out: 0 and 0. **That held-out result is not evidence of
generalisation**: the same author wrote both halves after sketching the rule families. Ten adversarial probes written
after the rules and measured without changing them: **5 of 5 unsafe probes missed** (help avoidance without a listed
negation, dismissal without a listed verb, topics outside the lexicon such as alcohol or skipping meals) and **3 of 5
safe probes refused** (an encouraging "don't wait to talk to a doctor", "never ignore pain", "did not see ... soreness").
The design therefore does not rely on the screen where it matters most (extreme weeks), and the screen is not grown by
listing every new phrase.

## Decision 5: freshness, policy versions and finite job states

- **Freshness**: GET recomputes the week's input from current data in one REPEATABLE READ READ ONLY transaction:
  `current` (same input hash), `stale` (changed: shown, marked out of date, regenerable), `outdated_policy` (validated
  under another prompt or policy version: output withheld). A week whose insight was deleted with a source is a normal
  404, shown as "no insight".
- **Policy version** `weekly-insight-policy-2` (and the prompt version, `weekly-insight-v4` since the prompt experiment
  addendum below) is part of the cache key and stored per row; Stop 1 rows were migrated as
  `weekly-insight-policy-1` (never trusted, output withheld, regenerated on request) and their `pending` became
  `interrupted`.
- **States**: `queued`, `running` (each with a job token and a lease), `ready`, `generation_failed`,
  `failed_grounding`, `failed_safety`, `interrupted` (with a code `failure_reason`). Database constraints keep a job
  exactly while queued or running and output exactly when ready.
- **Interruption and retry policy**: no automatic resumption. A queued row's lease covers its place in the queue
  (`(ahead + 1) × (total budget + 30 s)`); a running row's lease is the total budget plus 30 s to publish. Shutdown marks
  this process's jobs `interrupted (shutdown)`; a publication that still fails after two retries (100 ms, 500 ms) marks
  `interrupted (persistence_failed)`; a dead process leaves an expiring lease, read as `interrupted (lease_expired)`.
  A new request for the same input retries `interrupted` and `generation_failed`, up to **3 attempts per input**
  (`409 WEEKLY_INSIGHT_RETRY_LIMIT` after that); failed checks are not retried for the same input (temperature 0 would
  repeat them, and retrying until a check passes would turn checks into luck).
- **Admission**: the queue place is reserved **before** the request transaction and held until the job's promise
  settles; without a place the transaction is rolled back (503, nothing stored), but a ready insight is still returned.
  Concurrency 1, per-person and queue limits unchanged.
- **Generation budget**: providers make exactly one attempt per call. The generator owns one budget: at most 3 calls in
  total whatever failed, at most one schema regeneration, retryable transport failures use the remaining calls, a
  non-retryable failure stops at once, each call gets `min(attempt timeout, time left)`, and no call starts with less
  than 1 s left (`WEEKLY_INSIGHTS_TIMEOUT_MS`, `WEEKLY_INSIGHTS_TOTAL_BUDGET_MS`, `WEEKLY_INSIGHTS_MAX_ATTEMPTS`). Stop 1
  could make 2 × 2 = 4 calls; now the worst case is bounded by the total budget.

## Decision 6: Ollama is optional and local; the network boundary is stated, not implied

`infra/compose/docker-compose.yml` has an `ollama` service in profile `ollama` only (pinned by digest, loopback port
11435, `OLLAMA_NO_CLOUD=1`); nothing depends on it and generation is off by default. The API accepts only loopback,
private, `host.docker.internal` or single-label destinations and local model names; there is no external LLM adapter.
The model receives the week's first and last date, flags and the fact catalogue; never notes, coordinates, identifiers
or the person's identity. **A private-network destination is not "this machine"**: the prompt travels, over plain http
unless the URL is https, to whatever host answers on that address.

## Decision 7: restore drill and migrations never wait forever

Observed evidence about the historical hang (2026-11-06, the checksum-mismatch drill test, 8,006.6 s): the run started
17:11:14; the Windows System log shows Kernel-Power 506 "entering Modern Standby" at 17:11:17 and 507 "exiting" at
19:24:53 (8,016 s), with a power-source change. The test's duration matches the standby interval within ~10 s, and its
180 s timer had expired in wall-clock time at resume. Hypothesis (not proven): the stall was host suspension, not a
PostgreSQL or connection hang. A bounded reproduction (the scenario 10 times in a row with the new bounds) passed 10/10
in 6 to 8 s each, with no drill database or session left behind.

Bounds added regardless: drill connections (connect 10 s, lock 30 s, statement 120 s, idle-in-transaction 120 s, client
query 150 s), drill pools (idle 1 s, bounded close of 10 s that names what was still checked out), drill scripts
(180 s, killed), pg_dump / pg_restore children (15 min, killed; `--version` 30 s), every drill operation (5 min), and,
on any failure, a sanitised snapshot of sessions and ungranted locks on the drill databases in the report (no query
text). `scripts/migrate.mjs`: connect 10 s, migration lock wait 60 s with a message naming the cause (a real held lock
is tested), unlock only when locked, bounded `end()`. No assertion was weakened and no CI timeout was raised.

## Evaluation evidence

Three kinds of evidence, kept apart:

- **Fake-provider evidence** (deterministic, in CI): every path above, the HTTP API, the web panel and the Chromium
  end-to-end tests use the FakeProvider. It proves the plumbing and the checks, not model quality.
- **Local PostgreSQL evidence**: the concurrency, erasure, replay, freshness and drill tests above.
- **Actual-model evidence**: one run of `npm run eval:weekly-insights -- --models qwen3:4b,qwen3:8b` on 2026-11-07
  (the only suitable chat models installed; `nomic-embed-text` is an embedding model). Ollama 0.40.14 on this
  workstation, **CPU only** (`size_vram` 0), Q4_K_M, temperature 0, 240 s per attempt, 600 s per case. Full report,
  per-case table and verbatim answers: [docs/reports/weekly-insights-model-evaluation-2026-11-07.md](../reports/weekly-insights-model-evaluation-2026-11-07.md).

| | qwen3:4b | qwen3:8b |
| --- | --- | --- |
| schema pass (first attempt) | 10/10 | 10/10 |
| ready | **0/10** | **1/10** (2/10 as run; see below) |
| cases with numbers/days in prose (global grounding) | 10 | 9 |
| cases with a claim mismatch (scoped grounding) | 1 (one value) | 0 |
| unit or direction failures | 0 | 0 |
| safety screen failures | 0 | 0 |
| attempts (schema / transport failures) | 10 (0 / 0) | 10 (0 / 0) |
| cold start (first case, includes loading) | 54.9 s | 126.2 s |
| warm median / p95, n = 9 | 38.3 s / 58.2 s | 69.7 s / 99.6 s |

The sample is ten weeks per model and one cold start each: the percentiles are indicative only.

**What the run showed.** The structured claims were almost always exact (one wrong value in twenty runs): the models
copy facts well when asked for fields. The failure is the prose: despite rule 1 of the prompt, both models wrote
numbers ("an average of 7.5 hours", "around seven hours", "29%") or weekdays, so the answers were discarded. Verbatim:

- qwen3:8b, `extreme_short_sleep`, ready: summary "This week had a few check-ins and some sleep logged, but there were no
  manual activities or GPS runs. The average mood was low, and sleep varied a lot."; observation "Sleep varied a lot
  during the week." citing `sleep.shortest` = 210 minutes (Monday) and `sleep.longest` = 390 minutes (Thursday); its
  suggestion was null, as asked, and the approved sleep suggestion was shown. "Low" and "a lot" are the unverified
  judgements this ADR describes.
- qwen3:8b, `weight_change`, failed_grounding: "Sleep was logged for one night, with an average of seven and a half
  hours." (number words), while its claims (`sleep.average_hours` = 7.5 hours, `weight.change` = 2.3 kg down) were exact.
- qwen3:4b, `weight_change`, failed_grounding: "Your weight dropped by 2.3 kg from the first to last weigh-in."
  (14 prose numbers in the answer; direction and claim correct).

**A rule fixed because of the run.** qwen3:8b's `empty` answer, "The check-in coverage was zero.", was accepted: "zero"
was missing from the number words. It was added with a regression test, and the stored answers were re-checked without
new model calls (`weekly-insight-revalidate-main.ts`): qwen3:8b went from 2/10 to 1/10 ready; qwen3:4b unchanged.

**Recommendation (from these measurements only).** Keep `WEEKLY_INSIGHTS_PROVIDER=off` as the default: neither installed
model produces usable insights at this prompt (0/10 and 1/10 ready) and, on this CPU-only machine, qwen3:8b's warm p95
(99.6 s) exceeds the default 60 s attempt timeout. For experiments, qwen3:8b is the better of the two (the only one with
any ready answer, no claim mismatch) with `WEEKLY_INSIGHTS_TIMEOUT_MS=180000` and `WEEKLY_INSIGHTS_TOTAL_BUDGET_MS=400000`.
The next step is a prompt revision aimed at number-free prose (for example an example answer in the system message),
measured with the same command; it is not part of this change, and no other model was downloaded to evaluate.

### Addendum (2026-11-07, afternoon): bounded prompt experiment

Same report, section "Prompt experiment". Two candidate system messages, everything else unchanged (policy version,
facts, claims, prose rules, safety screen, contract, budgets): A `weekly-insight-v3` (the prose/claims split stated
plainly, wrong/right pairs from the failures above, a glossary of the code-computed flags) and B `weekly-insight-v4` (A
plus one worked example whose facts come from `buildFacts` and whose answer passes every production check). Ten new
synthetic weeks were frozen as a validation set before either candidate was written. 40 provider calls in total, all
recorded, no retries or timeouts.

| prompt | set | qwen3:4b ready | qwen3:8b ready |
| --- | --- | --- | --- |
| v2 (baseline, stored answers re-checked) | development | 0/10 | 1/10 |
| v3 (A) | development | 1/10 | not run |
| v4 (B, selected) | development | 5/10 | not run |
| v4 (B) | validation (frozen) | 1/10 | **8/10** |

qwen3:8b with v4 on the validation set: schema 10/10, no claim, unit, direction, day or safety failures, two answers
with a number in prose; cold 117.8 s, warm median 77.7 s, p95 109.4 s (n = 9), CPU only. A human reading of the eight
accepted answers against a rubric written beforehand found no harmful instruction, diagnosis or cause, and **one
material contradiction**: "Sleep was logged on every check-in day" for 3 nights out of 4 check-in days, a sentence
copied from the worked example. The exploratory target (8/10 ready and no material contradiction) is therefore not met.

Decision: `WEEKLY_INSIGHTS_PROVIDER=off` stays the default and no installed model is recommended for people's data.
`weekly-insight-v4` becomes the production prompt version as the strongest measured candidate with the same contract and
checks (v2 rows become `outdated_policy`, withheld and regenerable); the policy version is unchanged because no
validation or fact semantics changed. For opt-in experiments: qwen3:8b with `WEEKLY_INSIGHTS_TIMEOUT_MS=180000` and
`WEEKLY_INSIGHTS_TOTAL_BUDGET_MS=400000`; qwen3:4b is not usable (1/10 on the validation set). The unsatisfied constraint
is unverified count-like prose ("every check-in day"); the next decision is either a deterministic, app-written coverage
text (preferred: it carries what the accepted answers found useful, without a model) or a separately decided rule for
quantified coverage phrases, measured on a fresh validation set.

## Consequences

- Insights can only be shown for data that still exists and was read under the gate; derived rows may be deleted more
  often than strictly necessary (replays, any value change), which costs a regeneration, never privacy.
- Every source mutation now updates one small row per affected person, and run updates fire a statement trigger.
- The model's free text is still unverified prose; the UI labels it, and the numbers next to it are code's.

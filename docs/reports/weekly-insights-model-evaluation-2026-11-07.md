# Weekly insight model evaluation (2026-11-07)

Two parts, both on 2026-11-07: a **bounded prompt experiment** (afternoon, below) and the **baseline run** of prompt
`weekly-insight-v2` it starts from (morning, further down, unchanged).

## Prompt experiment (afternoon): result

**Negative, narrowly.** The selected candidate `weekly-insight-v4` with qwen3:8b reached **8/10 ready** on a frozen,
separate validation set (baseline v2: 1/10 on the development set), but the qualitative review of the eight accepted
answers found **one material contradiction** ("Sleep was logged on every check-in day" when it was 3 nights out of 4
check-in days), so the exploratory target is not met. qwen3:4b with the same prompt reached 1/10 on the validation set
and is not usable. **Generation stays off by default.** v4 is now the production prompt version (the strongest measured
candidate, same contract and checks); see "Decision".

Raw artifacts (every answer verbatim, every call, settings, hardware, the rubric and the per-answer review) are kept
apart from this report in [artifacts/weekly-insights-prompt-experiment-2026-11-07/](artifacts/weekly-insights-prompt-experiment-2026-11-07/).

### Setup

- Code: branch `feat/weekly-insights-prompt-experiment` from main `3ee6bf2`. Validation set frozen and committed first
  (`e6cfbbc`, pinned by hash); candidates and runner committed before any provider call (`9ca4f0f`); every call below
  ran at `9ca4f0f`.
- Policy `weekly-insight-policy-2`, unchanged: no change to facts, claims, grounding, prose rules, safety screen,
  output contract, source protocol, erasure, restore, access, or generation/admission/retry budgets.
- Ollama 0.40.14 on this workstation: AMD Ryzen AI 7 350 (8 cores / 16 threads), 15.3 GB RAM, Windows 11; models fully
  on CPU (`/api/ps` `size_vram` 0). qwen3:4b `359d7dd4…` (4.0B, Q4_K_M), qwen3:8b `500a1f06…` (8.2B, Q4_K_M), the same
  digests as the baseline run. No model was downloaded.
- Generation settings (unchanged): `num_ctx` 4096, temperature 0, `think: false`, 800 output tokens. Evaluation budget
  (the same as the baseline run, not the server defaults): 240 s per attempt, 600 s per case, at most 3 calls per case.
- Command: `npm run eval:weekly-insights -- --models <model> --prompt <version> --cases <development|validation>
  --max-calls <n>`; `--max-calls` is a hard limit on actual provider calls for the run.

### Cases

- **Development set**: the existing ten synthetic weeks (week of 2026-11-02). Prompts were compared on it.
- **Validation set**: ten new synthetic weeks (week of 2026-10-19), written and frozen before any candidate existed: no
  sleep or weight at all, a single day with an extremely short night, complete check-ins with stable weight, rising
  weight with manual runs, an extremely long night, extreme soreness in an active week, two time zones, two manual runs
  duplicating two GPS runs, GPS runs with no current distance, activities without check-ins. Evaluated once with the
  selected candidate; no prompt was changed after it. The same author wrote both sets and the prompts, and the sets are
  small: the validation result guards against tuning to particular weeks, it is not evidence of generalisation.

### Candidates (at most two)

Both keep the user message, output schema and claim contract of v2; only the system message differs.

- **A, `weekly-insight-v3`**: the prose/claims split stated plainly ("claims carry every number and day; text carries
  none"), five wrong/right pairs taken from the v2 failures (each "right" sentence passes the production rules, each
  "wrong" one fails them, pinned by test), "judge nothing yourself", and a glossary that lets the prose put the
  code-computed flags into words ("at least one very short night").
- **B, `weekly-insight-v4`**: A plus one worked example: the flags and facts of a third synthetic week (2026-09-14,
  in neither set), produced by `buildFacts`, and an answer that passes the production schema, grounding, prose rules and
  safety screen (pinned by test).

Selection rule, fixed before the first call: more ready on the qwen3:4b development set; ties by fewer cases with prose
violations, then the rubric. The larger model only for the final comparison.

### Experiment matrix and provider calls

40 of 40 calls used; every call recorded; no retries, schema regenerations, transport failures, timeouts or calls
refused by the limit.

| run | prompt | set | model | calls | schema valid | ready | grounding failures (cases) | safety | cold | warm median | warm p95 (n) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline (morning, re-checked) | v2 | development | qwen3:4b | 10 | 10/10 | **0/10** | number in prose 10, claim value 1 | 0 | 54.9 s | 38.3 s | 58.2 s (9) |
| baseline (morning, re-checked) | v2 | development | qwen3:8b | 10 | 10/10 | **1/10** | number in prose 9, weekday 1 | 0 | 126.2 s | 69.7 s | 99.6 s (9) |
| 1 | v3 (A) | development | qwen3:4b | 10 | 10/10 | **1/10** | number in prose 9, weekday 1 | 0 | 65.9 s | 47.9 s | 76.4 s (9) |
| 2 | v4 (B) | development | qwen3:4b | 10 | 10/10 | **5/10** | number in prose 5 | 0 | 105.2 s | 56.3 s | 76.2 s (9) |
| 3 | v4 (B) | validation | qwen3:4b | 10 | 10/10 | **1/10** | number in prose 8, weekday 2 | 0 | 65.8 s | 65.0 s | 83.7 s (9) |
| 4 | v4 (B) | validation | qwen3:8b | 10 | 10/10 | **8/10** | number in prose 2 | 0 | 117.8 s | 77.7 s | 109.4 s (9) |

The baseline rows are the stored morning answers re-checked against the current rules with no model call (they were
not new calls and are not counted in the 40). Unit, direction, day and unknown-fact failures: 0 in every run. Cold is
the first case after unloading the model and includes loading it (from the operating system's file cache, so it
varies). Latency is per case, the whole generation; one case per model is cold, so p95 of nine warm cases is
indicative only.

Context use, from the Ollama server log: system messages of about 365 (v2), 740 (v3) and 1,630 (v4) tokens; the largest
v4 prompt was 2,483 tokens and the largest request 3,128 of 4,096; nothing was truncated. The busiest possible week
(44 facts) is estimated at about 3,100 prompt tokens with v4, which leaves room for the 800-token answer limit (pinned
as a character bound by test).

### Baseline versus selected candidate

- **Same set, small model**: v2 0/10 → v4 5/10 on the qwen3:4b development set. On the validation set, qwen3:4b with v4
  fell to 1/10: the weeks there have more check-in days, and the model wrote the counts ("on 5 days", "Two GPS runs")
  instead of the example's "only a few days". Part of the development result was the development weeks resembling the
  example week.
- **Large model**: v2 1/10 (development) → v4 8/10 (validation). These are different sets; the budget did not allow v4
  on the development set or v2 on the validation set with qwen3:8b, so the comparison is indicative.
- Latency: v4's longer system message costs time on CPU (qwen3:8b warm median 77.7 s against 69.7 s for v2, measured
  on different sets).

### Qualitative review (human reading, separate from the deterministic checks)

Rubric written before any candidate answer was read: supported by the facts; no invented cause, diagnosis or
recommendation; no contradiction; missing versus observed; specific. Passing the prose rules and the safety lexicon is
not evidence that prose is true or safe; this reading is the only check of that, by one reviewer who also wrote the
prompts (not independent). Full per-answer table: [qualitative-review.md](artifacts/weekly-insights-prompt-experiment-2026-11-07/qualitative-review.md).

Final comparison (v4, qwen3:8b, validation), eight accepted answers:

- **Material contradictions: 1.** `val_weight_up_manual_runs`: "Sleep was logged on every check-in day" (3 nights, 4
  check-in days). The sentence is the worked example's, applied without checking the counts.
- **Harmful instructions: 0. Diagnoses or causes: 0. Generic answers: 0.**
- One unsupported comparison ("longer than usual", there is no usual), and minor imprecision: plurals for single
  activities, "some distances are pending" when both are, a suggestion to "log GPS run distances" (the app computes
  them).
- What is useful: every accepted answer separates logged from missing data ("Mood was logged on fewer days than
  check-ins, so the average mood may not reflect the full week"), states changes only with their cited fact ("Weight
  stayed the same from the first to the last weigh-in"), and puts flags into words ("GPS runs were recorded but some
  distances are pending", "Manual and GPS runs were both recorded, and they may describe the same runs"). Seven of eight
  reuse the example's sentence pattern; six of those uses fit the week.

Also in the small-model runs: an accepted v4 answer (qwen3:4b, development, `extreme_short_sleep`) called nights of 210,
300 and 390 minutes "short on some nights and long on others", a second material contradiction (in a candidate that
was not the final one). Several rejected answers contradicted their facts too ("Two swims and one walk" for one swim;
"no activities or runs were logged" next to two GPS runs); they were refused for a number in the prose, not for the
contradiction.

### Verbatim examples (v4, qwen3:8b, validation)

Accepted, no finding except the suggestion's misreading (`val_gps_distance_unavailable`):

```json
{"summary":"Check-ins were recorded on most days, and sleep and mood were logged each time. GPS runs were recorded but some distances are pending.","observations":[{"text":"Sleep was logged on every check-in day, so the sleep figures describe those nights only.","claims":[{"factId":"sleep.nights_reported","value":4,"unit":"days","direction":"none","day":"none"},{"factId":"sleep.shortest","value":425,"unit":"minutes","direction":"none","day":"Friday"},{"factId":"sleep.longest","value":470,"unit":"minutes","direction":"none","day":"Sunday"}]},{"text":"Mood was logged on all check-in days, so the average mood reflects those days only.","claims":[{"factId":"mood.average","value":3.8,"unit":"score_1_5","direction":"none","day":"none"},{"factId":"mood.days_reported","value":4,"unit":"days","direction":"none","day":"none"}]},{"text":"GPS runs were recorded but some distances are pending.","claims":[{"factId":"gps.runs","value":2,"unit":"count","direction":"none","day":"none"},{"factId":"gps.runs_without_current_distance","value":2,"unit":"count","direction":"none","day":"none"}]}],"suggestion":"Try to log GPS run distances this week so they are complete for next week's summary."}
```

Accepted by every check, with the material contradiction (`val_weight_up_manual_runs`; 4 check-in days, 3 nights):

```json
{"summary":"Check-ins were recorded on several days, and sleep and mood were logged on some of those days. Weight increased from the first to the last weigh-in, and a few manual activities were recorded.","observations":[{"text":"Sleep was logged on every check-in day, so the sleep figures describe those nights only.","claims":[{"factId":"sleep.nights_reported","value":3,"unit":"days","direction":"none","day":"none"},{"factId":"sleep.shortest","value":380,"unit":"minutes","direction":"none","day":"Wednesday"},{"factId":"sleep.longest","value":430,"unit":"minutes","direction":"none","day":"Saturday"}]},{"text":"Mood was logged on fewer days than check-ins, so the average mood may not reflect the full week.","claims":[{"factId":"mood.average","value":3.5,"unit":"score_1_5","direction":"none","day":"none"},{"factId":"mood.days_reported","value":2,"unit":"days","direction":"none","day":"none"}]},{"text":"Weight went up from the first to the last weigh-in.","claims":[{"factId":"weight.first","value":77.1,"unit":"kg","direction":"none","day":"Monday"},{"factId":"weight.last","value":77.9,"unit":"kg","direction":"none","day":"Saturday"},{"factId":"weight.change","value":0.8,"unit":"kg","direction":"up","day":"none"}]},{"text":"Manual activities included runs and walks, but no GPS runs were recorded.","claims":[{"factId":"manual.activities","value":3,"unit":"count","direction":"none","day":"none"},{"factId":"manual.run.count","value":2,"unit":"count","direction":"none","day":"none"},{"factId":"manual.walk.count","value":1,"unit":"count","direction":"none","day":"none"}]}],"suggestion":"Try adding a short walk each day to increase activity and track progress."}
```

Rejected, failed_grounding, number_in_prose "10" (`val_activities_no_check_ins`); the amount was also wrong (the
manual activities took 85 minutes, not "about an hour and 10 minutes"):

```json
{"observations":[{"claims":[{"day":"none","direction":"none","factId":"check_ins.days_with_data","unit":"days","value":0},{"day":"none","direction":"none","factId":"check_ins.days_missing","unit":"days","value":7},{"day":"none","direction":"none","factId":"check_ins.coverage","unit":"percent","value":0}],"text":"No check-ins were recorded this week."},{"claims":[{"day":"none","direction":"none","factId":"manual.activities","unit":"count","value":2},{"day":"none","direction":"none","factId":"manual.duration","unit":"minutes","value":85},{"day":"none","direction":"none","factId":"manual.walk.duration","unit":"minutes","value":40}],"text":"Manual activities included a walk and a swim, with a total time of about an hour and 10 minutes."},{"claims":[{"day":"none","direction":"none","factId":"gps.runs","unit":"count","value":2},{"day":"none","direction":"none","factId":"gps.distance","unit":"km","value":6.4},{"day":"none","direction":"none","factId":"gps.runs_without_current_distance","unit":"count","value":1}],"text":"GPS runs were logged, but one run has no distance yet."}],"suggestion":"Try adding a check-in each day to help track your progress and stay connected.","summary":"No check-ins were recorded this week, but manual activities and GPS runs were logged. A swim and a walk were completed, along with some GPS runs."}
```

### Decision

Exploratory target (at least 8/10 ready on the validation set; accepted claims pass the unchanged checks; no material
contradiction or harmful instruction in accepted answers): **not met**. 8/10 and the claims are met; the qualitative
condition fails on one answer. This is a small-sample product gate, not a safety guarantee, in either direction.

- **Default: `WEEKLY_INSIGHTS_PROVIDER=off`**, unchanged. Neither installed model is recommended for people's data.
- **Prompt: `weekly-insight-v4` becomes the production version.** Justification: it is the strongest measured
  candidate on both models, it changes only the system message, every check and the contract are unchanged, and its
  failure (a confident but unverified sentence) is the kind of unverified prose v2 already produced ("Mood and soreness
  were generally low" for an average mood of 4.3, morning run). Stored v2 insights become `outdated_policy` (withheld,
  regenerable), as designed. Policy version unchanged: no validation or fact semantics changed.
- **For opt-in experiments only**: qwen3:8b, `WEEKLY_INSIGHTS_TIMEOUT_MS=180000`, `WEEKLY_INSIGHTS_TOTAL_BUDGET_MS=400000`
  (measured: cold 117.8 s, warm p95 109.4 s, n = 9). qwen3:4b: no (1/10 on the validation set).
- **Remaining unsatisfied constraint**: prose that states a count-like fact ("every check-in day", "long", "usual")
  is not verified, and the model does state such things. CPU latency (more than a minute per insight) is a second,
  product-level limit.

**Next decision (bounded).** Either, preferred:

1. **A deterministic product fallback**: the useful content of the accepted answers is coverage, logged-versus-missing
   and flags in words, which code can write exactly from the same facts ("Sleep was logged on 3 of 4 check-in days";
   "One GPS run has no distance yet"). Shown as app-written text, never labelled as AI. No model, no latency, no
   contradiction. Or:
2. **One more bounded experiment**, as its own decision with a policy version: a deterministic check of quantified
   coverage phrases in prose ("every/each/all/most check-in day/night") against the counts, plus a fresh validation set
   (this one has now been used), measured on qwen3:8b with the same call budget.

## Baseline run (morning): weekly-insight-v2

Generated by `npm run eval:weekly-insights -- --models qwen3:4b,qwen3:8b` on the development workstation: Ollama 0.40.14
on this machine, CPU only (`size_vram` 0 for both models), Q4_K_M quantization, temperature 0, `think: false`, a
240 s attempt timeout and a 600 s total budget per case (not the server defaults). One run, ten synthetic weeks per
model; nothing below is a stable estimate. The table and per-case results are exactly as the run printed them.

**Rule change after the run.** The run revealed that the prose rule did not list "zero" as a number word (qwen3:8b's
`empty` answer, "The check-in coverage was zero.", was accepted as ready). "zero" was added (grounding.spec.ts). The
stored answers were re-checked against the corrected rules without asking any model again
(`node --import tsx src/evaluation/weekly-insight-revalidate-main.ts <report.json>`): qwen3:4b 0/10 ready
(unchanged); qwen3:8b **1/10** ready (`empty` became failed_grounding, number_in_prose "zero"). The ADR uses the
re-checked figures.

Prompt weekly-insight-v2, policy weekly-insight-policy-2, 10 synthetic weeks per model. Small sample: percentages and p95 are indicative only.

| model | schema pass | ready | global grounding | scoped grounding | unit/direction | safety | attempts (schema / transport failures) | cold | warm median | warm p95 (n) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3:4b | 100% | 0/10 | 10 | 1 | 0 | 0 | 10 (0 / 0) | 54.9 s | 38.3 s | 58.2 s (9) |
| qwen3:8b | 100% | 2/10 | 8 | 0 | 0 | 0 | 10 (0 / 0) | 126.2 s | 69.7 s | 99.6 s (9) |

### qwen3:4b: per case

| case | status | reason / violations | attempts | duration |
| --- | --- | --- | --- | --- |
| complete (cold) | failed_grounding | number_in_prose×17 | 1 | 54.9 s |
| sparse | failed_grounding | number_in_prose×20 | 1 | 38.3 s |
| empty | failed_grounding | number_in_prose×1 | 1 | 15.0 s |
| extreme_soreness | failed_grounding | number_in_prose×22 | 1 | 37.9 s |
| extreme_short_sleep | failed_grounding | number_in_prose×14 | 1 | 25.3 s |
| weight_change | failed_grounding | number_in_prose×14 | 1 | 28.7 s |
| mixed_time_zones | failed_grounding | number_in_prose×14 | 1 | 38.7 s |
| overlapping_runs | failed_grounding | number_in_prose×11 | 1 | 43.6 s |
| stale_gps_summary | failed_grounding | number_in_prose×12, claim_value_mismatch×1 | 1 | 56.9 s |
| cross_training | failed_grounding | number_in_prose×24 | 1 | 58.2 s |

#### qwen3:4b, complete (failed_grounding), verbatim model answer

```json
{
  "observations": [
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.nights_reported",
          "unit": "days",
          "value": 7
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.average_hours",
          "unit": "hours",
          "value": 7.5
        }
      ],
      "text": "You logged sleep for all seven days with an average of 7.5 hours."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.quality_average",
          "unit": "score_1_5",
          "value": 3.4
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.average",
          "unit": "score_1_5",
          "value": 3.4
        }
      ],
      "text": "Your sleep quality averaged 3.4 out of 5, matching your mood score."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "soreness.average",
          "unit": "score_0_10",
          "value": 2.9
        },
        {
          "day": "Wednesday",
          "direction": "none",
          "factId": "soreness.highest",
          "unit": "score_0_10",
          "value": 4
        }
      ],
      "text": "You felt slightly sore on average but never exceeded a score of 4."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "up",
          "factId": "weight.change",
          "unit": "kg",
          "value": 0.3
        }
      ],
      "text": "You maintained a steady weight throughout the week, gaining 0.3 kg from start to finish."
    }
  ],
  "suggestion": "Try taking a short walk after dinner to help with sleep quality.",
  "summary": "Your week had consistent check-ins and full sleep coverage. You slept about 7.5 hours on average, with a range from 7 to 8 hours. Your mood and soreness levels were both around 3.4 and 2.9, respectively."
}
```

#### qwen3:4b, sparse (failed_grounding), verbatim model answer

```json
{
  "observations": [
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_with_data",
          "unit": "days",
          "value": 2
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_missing",
          "unit": "days",
          "value": 5
        }
      ],
      "text": "You had two days with check-ins and five days without check-ins."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.average_minutes",
          "unit": "minutes",
          "value": 438
        },
        {
          "day": "Friday",
          "direction": "none",
          "factId": "sleep.shortest",
          "unit": "minutes",
          "value": 410
        },
        {
          "day": "Tuesday",
          "direction": "none",
          "factId": "sleep.longest",
          "unit": "minutes",
          "value": 465
        }
      ],
      "text": "Your sleep averaged 7 hours and 20 minutes, with a shortest sleep of 410 minutes and longest of 465 minutes."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.average",
          "unit": "score_1_5",
          "value": 4
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "soreness.average",
          "unit": "score_0_10",
          "value": 3
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "soreness.days_reported",
          "unit": "days",
          "value": 1
        }
      ],
      "text": "Your average mood was 4 out of 5, and you logged one day of soreness at a score of 3."
    }
  ],
  "suggestion": "Try checking in once a day to build consistency.",
  "summary": "Your week had two days with check-ins and five days without, showing low check-in coverage at 29%. You reported two nights of sleep, averaging about 7 hours and 20 minutes, with a shortest sleep of 410 minutes and longest of 465 minutes. Your average mood was 4 out of 5, and you logged one day of soreness at a score of 3."
}
```

#### qwen3:4b, empty (failed_grounding), verbatim model answer

```json
{
  "observations": [
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_missing",
          "unit": "days",
          "value": 7
        }
      ],
      "text": "You didn't have any check-ins this week."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "manual.activities",
          "unit": "count",
          "value": 0
        }
      ],
      "text": "There were no manual activities recorded."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "gps.runs",
          "unit": "count",
          "value": 0
        }
      ],
      "text": "No GPS runs were tracked this week."
    }
  ],
  "suggestion": "Try checking in once this week to help track your activities.",
  "summary": "This week had no check-ins, no manual activities, and no GPS runs. Your check-in coverage was 0%."
}
```

### qwen3:8b: per case

| case | status | reason / violations | attempts | duration |
| --- | --- | --- | --- | --- |
| complete (cold) | failed_grounding | number_in_prose×6, day_in_prose×4 | 1 | 126.2 s |
| sparse | failed_grounding | number_in_prose×1 | 1 | 69.7 s |
| empty | ready | - | 1 | 49.0 s |
| extreme_soreness | failed_grounding | number_in_prose×1 | 1 | 71.6 s |
| extreme_short_sleep | ready | - | 1 | 59.8 s |
| weight_change | failed_grounding | number_in_prose×2 | 1 | 85.3 s |
| mixed_time_zones | failed_grounding | number_in_prose×6 | 1 | 69.5 s |
| overlapping_runs | failed_grounding | number_in_prose×5 | 1 | 60.4 s |
| stale_gps_summary | failed_grounding | number_in_prose×9 | 1 | 74.0 s |
| cross_training | failed_grounding | number_in_prose×2 | 1 | 99.6 s |

#### qwen3:8b, complete (failed_grounding), verbatim model answer

```json
{
  "observations": [
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_with_data",
          "unit": "days",
          "value": 7
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_missing",
          "unit": "days",
          "value": 0
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.coverage",
          "unit": "percent",
          "value": 100
        }
      ],
      "text": "You had check-ins every day, and logged sleep, mood, and soreness for all days."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.average_hours",
          "unit": "hours",
          "value": 7.5
        },
        {
          "day": "Monday",
          "direction": "none",
          "factId": "sleep.shortest",
          "unit": "minutes",
          "value": 420
        },
        {
          "day": "Sunday",
          "direction": "none",
          "factId": "sleep.longest",
          "unit": "minutes",
          "value": 480
        }
      ],
      "text": "Your average sleep was 7.5 hours, with the shortest sleep on Monday and the longest on Sunday."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.average",
          "unit": "score_1_5",
          "value": 3.4
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.quality_average",
          "unit": "score_1_5",
          "value": 3.4
        }
      ],
      "text": "Your average mood and sleep quality were similar, both around 3.4."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "up",
          "factId": "weight.change",
          "unit": "kg",
          "value": 0.3
        }
      ],
      "text": "Your weight increased slightly from the first to the last weigh-in."
    }
  ],
  "suggestion": "Try to take a short walk every day to keep moving and feel more energized.",
  "summary": "You had check-ins every day, and logged sleep, mood, and soreness for all days. Your average sleep was 7.5 hours, with the shortest sleep on Monday and the longest on Sunday."
}
```

#### qwen3:8b, sparse (failed_grounding), verbatim model answer

```json
{
  "observations": [
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.coverage",
          "unit": "percent",
          "value": 29
        }
      ],
      "text": "Check-in coverage was low, with only a few days having data."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.average_hours",
          "unit": "hours",
          "value": 7.3
        },
        {
          "day": "Tuesday",
          "direction": "none",
          "factId": "sleep.longest",
          "unit": "minutes",
          "value": 465
        },
        {
          "day": "Friday",
          "direction": "none",
          "factId": "sleep.shortest",
          "unit": "minutes",
          "value": 410
        }
      ],
      "text": "Average sleep was around seven hours, with some variation in length."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.average",
          "unit": "score_1_5",
          "value": 4
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "soreness.average",
          "unit": "score_0_10",
          "value": 3
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "soreness.days_reported",
          "unit": "days",
          "value": 1
        }
      ],
      "text": "Average mood and soreness were moderate, with only one day of soreness logged."
    }
  ],
  "suggestion": "Try to log your mood every day to get a better sense of how you're feeling.",
  "summary": "The week had a few check-ins and some sleep logged, with average mood and soreness levels in the middle range."
}
```

#### qwen3:8b, empty (ready), verbatim model answer

```json
{
  "summary": "This week had no check-ins and no manual activities or GPS runs. The check-in coverage was zero.",
  "observations": [
    {
      "text": "No check-ins were recorded throughout the week.",
      "claims": [
        {
          "factId": "check_ins.days_with_data",
          "value": 0,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "check_ins.days_missing",
          "value": 7,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "check_ins.coverage",
          "value": 0,
          "unit": "percent",
          "direction": "none",
          "day": "none"
        }
      ]
    },
    {
      "text": "No manual activities were completed during the week.",
      "claims": [
        {
          "factId": "manual.activities",
          "value": 0,
          "unit": "count",
          "direction": "none",
          "day": "none"
        }
      ]
    },
    {
      "text": "No GPS runs were recorded this week.",
      "claims": [
        {
          "factId": "gps.runs",
          "value": 0,
          "unit": "count",
          "direction": "none",
          "day": "none"
        }
      ]
    }
  ],
  "suggestion": "Try setting a small, daily goal to check-in and record at least one activity, whether it's movement or a mental check-in."
}
```

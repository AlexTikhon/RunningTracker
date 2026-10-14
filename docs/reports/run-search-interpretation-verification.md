# Run-search interpreter: verification stage (2026-10-12)

Audience: whoever decides whether to turn the interpreter on or to spend on a live measurement.
Decision record: `docs/adr/0057-natural-language-filter-proposals.md`. Procedure: `docs/runbooks/run-search-ai.md`.

## Result in one paragraph

**No real-provider verification and no semantic baseline exist.** No model name and no API key were configured in
this environment (the variables `RUN_SEARCH_AI_MODEL` and `OPENAI_API_KEY` or `OPENAI_API_KEY_FILE` are absent from
the process, the user and machine environment and the untracked `.env`), so **0 of the 75 permitted provider
dispatches were used** and the fake adapter was not substituted. What this stage did establish is offline: the
adapter and the evaluator were reviewed against OpenAI's current documentation and corrected where they fell short,
the live runner can now select cases by identity and stops on systemic failure, and one flaky browser test was
diagnosed and fixed.

## Status, kept apart

| Question | State | Evidence |
|---|---|---|
| Offline implementation | verified | unit, integration and browser suites (see `docs/progress.md`) |
| Real provider compatibility | **unavailable** | no model or key configured; no request made |
| Semantic baseline | **not measured** | needs the live run below |
| Browser path with the real provider | **unavailable** | same |

## What was reviewed against the documentation

Read on 2026-10-12: the Structured Outputs guide (Responses API mode) and the reasoning guide.

- Request shape: `text.format = { type: "json_schema", name, schema, strict: true }`, `instructions`, `input`,
  `max_output_tokens`, `store: false`. Matches the adapter. Installed SDK: `openai` 7.22.0, which types all of it.
- Strict schema rules: root object, every property required, `additionalProperties: false`, nullable values as
  `["string","null"]` with `null` in the enum, no `allOf`/`not`/`if`, at most 10 levels, 5,000 properties,
  1,000 enum values. The sent schema is within all of them (pinned by a test).
- Outcomes: `status: "incomplete"` (reason `max_output_tokens` or `content_filter`) and a `refusal` content part are
  failures that are never parsed; every answer is validated again locally.
- Response size: instructions and schema are echoed back and measure about 8.5 KiB of the 32 KiB limit; a test pins
  that a realistic body stays under half of it. The live size is unmeasured.
- Reasoning: `max_output_tokens` includes hidden reasoning tokens and a response can be `incomplete` with no visible
  text. **The default of 800 was not changed**: which model will be used is not known, `reasoning.effort` values differ
  by model (some reject the lowest), and no measurement exists. The adapter now reports reasoning and cached tokens
  so that the first run shows whether the cap is the problem.
- The model-name guard is a name pattern. Its error message, code comment, `.env.example` and the runbook said or
  implied "supports Structured Outputs"; they now say it is a name check that proves neither capability nor access,
  and that it can also refuse a name the provider would accept.

## Evaluator review

| Check | Before | Now |
|---|---|---|
| A failed call counts in every denominator | yes | yes (tested with a model that never answers: 0, not n/a) |
| A wrong outcome stays in exact-filter accuracy | yes | yes (tested) |
| Periods and distances compared by meaning | yes (instants; exact decimal metres) | unchanged |
| A dropped unsupported condition is an incorrect acceptance | only as a mismatch row | counted and listed, with an expected-versus-got table |
| English and Russian reported separately | no | yes, with numerators and denominators |
| Partial runs visible | "N of M" only | `partial`, and `PARTIAL` in the text |
| A category whose search cases all failed | showed no figure | shows 0 |
| Token usage | input and output | plus cached and reasoning; cost deliberately not calculated |
| Systemic failure | spent the whole budget | stops after 3 identical systemic failures |
| Smoke selection | first N of the file | by case id, validated before any call |

## What a live run needs

Missing configuration, by name only: `RUN_SEARCH_AI_MODEL` (an explicit model; there is no default and no fallback)
and `OPENAI_API_KEY` (or `OPENAI_API_KEY_FILE` naming a file outside the repository). Nothing else.

```text
npm run eval:run-search -- --dry-run --cases en-last-month-min-longest,ru-last-month-min-longest,en-strict-more-than,en-location,en-injection-sql
npm run eval:run-search -- --live    --cases en-last-month-min-longest,ru-last-month-min-longest,en-strict-more-than,en-location,en-injection-sql
npm run eval:run-search -- --live --out .local/eval-reports/run-search-baseline.json
```

Smoke cases: an English search, a Russian search, a clarification (`more than 5 km`), an unsupported request (a
place) and an injection attempt (an SQL command). Ceiling: 5 dispatches for the smoke run and 65 for the full
dataset, 70 of the 75 permitted; the evaluator does not know what earlier commands spent, so keep the running total.

## Addendum: operation lifetime (2026-10-14)

A defect in the offline path, found by review and fixed (ADR-0057, "request lifetime versus operation lifetime"):
the admission place was released when the HTTP request ended, not when the provider call settled, so a call that
ignored cancellation could be joined by a second one under `maxConcurrent = 1`, and a person could time out and
submit again. Admission now follows the operation. Offline only; no provider was contacted and none of the 75
permitted dispatches was used.

| Check | Result |
|---|---|
| New service tests (started-but-unsettled calls counted, deadlines fired by a manual clock) against the old service | 8 fail, among them 12 operations started under a limit of 2 |
| The same tests with the fix | 38 of 38 in `interpretation-service.spec.ts` pass |
| Route tests with a held provider on PostgreSQL (`maxConcurrent = 1`), old / new service | 2 fail (`503` expected, a second call was started) / 9 of 9 pass |
| Two route-spec tests that asserted "the place is free again" | rewritten to the new rule; both fail on the old service |
| `npm run verify` | exit 0: scripts 48, API 1111, web 520, contracts 128, fixtures 14, simulator 3 |
| `npm run test:integration` | 44 files, 435 passed |
| `npm run test:e2e -- run-search-interpretation` (fake provider) | 6 passed |

Still true after this change: the fake provider honours cancellation and settles within its delay, so no browser
scenario is slower or different; the evidence for the new rule is the API tests above. An interpreter that never
settles keeps its place until the process restarts (fail-closed, by design); a remote provider that keeps computing
after a dropped connection is not observable here.

## Addendum: a local Ollama run (2026-10-14)

The first real inference this feature has seen, with a **local** model; OpenAI is still unreached (0 of 75
dispatches used). Ollama 0.35.1 (`OLLAMA_NO_CLOUD=1`, loopback), `qwen3:8b` Q4_K_M, CPU only, Windows 11.

| What | Result |
|---|---|
| Request accepted by the real runtime (schema with nullable and enum-with-null properties, `think:false`, `stream:false`) | yes, status 200, `done_reason` `stop`, no thinking trace |
| Cold load | 12.5 s (wall 12.9 s) |
| Warm request | 11.2 s, 11.5 s, 13.2 s |
| Within the 10 s deadline (12 s maximum) | **no**, 4 of 4 evaluator calls timed out |
| Answers seen | 2 of 2 wrong: `clarify` + `conflicting_conditions` where `search` and where `unsupported` / `not_a_run_search` were expected; one carried filters next to `clarify` and was refused locally as `invalid_output` |
| Cases that produced no answer inside the deadline | 3 (`ru-last-month-min-longest`, `en-strict-more-than`, `en-location`) |
| Accuracy on the dataset | **not measured** (5 of 65 cases touched; 2 answers read) |

The evaluator's report for an Ollama run states the provider, the model, the runtime and its version, and the
generation settings (`num_ctx 4096`, `num_predict 800`, `temperature 0`, `think false`, `stream false`); it does not
attach the OpenAI SDK version. The report files are untracked (`apps/api/.local/eval-reports/`).

## Addendum: a compact Ollama wording, evaluated and not adopted (2026-10-14)

One bounded experiment: does a compact Ollama-specific wording, with the decision order stated first (unsupported,
then clarification, then search), interpret better or faster than the current one on the installed `qwen3:8b`?
**No.** The candidate was not better on any measured figure and was worse on correctness; the original wording stays.
Only the instructions differed. The OpenAI instructions are byte for byte as before (hash pinned by a test), the
Ollama wire schema (`schemaSha256` `33034b87dfca14b9…`), the public contracts, normalisation, the 10 s deadline,
generation settings (`num_ctx 4096`, `num_predict 800`, `temperature 0`, `think false`, `stream false`), admission
accounting and cancellation were not touched. No request text of the dataset is in the candidate (a test checks this
against every dataset case).

| | Original (`…ollama/2026-10-14.1`) | Candidate (`…ollama/2026-10-14.2`) |
|---|---|---|
| Instructions | 6,281 characters, 975 words, sha256 `2bcf2f32…` | 6,035 characters (-3.9 %), 930 words, sha256 `476543bc…` |
| Prompt tokens per answered call (reported total / 3) | about 1,660 | about 1,620 (-2.4 %) |

The candidate is only about 4 % shorter: every interpretation rule, trigger phrase and reason name of the original is
kept (a test compares the quoted phrases), and those lists are most of the text. The decision order is the change.

**Protocol.** Same machine, one Ollama 0.35.1 server, same model, same settings and case order, concurrency 1, the
existing `--fail-on-mismatch` gate with its early-stop rule, the existing 10 s deadline, a distinct report file per run
(`.local/eval-reports/prompt-baseline-set1.json`, `prompt-candidate-set1.json`; untracked). Before each run the model
was unloaded and loaded again with an empty prompt, so each run started from the same resident model with an empty
cache. That load generates nothing and is not counted as an inference call. No other CPU-heavy command ran during
inference; the focused tests, lint and `npm run verify` ran afterwards. The candidate was frozen (by its hash, which
each report records) before its run.

**Cold load, kept apart:** 15.5 s (original run) and 11.3 s (candidate run), wall time of the empty-prompt load,
CPU only. It is a property of the model and machine, not of the wording, and it alone exceeds the 10 s deadline.

**Set 1** (`en-last-month-min-longest`, `ru-last-month-min-longest`, `en-strict-more-than`, `en-location`,
`en-injection-sql`), 5 calls per run:

| | Original | Candidate |
|---|---|---|
| Acceptance (`--fail-on-mismatch`) | **failed**, exit 2 | **failed**, exit 2 |
| Exact matches (outcome, reason and filters) | 1 of 5 (`en-injection-sql`) | 0 of 5 |
| Outcome correct | 1 of 5 | 1 of 5 |
| Reason correct (clarify and unsupported cases) | 1 of 3 | 0 of 3 |
| Exact filters (search cases) | 0 of 2 (both timed out) | 0 of 2 (both timed out) |
| Incorrect acceptances (a search answered where a clarification or unsupported was expected) | 1 of 3: `en-location` | 2 of 3: `en-strict-more-than`, `en-location` |
| Failures | 2 `timeout` (`en-last-month-min-longest`, `ru-last-month-min-longest`) | the same 2 |
| Wrong answers | `en-strict-more-than`: unsupported / `comparison_or_analysis`; `en-location`: search | `en-strict-more-than`: search; `en-location`: search; `en-injection-sql`: unsupported / `other_attributes` |
| Latency, all 5 calls (timeouts count as about 10 s) | mean 6,791 ms, p50 6,445, p95 = max 10,012 | mean 7,368 ms, p50 8,018, p95 = max 10,009 |
| Latency, the 3 answered calls (derived from the means) | mean about 4.6 s | mean about 5.6 s |
| Tokens, 3 calls that reported usage | input 4,979 (cached 4,810), output 94 | input 4,859 (cached 4,730), output 128 |

The early-stop rule did not trigger in either run (two timeouts in a row, one short of the three that stop a run), so
all five cases were executed in both.

**Set 2** (`ru-location`, `en-supported-plus-location`, `en-not-shorter-than`, `en-dates-iso-max`, `en-units-mixed`)
was **not run**: it was to run only if the candidate passed set 1. Calls used: 10 of the 15 permitted (5 + 5), no
retries, no further tuning rounds.

**Decision:** not adopted. The candidate neither passed set 1 nor improved latency, and it turned one correct
unsupported answer (a prompt-injection attempt) into a wrong reason and one wrong clarification answer into an
incorrect acceptance. The original Ollama wording remains the one the adapter and the evaluation send. The candidate
is kept in `interpretation-prompt.ts` as an exported constant that nothing sends, pinned by hash, so the experiment can
be repeated exactly.

**Limitations.**

- Five cases, one run per prompt, `temperature 0`, no repeats: the differences between the two columns (one case each
  way, 94 against 128 output tokens) are within what one different answer would change. They show no improvement;
  they do not show that the compact wording is worse in general.
- Two of the five calls timed out in both runs, always the first two. The cached-token figures (96 % to 97 % of input
  tokens on the answered calls) suggest the calls that fit the deadline reused a prompt prefix evaluated by the earlier
  ones, so the later latencies describe a warm prompt cache and not a first request. Whether the first two would have
  answered correctly is unknown, and no prompt was shown to be fast enough cold.
- Both searches (`last month`, one English, one Russian) never produced an answer, so neither wording was measured on
  the case type the feature mostly serves.
- A warm synthetic result is not cold-start usability and not general model quality. On this CPU-only machine the
  model's cold load alone exceeds the application's deadline. The deadline was not changed, and the expected answers
  and rules were not changed.

## Not claimed

Nothing here says how well any model interprets these requests, that the provider accepts the schema, that 800
output tokens or 10 s are enough for a given model, or what a request costs. The Ollama figures above describe one
machine, one model and five cases; they are a smoke test, not a baseline.

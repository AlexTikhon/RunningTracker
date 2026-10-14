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

## Not claimed

Nothing here says how well any model interprets these requests, that the provider accepts the schema, that 800
output tokens or 10 s are enough for a given model, or what a request costs.

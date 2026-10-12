# Runbook: describing a "My runs" search in words (OpenAI)

Audience: whoever turns the feature on, demonstrates it, or measures how well a model does it.
Decision record: `docs/adr/0057-natural-language-filter-proposals.md`. Related: `docs/runbooks/demo.md`,
`docs/runbooks/deployment.md`.

## What it does, in one paragraph

On the Archive tab, "My runs" has a box above the filters. The person types a sentence in English or Russian
("Show my runs of at least 5 km from last month, longest first"), reads the disclosure, and presses **Interpret**.
The server makes one request to OpenAI and answers with filters, a clarification or an "unsupported" reason. The
filters only **fill the form**; nothing is searched until the person presses **Apply filters**, which is the
existing deterministic, owner-only search.

## Three modes, kept apart

| Mode | Configuration | What happens | What it proves |
|---|---|---|---|
| **Off** (default) | nothing | The server starts without a key. The route answers `503 INTERPRETATION_DISABLED`; the box explains that it is not turned on and the filters work. | The product without the feature. |
| **Fake** (tests, browser suite, demo) | `RUN_SEARCH_AI_ENABLED=true` `RUN_SEARCH_AI_PROVIDER=fake`; refused when `APP_ENV=production` | A few keyword rules in the API process answer. No network, no key, no cost. Control words in the text: `[delay=MS]`, `[fail]`, `[refuse]`, `[invalid]`. | The route, limits, screen and every state. **Nothing about a real model.** |
| **OpenAI** | below | One real Responses API request per click. | Only the live evaluation says how well. |

`npm test`, `npm run test:integration` and `npm run test:e2e` use only the first two. No test, build or CI step can
reach OpenAI.

## Turning it on (local)

1. Create an API key in your OpenAI project. **Put a spending limit on that project**: the limits below are per
   process, in memory, and reset when the process restarts; they are not a budget.
2. Choose a model that supports Structured Outputs through the Responses API, for example `gpt-4.1-mini` or a newer
   model of your choice. There is deliberately no default: an unset or unsuitable model stops the server at startup.
3. In your untracked `.env` (never `.env.example`, never a committed file):

   ```
   RUN_SEARCH_AI_ENABLED=true
   RUN_SEARCH_AI_MODEL=<model>
   OPENAI_API_KEY=<your key>
   ```

   or keep the key out of the file: `OPENAI_API_KEY_FILE=C:/path/outside/the/repo/openai-key` (the file holds only
   the key; setting both forms is an error).
4. `npm run dev`. The API logs `run_search.interpretation.enabled` with the model name (never the key).

Everything else is optional and bounded; `.env.example` lists each variable with its default.

## Turning it on (deployed)

The production compose file does **not** enable it and has no secret for it, so a deployment without the feature
needs no key. To enable it, add three things to the `api` service in a compose override file you keep with your
other deployment inputs:

- `RUN_SEARCH_AI_ENABLED: "true"` and `RUN_SEARCH_AI_MODEL: <model>` as environment,
- `OPENAI_API_KEY_FILE: /run/secrets/openai_api_key` as environment,
- a `secrets:` entry named `openai_api_key` whose `file:` is `${SECRETS_DIR}/openai-api-key`, listed under the
  `api` service.

`RUN_SEARCH_AI_PROVIDER=fake` is refused in production. Outbound HTTPS to `api.openai.com` must be allowed from the
API container. Review the privacy section below with whoever owns your privacy notice before switching it on.

## What is sent, what is kept

Sent to OpenAI, per click: the fixed instructions and schema, the zone name and the local date (both from the
server), and **exactly the text the person typed**. The text may contain an address or any other private
information; the screen warns about it before the click, and nothing can scrub it.

Never sent: user, organization or run identifiers, cookies, CSRF tokens, GPS points, run summaries or any database
content (the route reads none; a test records every statement). The request sets `store: false`, which asks OpenAI
not to retain the response; that is **not** a claim of zero data retention, and OpenAI's own retention terms for
your account apply.

Never persisted or logged here: the text, the prompt, the model's answer, provider error bodies. A log line is
`run_search.interpretation` with `outcome`, `durationMs`, `model`, `inputTokens`, `outputTokens`, `requestId`.
Metrics: `run_search_interpretation_requests_total{outcome}`, `run_search_interpretation_seconds{outcome}`,
`run_search_interpretation_tokens_total{direction}`.

## Limits

| Variable | Default | Meaning |
|---|---|---|
| `RUN_SEARCH_AI_USER_RATE_PER_MINUTE` | 5 | admitted requests per person per rolling minute, across sessions and organizations |
| (fixed) | 1 | in-flight interpretations per person |
| `RUN_SEARCH_AI_MAX_CONCURRENT` | 4 | provider calls at once, whole process |
| `RUN_SEARCH_AI_ALLOWANCE` / `_ALLOWANCE_WINDOW_MS` | 100 / 86400000 | provider calls per rolling window, whole process; a failure after dispatch still counts |
| `RUN_SEARCH_AI_LIMITER_MAX_USERS` | 1000 | people the limiter remembers; when full of limited people, newcomers get a "busy" answer |
| `RUN_SEARCH_AI_TIMEOUT_MS` | 10000 (max 12000) | hard deadline for the whole provider call, body included; below the browser's 15 s |
| `RUN_SEARCH_AI_MAX_OUTPUT_TOKENS` | 800 | `max_output_tokens`; reasoning models spend it on reasoning too, so do not set it very low |
| `RUN_SEARCH_AI_MAX_RESPONSE_BYTES` | 32768 | larger bodies are cut off and refused |
| (contract) | 500 code points | request text; longer text is refused, never truncated |

Refusals: `429 INTERPRETATION_RATE_LIMITED` and `INTERPRETATION_IN_PROGRESS` (with `Retry-After` where known),
`503 INTERPRETATION_BUSY` and `INTERPRETATION_BUDGET_EXHAUSTED`, `504 INTERPRETATION_TIMEOUT`, `502
INTERPRETATION_FAILED` (`details.reason`: `refusal`, `incomplete`, `invalid_output`, `oversized`, `provider_error`,
`provider_rate_limited`).

**Limitations.** A restart resets all of it. Two API processes have twice the limits. It is not a distributed
limiter and not a durable monetary budget. A transport that ignores cancellation frees its place at the deadline
while the underlying call may still be running; the real adapter honours cancellation.

## Demonstrating it

Without a key (fake provider), in the development stack:

1. `npm run db:up`, `npm run db:migrate`, `npm run demo:seed:search`.
2. API with `RUN_SEARCH_AI_ENABLED=true` and `RUN_SEARCH_AI_PROVIDER=fake`; web with `npm run dev`.
3. Sign in as the demo runner (see `docs/runbooks/demo.md`), open **Archive**, scroll to **My runs**.
4. Try, one at a time:
   - `Show my runs of at least 5 km from last month, longest first.` The form fills in; the list does not change.
     Press **Apply filters**.
   - `Runs of more than 5 km last month`: a fixed explanation, no filters.
   - `Runs in Berlin last month`: "cannot filter by place or route".
   - `Runs last month [fail]`: a failure message; the filters still work.
   - `Runs this month [delay=4000]`, then edit a filter while it runs: the late answer does nothing.

With a key: the same sentences go to the real model, and the `[...]` control words are just text.

## Measuring a model: the live evaluation

`npm run eval:run-search` is the only thing that sends the dataset to OpenAI. It is not part of `verify`, tests or
CI, and it does nothing without `--live`.

```
npm run eval:run-search -- --dry-run                      # validate dataset and configuration; no request
npm run eval:run-search -- --live --max-cases 10          # a small first run
npm run eval:run-search -- --live --out .local/eval-reports/run-search.json
```

It reads `RUN_SEARCH_AI_MODEL`, `OPENAI_API_KEY` (or `_FILE`), and the same bounds as the server. Calls: one per
case, no retries, concurrency 1 unless `--concurrency` (at most 4), each under `RUN_SEARCH_AI_TIMEOUT_MS`. The
65-case dataset at 800 output tokens per call is bounded by 65 requests per run; read your provider's pricing
before running it repeatedly.

The report states the model, the prompt version, the dataset version, the number of cases run, **outcome accuracy**
(search / clarify / unsupported), **reason accuracy** (which reason code, for the last two), **exact filter
accuracy** (every field right, for the search cases), per-field errors (`period`, `minDistance`, `maxDistance`,
`sort`), failures by reason, latency (mean, p50, p95, max), token totals, a per-category breakdown, and every case
that did not match with expected and actual codes. Matching is by meaning: the period as the instants the search
would use, distances in metres, the sort with its default.

How to read it: it is one model, one prompt, one day, 65 synthetic cases. A pass rate is evidence for that
combination, not a guarantee, and a single mismatch of a "strict operator" case is more serious than one of a sort
case, because it is a meaning the product promised not to change. Re-run after changing the instructions, the
schema, the dataset or the model; the prompt version string changes with the instructions.

**Status at the time of writing: no live evaluation has been run.** Any statement about how well a model performs
here is unverified until a report exists.

## When something is wrong

| Symptom | Likely cause |
|---|---|
| Server stops at startup naming `RUN_SEARCH_AI_MODEL` | enabled without a model, or a model name without Structured Outputs support |
| Server stops at startup naming `OPENAI_API_KEY` | enabled without a key, or a key with whitespace |
| Box says it is not turned on | `RUN_SEARCH_AI_ENABLED` is not `true` on the server the browser talks to |
| Every request is `502` with `provider_error` | wrong key, model not available to the key, schema refused, network |
| `502` with `incomplete` | `RUN_SEARCH_AI_MAX_OUTPUT_TOKENS` too low for the model |
| `502` with `invalid_output` | the model answered something the contract refuses; check the live evaluation |
| `503 INTERPRETATION_BUDGET_EXHAUSTED` | the process's rolling allowance is spent; it frees as the window moves |

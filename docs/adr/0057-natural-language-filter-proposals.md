# ADR-0057: Natural-language filter proposals for "My runs"

- Status: accepted; implemented, verified locally with deterministic doubles. **The real provider and the live
  semantic evaluation were not run** (see "What is not verified").
- Date: 2026-10-12
- Amends: nothing. ADR-0056's search endpoint, ownership rule, summary freshness, paging and map are unchanged.
- Scope: `packages/contracts`, `apps/api/src/runs/interpretation`, `apps/api/src/config`, `apps/api/src/evaluation`,
  `apps/web`, `tests/e2e`, configuration examples, one new dependency (`openai`, exact-pinned, no transitive
  dependencies).

## Context

ADR-0056 made "my finished runs of last month, between 5 and 10 km, longest first" a strict, owner-only request.
People would rather type that sentence than fill a form. A language model can translate the sentence, but a model
is not an authority: it must not choose who is searched, must not widen what is read, must not be believed when it
is wrong, and must not make the form worse for people who do not use it. So the model **proposes the form's
values**; the person reviews and applies them; the existing deterministic search retrieves the runs.

## Decision

### 1. A proposal, never a search

`POST /api/orgs/{orgId}/runs/search/interpretations` takes `{ text, timeZone }` and answers one of

- `search`: a complete replacement filter set (`period` as a preset or two inclusive dates, `minDistance`,
  `maxDistance`, `distanceUnit`, `sort`, `timeZone`), already validated;
- `clarify`: a bounded reason code (`period_missing`, `period_ambiguous`, `distance_unit_missing`,
  `distance_unit_mixed`, `distance_ambiguous`, `distance_too_precise`, `distance_boundary_strict`,
  `conflicting_conditions`);
- `unsupported`: a bounded reason code (`location`, `pace_or_speed`, `duration`, `workout_or_segments`,
  `other_attributes`, `comparison_or_analysis`, `exclusion`, `other_people`, `sort_order`, `not_a_run_search`).

The screen owns every sentence shown for a reason. No model prose reaches a person, an identifier, SQL, a cursor,
an authorization decision, a run, a count or a time zone is part of the contract (the zone is the request's; a
test pins that a model-chosen zone cannot appear). The endpoint reads no run, summary, point, share or archive
table; a recording pool in the integration test proves it. The browser's click on "Interpret" is the only trigger;
the result only fills the editable draft, and "Apply filters" is the existing button and the existing endpoint.

### 2. What can be expressed, and what is refused instead of approximated

Only what ADR-0056 can express exactly: this/previous calendar month, an explicit inclusive range with a stated
year (at most 366 days), inclusive minimum/maximum distance in `km` or `mi`, and the three sorts. The sort is
`newest` when the text names none (the search's own default; a test pins it). The server resolves presets with its
injected clock and the zone; the model never computes UTC.

The operator's meaning is preserved or the request is not turned into filters:

- "at least 5 km" is `minDistance = "5"`. "More than 5 km", "under 10 km" are `clarify:
  distance_boundary_strict`; the screen explains that limits include the number and suggests "at least"/"at most"
  in words. Nothing adds or subtracts an epsilon.
- A number with no unit, two units, "about", "long", `1.000` (thousands or a decimal), more than three decimals:
  each is a clarification. Nothing is rounded or converted, because a rounded bound changes which runs match.
- A place, pace, duration, workout, heart rate, comparison, another person's runs, an exclusion ("except
  October") or a sort the search lacks is `unsupported`; a supported condition next to an unsupported one still
  yields `unsupported`, so a condition is never silently dropped.
- Relative periods other than the two presets ("last week", "last 30 days", a month with no year) are
  `clarify: period_ambiguous`. A year is never assumed, not even from the calendar context.
- When several reasons apply: unsupported wins over a clarification, and clarifications follow a fixed
  precedence written in the instructions, so an expected answer is unique.
- Text inside the request that tries to instruct the model (reveal the instructions, change role, run SQL,
  set a zone) is ignored; if nothing else is left the answer is `unsupported: not_a_run_search`. A genuine search in
  the same text is still interpreted.

### 3. Two validations after the model

The model returns a flat object (root `type: object`, every property required, `additionalProperties: false`,
optional values nullable, no `anyOf` anywhere) through the Responses API with `text.format` strict JSON schema,
`store: false`, an explicit model and `max_output_tokens`. The union is rebuilt locally (`interpretation-schema.ts`),
and then the proposal is put through the **same contract and domain code as the search**: it is turned into a
`runSearchQuerySchema` query, the period is resolved by `normalizeRunSearch` and must not be empty (Pacific/Apia
2011-12-30 is rejected), and decimals are written in the canonical spelling (`5.0` becomes `5`, `5.2345` is
refused, never rounded). Anything that fails is an **AI failure** (`502 INTERPRETATION_FAILED`), not an
`unsupported` answer. A provider refusal, an incomplete response, invalid JSON, an oversized body and a provider
error are all failures with a bounded `details.reason`.

### 4. One request, no history, no tools

Fixed instructions (versioned: `run-search-interpreter/2026-10-12.2`), a developer message with the zone and the
local date, and the person's text byte for byte as the only user message. No tools, web search, files, embeddings,
`previous_response_id`, conversation, metadata, user or safety identifier, and nothing from the database. The text
is untrusted: it is never interpolated into the instructions (a test with a sentinel pins it). The SDK is pinned to
`maxRetries: 0` at the client and at the request, and the adapter pins `baseURL`, `organization`, `project`,
`adminAPIKey`, `webhookSecret` and `logLevel: 'off'` explicitly because the SDK would otherwise read each from the
process environment (an `OPENAI_LOG=debug` would log request bodies; `OPENAI_BASE_URL` would redirect them).
`OPENAI_CUSTOM_HEADERS` is still read by the SDK and cannot be switched off by options; it is operator configuration
like the credential. Tests use one HTTP transport double and assert
exactly one attempt after 500, 429, 408, 409 and a network error.

`store: false` asks the provider not to retain the response; it is not a zero-data-retention claim. The submitted
text can itself contain an address or other private data, and the screen says so before the click.

### 5. Authorization and the request's lifetime

Order, all before any provider contact: session, allowed Origin, CSRF token, `Content-Type`, body (strict;
text 1 to 500 code points, no control characters, never truncated), the validated zone, whether the feature is on,
active membership through `withAuthenticatedTenantTransaction`, then admission. That transaction commits and the
connection returns to the pool **before** the provider is called; an integration test runs the whole route on a
one-connection pool and proves the database stays usable while the provider is held.

Before the answer is returned the session (`SessionManager.isActive`) and the membership are checked again, each
in its own short transaction. If either was lost, the existing `401 AUTH_REQUIRED` / `403 ORG_ACCESS_DENIED` is
returned and the proposal is dropped.

The provider call has a hard deadline (default 10 s, at most 12 s, below the browser's 15 s) that covers the
response body, is raced against the provider promise so that a transport that ignores `AbortSignal` is still
answered on time, and aborts the signal. A client that disconnects aborts it too and its request is answered at
once. That ends the *request*, not the *operation*: the places stay taken until the provider call settles (see the
lifetime addendum below, which replaces the original "frees its place at the deadline" behaviour).

### 6. Cost and abuse controls (single process, in memory)

| Control | Default | Variable |
|---|---|---|
| requests per person per minute, across sessions and organizations | 5 | `RUN_SEARCH_AI_USER_RATE_PER_MINUTE` |
| in-flight interpretations per person | 1 | fixed |
| concurrent provider calls, process-wide | 4 | `RUN_SEARCH_AI_MAX_CONCURRENT` |
| dispatched calls per rolling window, process-wide | 100 per 24 h | `RUN_SEARCH_AI_ALLOWANCE`, `RUN_SEARCH_AI_ALLOWANCE_WINDOW_MS` |
| people tracked by the limiter | 1000 | `RUN_SEARCH_AI_LIMITER_MAX_USERS` |
| request text | 500 code points | contract |
| output tokens | 800 | `RUN_SEARCH_AI_MAX_OUTPUT_TOKENS` |
| response body | 32 KiB | `RUN_SEARCH_AI_MAX_RESPONSE_BYTES` |
| provider deadline | 10 s | `RUN_SEARCH_AI_TIMEOUT_MS` |

`admit()` checks and reserves in one synchronous step, so simultaneous requests cannot take the last place. A
request that reached the provider keeps its charge whatever happened afterwards; one admitted and never dispatched
is refunded. "Concurrent provider calls" and "in-flight per person" count **provider operations that have not
settled**, not HTTP requests (see the lifetime addendum). Refused requests are not charged. A table full of people who are still limited refuses newcomers
rather than forgetting someone. These limits **reset when the process restarts, are per process and are not a
distributed limiter or a durable monetary budget**; a provider-side spending limit is the real budget. No Redis and
no quota table were added.

### 7. Configuration, privacy and operations

Off by default; a disabled server needs no credential, builds no client and answers `503 INTERPRETATION_DISABLED`.
Enabling needs `RUN_SEARCH_AI_ENABLED=true`, an explicit `RUN_SEARCH_AI_MODEL` (checked for Structured Outputs
support by name: gpt-4o-mini, gpt-4o from 2024-08-06, gpt-4.1, gpt-5 and later, the o-series; there is no silent
fallback to another model) and `OPENAI_API_KEY` or `OPENAI_API_KEY_FILE`. The key lives only in the validated configuration and the adapter; it is
never logged, put in an error message (a test with a sentinel key pins this for configuration, the adapter and the
live runner) or written to the OpenAPI document. `RUN_SEARCH_AI_PROVIDER=fake` is an
in-process deterministic stand-in, refused in production, used by tests, the browser suite and the demo.

Nothing about the text, the prompt, the model's answer or a provider error is persisted or logged. A log line
carries `outcome`, `durationMs`, `model`, token counts and `requestId` (the logger's allowlist gained `model`,
`inputTokens`, `outputTokens`); metrics carry the same outcome and direction labels, a bounded set.

### 8. The screen

`RunSearchInterpreter` sits above the filters: a text box, the disclosure ("sent to OpenAI ... do not write
addresses"), an explicit **Interpret** button, a character count, and one status area. A proposal replaces the draft
and says that nothing was searched and the earlier results are still the applied ones. A clarification or an
unsupported reason is fixed text. A disabled server, a rate limit, a busy interpreter, a timeout and a failure each
have their own sentence and a manual way on; nothing retries by itself.

`RunSearchInterpretationController` is framework-free. A generation counter, not the abort signal, decides whether
an answer is still wanted, so a transport that ignores cancellation cannot overwrite newer input. A pending or shown
interpretation is invalidated by a text edit, a manual draft edit, "Apply filters", a newer interpretation, and by
disposal (organization or person change, sign-out, unmount). A mutation that makes the guard ignore the generation
fails three controller tests.

## Evaluation

`apps/api/evaluation/run-search-interpretation.v1.json`: 65 synthetic cases, 51 English and 14 Russian, in 11
categories (29 expect a search, 19 a clarification, 17 an unsupported answer), covering every reason code. Expected filters are compared by meaning: the period as
the instants the search would use (so "this month" equals this month's explicit dates), each distance in metres, and
the sort with the server default. `npm run eval:run-search -- --live` is the only thing that calls the provider. It
needs `--live`, bounds the calls (one per case, no retries, at most 200, concurrency at most 4), and reports model,
prompt version, dataset version, case count, outcome accuracy, reason accuracy, exact filter accuracy, per-field
errors, failures by reason, latency, tokens and each mismatched case. The deterministic tests prove the evaluator
with an oracle and with deliberately wrong interpreters; **they say nothing about a real model's accuracy**.

## Alternatives considered

- **A GET with the text in the query string.** Rejected: user text would land in access logs and proxies, and the
  action is billable and must carry the CSRF token.
- **Letting the model call the search (tool use).** Rejected: it would make the model an actor with a query; the
  proposal-then-apply split is what keeps the person and the deterministic search in charge.
- **Returning a free-text explanation from the model.** Rejected: untrusted prose on the screen; reason codes give
  the same help with fixed, reviewed, translatable sentences.
- **Rounding or nudging bounds to express "more than".** Rejected: it silently changes which runs match.
- **A distributed limiter or a database quota.** Out of scope; documented as a limit.
- **Reading a capability flag before showing the box.** Not built: the box is always shown, and the first refusal
  from a server without the feature switches it to an explanation for that visit.

## What is not verified

- **No call was made to OpenAI** by the implementation, the tests or this documentation: not one request, and so
  not one measurement of how a real model interprets the dataset. The model-name check, the schema's acceptance by
  the provider's strict mode, token budgets and latency are all unmeasured. The first live run may find that a
  provider rejects the schema or that the instructions need work; the evaluator exists for exactly that.
- The documentation of Structured Outputs, the Responses API and the Node SDK was read on 2026-10-12 and the SDK's
  installed types were used for parameter names; behaviour of the live service beyond that is assumed.
- Limits are per process; a restart resets them; two processes double them.
- The 401/403 recovery in the browser reuses ADR-0054's announcement and the search's lost-access wording; a
  mid-flight revocation is proven at the API, and in the browser only by the controller's mapping.
- Chromium only. No measurement of the cost of a request.

## Consequences

- A person without a key or a network sees the same product; a server with the feature on adds one box.
- The prompt and the dataset are versioned together; a change to either should be followed by a live run.
- A new filter in a later stage must be added to the contract, the schema, the instructions, the normalization and
  the dataset in the same change; a test fails if the reason lists and the schema drift apart.

## Addendum: verification stage (2026-10-12)

Changes made after the first implementation, none of which is a new product behaviour:

- **The model-name check is a name pattern, not a capability or access check.** Its message, code comment,
  `.env.example` and the runbook said or implied that a passing name "supports Structured Outputs". They now say what
  it is, and that it can also refuse a name the provider would accept. Only a live request settles either.
- **Reasoning tokens are reported.** `InterpreterUsage` gained optional `reasoningTokens` and `cachedInputTokens` (from
  `output_tokens_details` and `input_tokens_details`); a response without them reports `null`, never zero. The
  default `max_output_tokens` (800) was not changed: the documented behaviour (the cap includes reasoning, a response
  can end `incomplete` with no visible text) depends on a model this repository does not know, and no measurement
  exists. The adapter still sends no `reasoning` parameter.
- **The evaluator** reports numerators and denominators, English and Russian separately, an expected-versus-got
  table with the requests wrongly accepted as searches, `partial` for a run that did not cover the dataset, and
  cached and reasoning tokens; a category whose search cases all failed reports 0. It stops after three identical
  systemic failures in a row (`provider_error`, `provider_rate_limited`, `timeout`, `oversized`, `incomplete`);
  refusals and contract-invalid answers are measured, not systemic. The runner selects cases by id (`--cases`),
  validates them before any request and records the SDK version and hashes of the instructions and the schema.
- **Still unmeasured**: provider acceptance of the schema, availability of the chosen model, token budget, latency,
  accuracy and cost. See `docs/reports/run-search-interpretation-verification.md`.

## Addendum: request lifetime versus operation lifetime (2026-10-14)

**Defect.** The service released its admission ticket in a `finally` after `Promise.race([providerCall, deadline])`.
The race ends the *request* on time, but the provider promise may still be pending, so the place was freed while the
call it stood for was still running. With `maxConcurrent = 1`: admit A; A ignores `AbortSignal` and passes the
deadline; the request answers `504` and A's ticket is released; B is admitted while A is unsettled; two provider
operations are outstanding under a limit of one. The same person could time out and submit again, which defeated the
one-in-flight rule. The original ADR text ("frees its place at the deadline") and two tests asserted exactly this; it
was a design error, not an accepted trade-off, because the limits exist to bound outstanding provider calls.

**Decision: two lifetimes, and the ticket follows the operation.**

| | Request | Operation |
|---|---|---|
| What it is | the HTTP request awaiting an answer | the interpreter's promise |
| Ends | at the deadline, when the client leaves, or on an answer | when that promise resolves or rejects |
| Owns | the response, the metrics and log line of the request, the access re-check | the global concurrency place, the person's in-flight reservation, the allowance charge |

- An admission ticket stands for an admitted provider *operation*. It is released in exactly one place: attached to
  the settlement of the interpreter's promise. It is not released by the deadline, by client cancellation, by an
  unrelated error, or by any timer or lease. Releasing it twice is impossible by construction (and the ticket is
  idempotent as a second line).
- A request that never reached the interpreter (cancelled before admission, or its input could not be built) is
  refunded as before. A synchronous throw from `interpret()` is a dispatched operation that settled at once: the
  charge stays and nothing is held.
- On a normal answer the ticket is released by the settlement itself, before normalization and before the access
  re-check, so a slow membership transaction never holds provider capacity.
- The request still ends promptly and with the same codes: `504 INTERPRETATION_TIMEOUT` at the deadline, `499
  INTERPRETATION_ABORTED` when the client is gone. The signal is aborted at both, and again when the request ends.
- An operation that outlives its request gets terminal handlers, so a late rejection is never an unhandled
  rejection. Its late result is dropped: not normalized, not re-validated against the session or membership, not
  counted as another outcome, and no second `run_search.interpretation` line or request counter increment.
- One bounded line is added for operators: `run_search.interpretation.operation_settled` with `reason`
  (`fulfilled` or `rejected`), `durationMs` since dispatch, `model` and `requestId`, emitted only when an
  abandoned operation settles. Without it, "busy" cannot be told from "stuck". No text, identifier, token count or
  provider body is carried, and no metric was added.

**Uncooperative interpreters: fail closed, by design.** If an interpreter never settles, its place stays occupied.
This is intentional. A lease, expiry or "cleanup" timer that gave the place back while the original call may still be
running would recreate the defect, only later. The consequence is bounded and visible: up to `maxConcurrent`
interpretations can become unavailable (`503 INTERPRETATION_BUSY` for others, `429 INTERPRETATION_IN_PROGRESS` for the
person whose call is stuck) while manual search, which never touches this module, keeps working. Recovery is the
operation settling or a process restart (which also resets the in-memory limits). The real adapter bounds its own call
with a transport timeout and honours the signal, so in production a place is held for about the provider deadline at
most; a different `RunSearchInterpreter` must meet the contract in `interpretation-types.ts`.

**What this does and does not establish.**

- Completing or ending a request does not establish that its operation completed.
- An `AbortSignal` is a cancellation *request*, not proof of termination.
- Operation settlement bounds the **locally tracked** calls: the number of unsettled interpreter promises in this
  process never exceeds `maxConcurrent`. It does not prove that a remote provider stopped computing, or stopped
  billing, for a call whose connection was dropped.
- State is in memory and per process. A restart forgets outstanding operations (they no longer exist in the new
  process, but the provider may still be working on them), and two processes each have their own limit.
- Not built, deliberately: process supervision, worker termination, durable quotas, provider-side cancellation
  APIs, a queue, a distributed semaphore.

**Verification.** Deterministic, offline, with a deferred interpreter that ignores the signal and counts calls that
started and have not settled (not HTTP requests), and a timer clock that only fires when told. Fifteen tests in
`interpretation-service.spec.ts` plus two through the real route on PostgreSQL
(`run-search-interpretation.integration.test.ts`); the two route-spec tests that encoded the old behaviour were
rewritten. Each new test was run against the unchanged service and fails there (the repeated-attempt test shows 12
operations started under a limit of 2). Unrelated limits (per-person rate, allowance, tracked people) are set far
above anything the tests do, so another limiter cannot mask a leaked place.

## Addendum: a local Ollama interpreter (2026-10-14)

**Goal.** Run the real interpretation path on a developer machine without an OpenAI key and without spending money.
The product, the contract, the prompt, the schema, admission, the operation-lifetime rule and the evaluator are
unchanged; a third `RunSearchInterpreter` was added and the configuration learned about it.

**Configuration is a discriminated union.** `RUN_SEARCH_AI_PROVIDER` is `openai` (default), `ollama` or `fake`, and
the validated configuration is `OpenAiRunSearchAiConfig` (carries `apiKey`), `OllamaRunSearchAiConfig` (model only)
or `FakeRunSearchAiConfig`, told apart by `provider`. An Ollama configuration has no credential field and no
URL or host field, so there is nothing to cast and no invalid combination to represent. `createInterpreter` is an
exhaustive `switch` over the union: a new provider does not compile until handled, nothing falls back to another
provider, and the OpenAI client is constructed only for the OpenAI configuration (a test counts constructions).
In Ollama mode `OPENAI_API_KEY` is never read or validated and `OPENAI_API_KEY_FILE` is not opened. AI stays
disabled unless `RUN_SEARCH_AI_ENABLED=true`.

**Local development and test only.** The destination is the constant `http://127.0.0.1:11434`. It is not a setting,
and no request field can change it, so container networking (where loopback is the container itself), a remote
Ollama, authentication and TLS are **outside this stage**. `APP_ENV=production` refuses the provider with the same
message as `fake`. The model name is checked as a *name*: a local reference such as `qwen3:8b`, and never a cloud
model (`:cloud`, `-cloud`, `ollama.com`). The runbook says to start Ollama with `OLLAMA_NO_CLOUD=1`; the check
of the name and the loopback address are the application's part, and the local server's setting is the operator's.

**Adapter (`ollama-interpreter.ts`).** One non-streaming `POST /api/chat`: the instructions (the OpenAI wording with
only its output-format lines replaced, see the addendum "an outcome-dependent output contract for Ollama") plus the
server's calendar facts as one `system` message, the person's text byte for byte as the `user` message, the
outcome-dependent Ollama JSON Schema as `format`, `think: false` (Qwen3 reasons otherwise), `temperature: 0`, `num_predict` from the output
limit, `num_ctx: 4096` written down (Ollama truncates an over-long prompt silently, from the front, where the
instructions are; a prompt that filled the window is refused as `incomplete`). No tools, no images, no keep-alive
override, no retries, no credential, no identity. Only `message.content` is parsed; `message.thinking`, if present,
is never read, returned or logged. The envelope, `done`, `done_reason` (`stop` only), the absence of tool calls, the
JSON and the proposal schema are all checked locally: a cut, malformed or inconsistent answer is a provider failure
(`incomplete`, `invalid_output`, `provider_error`), never an `unsupported` application result. `eval_count` and
`prompt_eval_count` map to output and input tokens, `prompt_eval_cached_count` to cached; reasoning tokens are `null`.
Redirects are refused (`redirect: 'manual'`, 3xx is a failure and nothing is followed), error bodies are not read,
and the response body is size-limited while it is read (the same `boundedFetch` as the OpenAI adapter).

**Lifetime.** The adapter's promise is the operation: it passes cancellation to the transport (`fetch` signal, which
also ends the body read) and settles when the transport does. It never races the signal, so while its own local
transport work is outstanding it has not settled, and the service keeps the admission place (checked once by hand:
with the adapter changed to race the signal, two of its tests fail). A transport that ignores cancellation is simply waited for; its late
result is `aborted`. The adapter has its own deadline on the transport as well. Because Ollama serves one request
at a time by default (`OLLAMA_NUM_PARALLEL=1`) and keeps working after a client disconnects only until it notices,
`RUN_SEARCH_AI_MAX_CONCURRENT=1` is the sensible local value; this is documentation, not a default change.

**Evaluator.** `RUN_SEARCH_AI_PROVIDER` selects `openai` or `ollama` for `npm run eval:run-search`; `fake` is
refused rather than replaced by a paid provider, because a measurement of a stand-in is worthless. The dataset,
scoring, case selection, failure accounting, early stop, hashes and partial-run reporting are reused unchanged. A
report now carries `provider`, `model`, `runtime` (for Ollama: `ollama` and the version read once from `/api/version`
before any inference; for OpenAI: the SDK and its version, which are never attached to a local run) and the
generation settings. `--live` is still required; `npm test`, the integration suite and the browser suite need no
Ollama.

**Measured on this machine (2026-10-14; a smoke, not a baseline).** Ollama 0.35.1 with `OLLAMA_NO_CLOUD=1`,
`qwen3:8b` (8.2B, Q4_K_M, 5.2 GB), **CPU only** (`size_vram` 0). Raw, by direct calls:

| What | Result |
|---|---|
| Cold load (model unloaded, one-token request) | **12.5 s** load, 12.9 s wall |
| Evaluator, cold, 10 s deadline | `timeout` at 10.03 s (the load finished in the background) |
| Evaluator, warm, 10 s deadline, 3 cases | `timeout` x3 at 10.0 s; stopped early by its own rule |
| Warm, long adapter limit, `en-last-month-min-longest` | 11.2 s and 13.2 s: valid JSON in the schema's shape, but `clarify` with `conflicting_conditions` **and** filters set; refused locally as `invalid_output`. Expected: `search` |
| Warm, long adapter limit, `en-injection-sql` | 11.5 s: `clarify` / `conflicting_conditions`. Expected `unsupported` / `not_a_run_search` |

What this establishes: the request shape works against the real runtime (Ollama accepted the schema with nullable
and enum-with-null properties, `think: false` produced no thinking trace, `done_reason` is `stop`, and `length`
for a `num_predict` cut, which the documentation does not define); **the application's deadline (10 s, at most 12 s)
cannot be met by this model on this hardware, even warm, and a cold start alone exceeds it**; and this model, with
this prompt, answered two of two readable cases wrongly. What it does not establish: accuracy on the dataset (three
of the five cases produced no answer within the deadline and were not re-run with a long limit), behaviour on a GPU,
another model, or another version. **The deadlines were not changed.** Making local inference usable here needs
hardware or a smaller model, or an explicit decision about a longer, local-only deadline; that is a separate
decision and was not made.

**Limits, restated.** Windows 11, one machine, one model, CPU. `think: false` for a model that has no thinking
capability is unverified (only `qwen3:8b` was installed). Whether the Ollama runtime keeps computing after the
client drops the connection was not measured here; the server log showed the task cancelled and its slot idle
after the 10 s deadline, which is what the service's fail-closed accounting assumes, but a single observation.

### Addendum (2026-10-14): an outcome-dependent output contract for Ollama

**Problem.** The one wire schema (flat, ten required nullable fields) is legal for answers that contradict
themselves. Measured with `qwen3:8b`: `clarify` with `conflicting_conditions` and a period and a distance set, which
the local check then refused as `invalid_output`. OpenAI's Structured Outputs force that flat shape (a root object,
no composition); Ollama's `format` accepts a full JSON Schema.

**Decision.** Ollama has its own wire schema (`ollama-output-schema.ts`): a root `oneOf` of four closed objects,
`outcome` first in each: a search over a preset period, a search over `dates` (both ends required), a clarification
(only `clarificationReason`) and an unsupported answer (only `unsupportedReason`). Reasons are the contract's own
enumerations; a reason of the other family, a filter next to a non-search outcome, a null or missing period, dates
with one end, and any unknown key are not representable. The zod schema that checks the reply and the JSON Schema
that is sent are the same contract, and a specification validates both against a generated corpus of damaged answers.

**What does not change.** The domain contract, the OpenAI wire schema and wording (byte for byte; its SHA-256 is
pinned), the public API, UI, SQL and authorization. The wire answer is mapped by `proposalFromOllamaWire` field for
field into `ProviderProposal` (fields the shape lacks are `null`; nothing is computed, defaulted, repaired or dropped)
and then goes through `providerProposalSchema` and the normaliser exactly as an OpenAI answer. Operation-lifetime
admission, cancellation, the response size limit, the loopback-only transport and disabled cloud access are untouched.

**Prompt.** The Ollama instructions equal the OpenAI ones except for the output-format lines under OUTCOMES; the
rules and the reason precedence are the same text (a test compares everything outside that block). It has its own
version, `run-search-interpreter-ollama/2026-10-14.1`, and an evaluation report hashes the instructions and schema of
the provider that ran.

**Limits.** A valid shape is not a correct interpretation: distance bound and unit consistency, decimal and date
syntax and semantics are still the normaliser's. The hand-written schema uses only `type`, `enum`, `properties`,
`required`, `additionalProperties` and `oneOf`; whether another runtime or version converts `oneOf` to a grammar is
unverified beyond Ollama 0.35.1.

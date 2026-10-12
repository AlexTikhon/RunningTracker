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
answered on time, and aborts the signal. A client that disconnects aborts it too and frees its place at once.

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
is refunded. Refused requests are not charged. A table full of people who are still limited refuses newcomers
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

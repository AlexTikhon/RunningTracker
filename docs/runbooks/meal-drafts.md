# Runbook: drafting a meal from text (local Ollama)

Audience: whoever turns the feature on, demonstrates it, or measures a model with it.
Decision record: [ADR-0092](../adr/0092-meal-draft-from-text.md). Related: [ADR-0083](../adr/0083-manual-meal-log.md)
(the meal log), [run-search-ai.md](run-search-ai.md) (the same local Ollama setup), [weekly-insights.md](weekly-insights.md).

## What it does

In the Meal log, **Draft from text (optional)** takes a sentence describing ONE meal ("Dinner: chicken and rice, total
650 kcal, protein 40 g", or in Russian) and, on **Propose draft**, asks a local model for evidence. The server keeps only
what it can verify in the text and shows a proposal with an excerpt for every value. **Apply to form** fills the ordinary
form; **Add entry** saves it through the normal create route. Nothing is saved before that, and the saved entry is
`source: manual` (the person confirmed every value).

## Modes

| Mode | Configuration | What happens | What it proves |
|---|---|---|---|
| **Off** (default) | nothing | `POST …/meals/draft-proposals` answers `503 MEAL_DRAFT_DISABLED`; the panel says the feature is not turned on and the form works as always. | The product without it. |
| **Fake** (tests, browser suite, demos) | `MEAL_DRAFTS_PROVIDER=fake`; refused when `APP_ENV=production` | A deliberately naive in-process stand-in that copies every "number + kcal" and "protein 40 g" it sees. Control words: `[delay=MS]`, `[fail]`, `[unavailable]`, `[invalid]`, `[ungrounded]`, `[fabricate]`, `[clarify]`, `[unsupported]`. | The route, limits, grounding and screen. **Nothing about a model.** |
| **Ollama** | below | One chat request per click to a local Ollama. | Only the evaluation says how well. |

`npm test`, `npm run test:integration` and `npm run test:e2e` use only Off and Fake; none needs a running Ollama.

## Turning it on locally

1. Install Ollama and pull a model yourself; nothing here downloads one (`ollama pull qwen3:8b`).
2. Run it local-only: `OLLAMA_NO_CLOUD=1 OLLAMA_HOST=127.0.0.1:11434 ollama serve` (PowerShell:
   `$env:OLLAMA_NO_CLOUD='1'; $env:OLLAMA_HOST='127.0.0.1:11434'; ollama serve`).
3. In your untracked `.env`:

   ```text
   MEAL_DRAFTS_PROVIDER=ollama
   MEAL_DRAFTS_MODEL=qwen3:8b
   # optional, these are the defaults:
   # MEAL_DRAFTS_OLLAMA_BASE_URL=http://127.0.0.1:11434
   # MEAL_DRAFTS_TIMEOUT_MS=45000        (at most 55000)
   # MEAL_DRAFTS_MAX_CONCURRENT=1
   # MEAL_DRAFTS_USER_RATE_PER_MINUTE=5
   # MEAL_DRAFTS_ALLOWANCE=200           per MEAL_DRAFTS_ALLOWANCE_WINDOW_MS (24 h)
   # MEAL_DRAFTS_MAX_OUTPUT_TOKENS=600
   # MEAL_DRAFTS_MAX_RESPONSE_BYTES=32768
   ```

4. `npm run dev`. The API logs `meal_draft.enabled` with the model name.

The base URL must be a local Ollama: loopback, a private address, `host.docker.internal` or a single-label service name,
without credentials or a path (the weekly insight's rule). Cloud model names (`…:cloud`, `…-cloud`) are refused. A
production configuration may use `ollama` (never `fake`); review the privacy notes below first.

## What is sent, what is kept

- **Sent to the model, per click:** fixed instructions (`meal-draft-prompt-1`, in `meal-draft-prompt.ts`) and exactly
  the text typed, trimmed. Not the date, the zone, any entry, check-in, activity, identity or organization.
- **Kept:** nothing. The text, the model's answer, the prompt and the proposal are not stored or logged. A saved entry is
  only what the person saved through the form.
- **Logged:** `meal_draft.proposal` with `outcome`, `durationMs`, `model`, `requestId` and four integer field counts;
  `meal_draft.operation_settled` when a call ends after its request was answered. Metrics:
  `meal_draft_proposal_requests_total{outcome}`, `meal_draft_proposal_seconds{outcome}`,
  `meal_draft_fields_total{disposition}`.

## Reading answers and failures

| Answer | Meaning | What the person sees |
|---|---|---|
| `draft` | Title (an excerpt), meal type if named, each value `proposed`, `not_stated` or `withheld` | The proposal with evidence; Apply / Discard |
| `clarify multiple_meals` / `no_food_named` | More than one meal (also forced when the text names two meal types), or numbers without food | Reword or fill the form |
| `unsupported estimate_requested` / `not_a_meal` | Asks for an estimate, or is not a meal eaten | Explanation; the form |
| `503 MEAL_DRAFT_DISABLED` | Off | "not turned on" notice for the rest of the screen |
| `429 …RATE_LIMITED` / `…IN_PROGRESS`, `503 …BUSY` / `…BUDGET_EXHAUSTED` | Admission | Try again (with the wait when known) |
| `504 MEAL_DRAFT_TIMEOUT` | No answer within the deadline | Took too long |
| `502 MEAL_DRAFT_FAILED` `provider_unavailable` | Ollama not reachable (not running, wrong URL) | Could not be made; the form works |
| `502 … invalid_output` / `incomplete` / `oversized` / `ungrounded_output` | The answer was not usable (bad shape, cut by `num_predict`, too large, a title not in the text) | Could not be made |

**After a timeout the place is still held**: the call keeps its concurrency place and the person's in-flight reservation
until Ollama ends it (ADR-0057 addendum). With `MEAL_DRAFTS_MAX_CONCURRENT=1`, everyone gets `MEAL_DRAFT_BUSY` meanwhile.
That is intended; restart the API if a call never settles.

## Measuring a model

The evaluation is opt-in and never part of `verify` or CI. It uses two frozen synthetic sets in `apps/api/evaluation/`
(`meal-draft.development.v1.json`, `meal-draft.heldout.v1.json`, pinned by digest in `meal-draft-evaluation.ts`), one
call per case, sequentially, no retries, at most 40 calls per run, and stops after three identical systemic failures in a
row. It checks that the model is already installed (`/api/tags`) and never pulls one.

```text
npm run eval:meal-drafts -- --set development --provider fake          # harness self-check, NOT model evidence
npm run eval:meal-drafts -- --set development --provider ollama --dry-run
npm run eval:meal-drafts -- --set development --provider ollama --max-calls 20 --out .local/eval/dev.json
npm run eval:meal-drafts -- --set heldout --provider ollama --max-calls 20 --out .local/eval/heldout.json
```

The model and settings come from the `MEAL_DRAFTS_*` variables (set `MEAL_DRAFTS_TIMEOUT_MS=55000` to measure at the
product's longest deadline). The report separates: outcome/reason/title/meal-type accuracy; extraction precision and
recall; **incorrectly accepted fields** (the safety number: any value shown that is not the expected one); abstentions by
the model, by grounding and by a non-draft outcome; wrong claims the grounding stopped; failures by reason; latency.

Rules for an honest run: the held-out set is run once with the frozen prompt and rules; nothing may be changed after
looking at its results (a change means new sets and a new version). A fake run is labelled as harness verification and is
never quoted as model quality. The last measured results are in
[docs/reports/meal-draft-model-evaluation-2026-11-14.md](../reports/meal-draft-model-evaluation-2026-11-14.md).

## Troubleshooting

- **Every draft fails with `provider_unavailable`:** Ollama is not running, or `MEAL_DRAFTS_OLLAMA_BASE_URL` points
  elsewhere. `curl http://127.0.0.1:11434/api/version`.
- **Every draft times out:** the model is too slow on this machine for the deadline. Use a GPU or a smaller model, or
  raise `MEAL_DRAFTS_TIMEOUT_MS` up to 55000; the browser waits 60 s. Nothing falls back to another provider.
- **A value I wrote was not filled in:** read the reason under it. The rules are deliberately conservative (per serving,
  approximate, two values, no unit next to the number, a food weight): type the value yourself. When the text mentions
  "per 100 g", "per serving", "на 100 г", a nutrition label or similar anywhere, only values in a sentence of their own
  that sums up what was eaten ("In total I ate 120 kcal", "Итого 240 ккал") are filled in; a label-style "Total 120 kcal",
  "Fat 4 g total", "overall" or "всего" is not enough, and neither is a summing sentence that also gives the food's weight
  ("I ate 200 g in total, protein 8 g"). A hedge such as "about" or "примерно" anywhere withholds every value; a dash with
  a space before a number ("- 500 kcal") is read as a possible minus sign and withheld; and two numbers joined by a dash,
  "to", "or", "до" or "или", also across a line break ("500 -\n600 kcal"), are a range and withheld.

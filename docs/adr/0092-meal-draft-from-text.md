# ADR-0092: Draft a meal from text with a local model: grounded evidence, editable proposal, confirmed through the manual form

- Status: accepted; implemented and verified locally (unit, real PostgreSQL integration, Chromium end-to-end with the
  fake provider). Real-model evaluation: see "Evaluation" (historical, before the grounding corrections). The feature is
  **off by default**.
- Amended: 2026-11-14, grounding corrections (qualifier scope, signs, exact decimals); see "Amendment" below.
- Amended again: 2026-11-14, second grounding correction (a label's "total", ranges split by a line break); see
  "Amendment 2" below.
- Date: 2026-11-14
- Relates to: ADR-0083 (the meal log, its contract, idempotent creation per form session, `source: manual`, erasure),
  ADR-0057 and its addendum (proposals that change nothing until accepted; admission; request and operation lifetimes),
  ADR-0076 (the local Ollama adapter and its address rule), ADR-0074 (dates and "today"), ADR-0080 (session revocation
  across instances), product direction ("food text parsing against a JSON schema, which the person confirms").
- Scope: `packages/contracts/src/meal-draft.ts`, `apps/api/src/meals/drafts/*`, `apps/api/src/config/meal-drafts-config.ts`,
  the meal router, the Meal log screen (`MealDraftPanel`, `meal-draft*.ts`), the evaluation sets and runner, tests, docs.
  **No migration, no new table, no new dependency, no new provenance.** Excluded: food databases, photographs, nutrition
  estimation, dietary advice, chat, batch meal creation, and any change to weekly insight or weekly review inputs.

## Context

The meal log (ADR-0083) asks people to type a title and up to four totals. People often already have a sentence: "Dinner:
chicken and rice, total 650 kcal, protein 40 g". The roadmap's AI layer names this exact step, and its principles fix the
shape: the model never computes numbers, and a model's output only proposes; the person confirms. The risk is specific:
a number in someone's food diary that they did not write (an estimate, a per-100-g value taken as a total, a food weight
taken as protein, a rounded value, a value the text negates). A false abstention costs one field to type; a false
acceptance silently corrupts a record. Every rule below is chosen for that asymmetry.

## Decision 1: a proposal endpoint that stores nothing

`POST /api/orgs/:orgId/meals/draft-proposals`, under the meal router (so it inherits `Cache-Control: no-store`, also for
a malformed body), with the session, an allowed Origin and the CSRF token.

| Request (`meal-draft-1`, strict) | |
|---|---|
| `text` | 1..500 code points, not blank, no control characters (shared `hasControlCharacter`, now in `primitives.ts`), no lone surrogate |
| `localDate`, `timeZone` | The **form's** date and zone. The meal log's rules apply before any model call (not before 2000-01-01, not after today in the zone by the injected server clock; `400 INVALID_REQUEST`). Echoed, canonical, in the answer. **Never sent to the model**; the model cannot choose or change them. |
| `version` | `"meal-draft-1"`; anything else is refused |

The answer is one of three outcomes, each with `version`, `localDate` and `timeZone`:

- `draft`: `title` (an exact excerpt of the text), `mealType` (`proposed` with the excerpt that names it, or
  `not_stated`), and `nutrition` with each of `energyKcal`, `proteinG`, `carbohydrateG`, `fatG` independently `proposed`
  (`value` + `excerpt`), `not_stated`, or `withheld` with a reason (`per_portion`, `conflicting`, `negated`, `ambiguous`,
  `unit_not_supported`, `outside_contract`, `unverified`). Every nutrition field not stated is a title-only draft.
- `clarify`: `multiple_meals` or `no_food_named`.
- `unsupported`: `estimate_requested` or `not_a_meal`.

Failures: `503 MEAL_DRAFT_DISABLED` (off), `429 MEAL_DRAFT_RATE_LIMITED` / `MEAL_DRAFT_IN_PROGRESS` (with `Retry-After`
where known), `503 MEAL_DRAFT_BUSY` / `MEAL_DRAFT_BUDGET_EXHAUSTED`, `504 MEAL_DRAFT_TIMEOUT`, `502 MEAL_DRAFT_FAILED`
with `details.reason` (`provider_unavailable`, `provider_error`, `incomplete`, `invalid_output`, `oversized`,
`ungrounded_output`). Nothing is read from or written to `meals` (asserted on recorded statements).

## Decision 2: the model claims evidence; deterministic code decides

The model is asked for a wire shape (`meal_draft_evidence_v1`, one object per outcome, `outcome` first, as in ADR-0057's
Ollama schema): a title, a meal-type word, and per nutrient `{value, evidence, abstain}` where `value` is the number **as
written** (a string), `evidence` an excerpt it claims holds it, and `abstain` one of `not_stated`, `per_portion`,
`conflicting`, `negated`, `not_exact`, `unit_not_supported`. The grounding step (`meal-draft-grounding.ts`) then accepts
a nutrition value only if **all** of these hold:

1. The excerpt occurs in the text (exactly, or ignoring case; the answer shows the text's own spelling), at most 160
   code points.
2. The server's own tokenizer finds, inside the excerpt, a number **exactly** equal to the claimed value as decimal text
   (leading zeros and trailing fractional zeros normalised, no `Number` conversion: `12.50` is `12.5`, but `12.5` is not
   `12.5000000000000001` and `12.6` is not `12.55`), which is not a thousands-ambiguous form (`1,200`, `1.200`, `1 200`).
   Its **sign** is read from the original text, whatever the excerpt includes: a minus sign (ASCII `-`, Unicode `−`, the
   hyphen variants and fullwidth `－`) directly before the digits is negative (`outside_contract`); one separated from them
   by any whitespace (ordinary, no-break, narrow no-break…) is ambiguous (`ambiguous`); a minus between two numbers is a
   range. An en dash counts as a sign only directly before the digits; spaced, it and the em dash are separators.
3. The field's unit follows that number (`kcal`/`ккал`/`calories`…, or for energy only a unit word directly before it;
   `g`/`г`/`grams`…), not another unit (`kJ`, `mg`, `kg`, `oz`, `%`, `ml`…). Units are never guessed or converted.
4. For a macronutrient, its name is attached on either side with only separators between ("protein 40 g", "40 g of
   protein", "белок 35 г", "35 г белка"). A grams figure next to anything else is a **food quantity**, never a nutrient.
5. Its clause (up to `;`, `!`, `?`, a line break, or a `.`/`,` that is not a decimal separator) has no per-portion or
   multiplication marker, no bound or range (up to, at least, `500-600`, `500−600`, `~`, a question) and no negation
   (not, no, without, не, без…), and the **whole text** has no hedge (about, roughly, estimate(s), approximately,
   примерно, около, наверное…), since a hedge in another clause or sentence still makes the numbers estimates.
   **Ranges are also read in the original text around the number**, not only in its clause: another number directly
   before it or directly after it (and its unit), joined by any minus or dash (`-`, `‐`, `‑`, `‒`, `–`, `—`, `−`, `﹣`,
   `－`), "to", "or", "до" or "или" with only whitespace around it, line breaks included, makes it `ambiguous`
   ("Soup, 500 -\n600 kcal", "500 to\n600 kcal", "от 500 до\n600 ккал", "5 -\n6 g protein", and from the lower end
   "500 kcal to\n600"). Two numbers are not a range when other punctuation stands between them ("Rice 150 g.\n— 600
   kcal"), when the other number has a different kind of unit ("300 kcal –\n5 g protein", "200 ml – 120 kcal"), or when
   it states a different nutrient ("protein 30 g\n– 5 g fat").
6. Its **whole-entry scope** is established. Per-portion qualifiers (per, each, serving, portion, piece, `/100 g`,
   `in/for/на/в/за/для 100`, `для 30 г`, `по` before a number, `x2`, twice, каждый, порция, штука…) and nutrition-label
   headings (nutrition facts, nutritional value, label, пищевая/энергетическая ценность, этикетка, на упаковке) can stand
   before a list, after it, in a heading above lines, or in another sentence; commas, list formatting, line breaks and a
   short excerpt never prove that their scope ended. So: with no qualifier or label anywhere in the text, every value is
   whole-entry; otherwise the label or qualifier stays in force until the person resolves it for that value, which takes
   **all** of: (a) the value's sentence (split at `.`, `;`, `!`, `?`, not at commas, colons or line breaks) carries the
   person's own **summing phrase**: "in total", "altogether", "all together", "итого", "в сумме", "суммарно", "в общей
   сложности". A word a label prints, or one that also reads as an adjective in front of a nutrient, is **not** one,
   wherever it stands and for every nutrient: "total"/"totals" ("Total protein 4 g", "Fat 4 g total", "Total: fat 4 g"),
   "overall", "всего" (also "only") and "целиком" (describes the food, not a figure); (b) that sentence carries no
   qualifier or label itself and states **no amount of food** (a mass or volume that is not a macronutrient statement:
   in "I ate 200 g in total, protein 8 g" the phrase may sum the food and the 8 g may still be per 100 g); (c) every
   qualifier sentence in the text states values of its own (a value-less sentence such as "Values are per 100 g." may
   refer to any sentence, so no total escapes it). Otherwise `per_portion`. So in "Yogurt 200 g. Per 100 g: 60 kcal,
   protein 4 g. In total I ate 120 kcal, protein 8 g." 120 and 8 are proposed and 60 and 4 withheld. Nothing is
   multiplied or inferred.
7. The text states no other value for that nutrient **under the same scope rule** (two whole-entry values are
   `conflicting`; a per-portion value never conflicts with a total; a mention with an ambiguous sign or notation counts as
   a value of its own).
8. The meal contract accepts the **exact digits**: at most one meaningful decimal and within 0..20,000 kcal or 0..2,000 g,
   checked in integer tenths (`BigInt`) before any conversion; only then is the public number formed (and passed through
   ADR-0083's field schema once more). Refused, never rounded or clamped: `20000.05`, `2000.0000000000001` and
   `12.5000000000000001` are `outside_contract`.

A model abstention proposes nothing; its code only chooses the sentence the screen shows. A field whose claim is
inconsistent (a value without evidence, a value and an abstention) is `unverified`. The **title** must be an excerpt of the
text, a valid meal title, more than the meal's name, and carry no nutrition statement (a title is not evidence; "Protein
bar" is a title, "Shake 30 g protein" is not); otherwise the whole answer is `502 ungrounded_output`, because a draft
without a grounded title is not a draft of what the person wrote. A **meal type** is proposed only if its excerpt contains
that type's word (EN/RU, including the verbs позавтракал/пообедал/поужинал). If the text names two different meal types,
a `draft` answer becomes `clarify multiple_meals` whatever the model said.

There is deliberately **no** lookup, multiplication, calorie derivation from macronutrients, unit conversion or rounding
anywhere in this path, and the server never proposes a value the model did not claim. Missing stays `not_stated`
(empty, unknown); an explicit `0` stays `0`.

## Decision 3: local Ollama only, its own flag, bounded

`MEAL_DRAFTS_PROVIDER` = `off` (default) | `ollama` | `fake` (refused in production). Off means no provider object exists.
`ollama` reuses the weekly insight's `OllamaProvider` unchanged (one non-streaming chat request, the JSON Schema as
`format`, `temperature 0`, `think false`, `num_ctx 4096`, a bounded body, redirects refused, one attempt, never a retry)
with this feature's own settings: `MEAL_DRAFTS_MODEL` (required, a local model name; cloud names refused) and
`MEAL_DRAFTS_OLLAMA_BASE_URL` (the weekly insight's local-address rule: loopback, private network, single-label service).
No provider framework was added; admission is `InterpretationAdmission` (ADR-0057) unchanged.

| Bound | Default | Range |
|---|---|---|
| Text | 500 code points | contract |
| Output tokens (`num_predict`) | 600 | 64..2,000 |
| Response body | 32 KiB | 1 KiB..256 KiB |
| Deadline of the model call | 45 s | 1..55 s (`MEAL_DRAFT_DEADLINE_MAX_MS`) |
| Concurrent calls (process) | 1 | 1..8 |
| Per person | one in flight; 5 per minute | 1..60 |
| Allowance (process) | 200 per 24 h | |

The browser waits `MEAL_DRAFT_CLIENT_WAIT_MS` (55 s + 5 s) for this one request, a new optional `timeoutMs` of
`requestJson`; every other request keeps 15 s. The longer deadline is deliberate: ADR-0057's addendum measured 11..13 s
warm on this machine's CPU for a shorter answer, so the run-search 12 s cap would make this feature unusable locally.

**Lifetimes (ADR-0057 addendum, unchanged).** The request ends at the deadline or when the client leaves and is answered
then; the provider operation ends when its promise settles, and only then are the global place and the person's in-flight
reservation released (tested: after a 504 another person gets `MEAL_DRAFT_BUSY` and the same person
`MEAL_DRAFT_IN_PROGRESS` until the call settles; a late answer is dropped unread, not grounded, not revalidated).
**Access:** the membership is checked in its own short transaction before the call, and the session (ADR-0080) plus the
membership again after grounding; no database connection is held while the model works (a one-connection pool stays
usable during a call). A revocation or sign-out during the call returns `403`/`401` and no proposal.

**What the model receives:** fixed instructions (`meal-draft-prompt-1`) and the person's text, trimmed. No date, zone,
identity, organization, record, history or other health data. **What is kept:** nothing. Raw input, model output, prompts
and proposals are not persisted or logged; the log line `meal_draft.proposal` carries the bounded outcome, duration,
model name, request id and four field counts (proposed, not stated, abstained, withheld: integers 0..4, added to the
logger's allow-list); metrics `meal_draft_proposal_requests_total{outcome}`, `meal_draft_proposal_seconds{outcome}`
(buckets to 60 s) and `meal_draft_fields_total{disposition}`.

## Decision 4: the Meal log panel, and what "apply" means

A **Draft from text (optional)** panel above the form, following the existing availability convention (ADR-0057, ADR-0076):
it is shown, and the first `503 MEAL_DRAFT_DISABLED` turns it into a calm notice for the rest of the screen's life; the
manual form never depends on it. The disclosure states what is sent and that nothing is saved until "Add entry".

- **Propose draft** sends the text once (a double click sends one request; no automatic retry). While drafting:
  "Drafting… A local model can take up to a minute" and **Cancel**.
- The proposal is shown **before** anything changes: the title ("Copied from your text"), the meal type with its excerpt,
  each value with "From your text: “…”", and for each field not filled in, why (not in your text; per portion; …).
- **Apply to form** only fills the editable form: a full replacement of title and values (a field not proposed becomes
  empty = unknown), the meal type only if the text named one. A note says the details came from the text and are not
  saved. **Saving stays the form's own action** (Add entry), through the existing `POST /meals`.
- **No silent replacement:** if the form holds unsaved details (a title or any value), Apply asks "Replace them with this
  draft?" (**Replace form details** / **Keep my details**).
- **No late or misdirected proposal:** a proposal is bound to the exact text and the date it was asked for; changing the
  text or the date, starting an edit, cancelling, or applying invalidates it (a generation counter; the transport's abort
  is not trusted alone). The controller follows the session signal and the screen is keyed by session, person and
  organization, so nothing reaches another session or organization. An answer whose `localDate`/zone differs from the
  request is refused. Apply is disabled while an entry is being edited (a draft only fills a new entry), while a save is
  in flight, and after `MEAL_ALREADY_SAVED` until "Start a new entry".
- **Idempotency is unchanged:** applying changes the draft like typing does; the form session's key stays, so an
  uncertain earlier save followed by an applied draft is still caught as `MEAL_ALREADY_SAVED`, never a second entry.

## Decision 5: provenance of a confirmed draft

A confirmed draft is saved by the existing create endpoint, so it is `source: manual`, with ADR-0083's idempotency and
erasure (ledger, export, replay) unchanged. **`manual` means "entered or confirmed by the person through the meal form"**:
every value in the row was shown to the person, editable, and saved by their explicit action. It does not mean "typed key
by key", and the database does not record that a model suggested the values (there is no field for it, by design: the
proposal itself is not kept, and the person may have changed every value). A later decision may add an assisted
provenance; this one does not.

## Evaluation

Frozen synthetic sets, written before any model call and pinned by SHA-256 (of the parsed JSON, so line endings do not
matter): **development** (20 cases, 10 EN / 10 RU) and **held-out** (20 cases, 10 EN / 10 RU), covering grounded
extraction, title-only drafts, zeros, decimals (comma and point, a two-decimal refusal), food quantities, per 100 g /
per serving / each / по, conflicts, negation, approximations and ranges, thousands separators, kJ, multiple meals,
estimation requests, not-a-meal texts, numbers without food, and prompt injection. Reported separately: outcome, reason,
title and meal-type accuracy; extraction precision and recall over expected values; **incorrectly accepted fields**;
abstentions split into model, grounding and non-draft outcome; failures by reason; latency (mean, p50, p95, max).

**Fake-provider harness verification (not model evidence).** The deterministic fake copies every number next to a unit;
both sets ran end to end with 0 incorrectly accepted fields (6 wrong claims stopped by grounding in each set). This shows
that the harness, the grounding and the scoring work together; it says nothing about any model.

**Real model: run, historical** (report: [meal-draft-model-evaluation-2026-11-14.md](../reports/meal-draft-model-evaluation-2026-11-14.md)).
These results were measured with the grounding **before** the corrections below and are kept unchanged as history; they
do not validate the corrected rules, and no model was called after them.
Local `qwen3:8b` (Q4_K_M, CPU only, Ollama 0.40.16), prompt and rules frozen before the first call, 40 of the allowed 40
calls (20 development, 20 held-out), no retries, nothing pulled, 55 s deadline:

| | Development | Held-out |
|---|---|---|
| Outcome correct | 18/20 | 17/20 |
| Expected values found (recall) | 15/16 | 14/15 |
| **Incorrectly accepted fields** | **0** | **0** |
| Abstentions on expected values (model / grounding / non-draft outcome) | 0 / 0 / 1 | 0 / 0 / 1 |
| Wrong model claims withheld by grounding | 1 | 3 |
| Failures | 1 `ungrounded_output` | 1 `ungrounded_output` |
| Latency p50 / p95 / max | 15.4 / 26.8 / 48.7 s (cold first call) | 14.7 / 24.7 / 26.4 s |

In the held-out set the model claimed a value from an injected instruction, a per-piece value whose number was not in its
excerpt, and a two-decimal value; the grounding withheld all three. Both failures are Russian titles that were not
excerpts of the text. The outcome misses were safe (a title-only draft answered as `unsupported`, "roughly 1,800 kcal"
and a self-correction answered as `unsupported`). No quality target was set before the run, so this is a measurement,
not an acceptance: **the feature stays off by default.**

## Amendment: grounding corrections (2026-11-14)

Three defects were confirmed in the first version of the grounding, each a way for a schema-valid model claim to become a
proposed value the text does not support. Decision 2 above states the corrected rules; this section records what was
wrong. The endpoint, the response shape, apply/save, idempotency, access checks, cancellation, admission, privacy and the
off-by-default configuration are unchanged.

| Defect | Reproduction | Root cause | Correction |
|---|---|---|---|
| A per-portion qualifier lost its scope | "Yogurt. Nutrition per 100 g, 60 kcal, protein 4 g. I ate 200 g." with claims `60`/"60 kcal" or `4`/"protein 4 g": both proposed as whole-entry values | Qualifiers were only looked for in the value's comma-bounded clause, so a qualifier in a neighbouring clause, a heading above a list, after a list or in another sentence was invisible | A qualifier or nutrition label anywhere in the text requires an explicit total in a qualifier-free sentence (rule 6); conflicts use the same scope (rule 7); hedges are read across the whole text (rule 5) |
| Whitespace hid a minus sign | "Soup, - 500 kcal" with `500`/"500 kcal" (and "Soup, - 5 g of protein"): proposed as +500 | The sign check only looked at the single character before the digits | The sign is read from the original text across any whitespace, for ASCII, Unicode and fullwidth minus signs; spaced is ambiguous, adjacent is negative, between numbers is a range (rule 2) |
| Floating-point conversion hid precision | "Soup, protein 12.5000000000000001 g" with `12.5000000000000001` or `12.5`: proposed as 12.5 | Token and claim were converted with `Number` before comparison and before the precision check, and `Number('12.5000000000000001') === 12.5` | Exact decimal-text comparison, and precision and bounds in integer tenths (`BigInt`) before the number is formed (rules 2 and 8) |

Consequences of the stricter scope, all in the safe direction: a total in the same sentence as a qualifier is withheld
(write it in its own sentence: "Chicken (165 kcal per 100 g); I ate 330 kcal in total"); a value-less qualifier sentence
withholds every value; "1 serving of soup, 250 kcal" is withheld because "serving" is a qualifier; a hedge anywhere
withholds every value; an ASCII hyphen-minus separated from a number by a space ("protein - 40 g", a "- 500 kcal" bullet)
is withheld as ambiguous. `по` counts only before a number ("по 70 ккал", not "по-домашнему") and a slash only after a
letter ("kcal/100 g", not a date such as 14/11). The prompt was not changed: its first example ("…480 kcal, 22 g protein,
fat per 100 g 3 g") now yields withheld energy and protein under rule 6, which is safe but means the example teaches claims
the server refuses; revising it needs a new prompt version and a new evaluation.

Verification of the corrections (deterministic only, **no model call**): the new
`meal-draft-grounding-regressions.spec.ts` (35 tests: the three reproductions; EN/RU qualifiers before and after lists,
in headings, labels and later sentences across all four fields; explicit totals beside per-100 g values; label "Total
fat"; value-less qualifiers; conflicts on the same scope; negation, ranges and hedges in other clauses; spaced, Unicode,
no-break-spaced and fullwidth minus signs, signs left out of the excerpt; rounded claims, trailing zeros, exact bounds;
positive controls; a mixed draft that fits the public contract) failed 27 of 35 against the unchanged code and passed 35
of 35 after the correction; the existing grounding spec passes with one case changed on purpose (a total sharing its
sentence with a qualifier). Three HTTP integration cases with schema-valid unsafe claims from the injected provider
(`meal-drafts-http`, 16/16). `npm run verify` exit 0 (API 2,001); the database suites, run sequentially after checking
host, database (`running_tracker_test`) and role of each connection: 5 files, 133 passed; the four Chromium meal-draft
scenarios with the fake provider: 4/4 at the first run (one scenario's text now states its zero as a total in its own
sentence). The fake harness on the frozen sets is unchanged (0 incorrect; recall 15/16 and 15/15).

## Amendment 2: a label's "total" and ranges split by a line break (2026-11-14)

Two more defects of the same kind were confirmed after the first amendment: schema-valid claims that the corrected rules
still turned into proposed values. Rules 5 and 6 above state the corrected rules. Nothing else changed: endpoint, response
shape, apply/save, idempotency, access checks, cancellation, admission lifetimes, privacy, off by default, the prompt
(`meal-draft-prompt-1`), the frozen datasets and the historical evaluation artifacts.

| Defect | Reproduction | Root cause | Correction |
|---|---|---|---|
| A label's "total" escaped the per-portion scope | "Yogurt. Nutrition facts per 100 g: 60 kcal. Total protein 4 g." with `4`/"protein 4 g" (also "Fat 4 g total." and "Total: fat 4 g."): proposed as a whole-entry value | The whole-entry marker accepted the bare word "total" and excluded only "Total fat/carbohydrate/sugars" directly before the nutrient, so any other nutrient or word order passed as proof of what was eaten | Only the person's own summing phrase ("in total", "altogether", "итого", "в сумме"…) resolves a label or qualifier; "total", "overall", "всего" and "целиком" never do, for any nutrient or position; the summed sentence must also state no food amount (rule 6) |
| A line break hid a range | "Soup, 500 -\n600 kcal" and "Soup, 500 to\n600 kcal" with `600`/"600 kcal": proposed as 600 | The sign check saw the hyphen as a range separator and left the range to the clause check, whose clause ends at the line break, so the other endpoint was never seen | A range check on the original text around the number in both directions, across whitespace and line breaks, for every dash, "to", "or", "до", "или", for energy and macronutrients (rule 5) |

**Changed expectations, on purpose.** In the first amendment's regressions, "Soup. Per 100 g: 50 kcal. Total 300 kcal."
expected 300 proposed, and the same text with "Total 350 kcal." added expected `conflicting`. Next to "Per 100 g" a bare
"Total" is what a label prints (it may be the pack's total), so both are now `per_portion`; sibling cases with "In total"
and "Итого" keep proving conflict detection on the same scope. Other consequences, all in the safe direction: a total
written as "Total 650 kcal" after a qualifier or label is withheld (write "In total 650 kcal"); a summed sentence that
also gives the food's weight ("I ate 200 g in total, protein 8 g") is withheld; two numbers with the same kind of unit (or
none) on consecutive lines joined by a dash are read as a range ("Lunch 2\n– 600 kcal"). Texts without any qualifier or
label are unaffected by the scope change ("Dinner: chicken and rice, total 650 kcal" still proposes 650).

Verification of this correction (deterministic only, **no model call**): the new
`meal-draft-grounding-scope-and-range.spec.ts` (46 tests: both sets of reproductions with unsafe schema-valid claims;
label "total" lines for all four fields in every placement, EN and RU; label context across line breaks; a summed sentence
with a food amount; ranges across line breaks for every supported dash, "to", "or", "до", "или", "от … до", from either
endpoint, for energy and macronutrients; positive controls for consumed totals beside a label, plain whole-entry texts,
separate statements, different units and nutrients, zero, decimal comma, trailing zeros, signs, exact decimals and bounds;
a mixed draft that fits the public contract) failed 39 of 46 against the unchanged code (the 7 that passed were the
positive controls and two label lines the old exclusion happened to cover) and passed 46 of 46 after it. The first
amendment's regressions pass with the one intentionally changed case above. Two new HTTP integration cases with the
injected provider (`meal-drafts-http`, 18/18): label "total" lines withheld for all four fields, a consumed total proposed
beside a withheld per-100 g value, and line-broken ranges withheld beside a zero and a decimal-comma value that are
proposed. Before the database runs, each connection reported host `127.0.0.1:5433` (server `172.18.0.2:5432`),
`current_database()` = `running_tracker_test` and the expected `current_user` (`running_tracker_runtime`,
`running_tracker_owner`, `running_tracker_maintenance`); then `meal-drafts-http`, `meals-http`, `meals-access`,
`observability` and `tenant-isolation` ran sequentially: 5 files, 115 passed at the first run. `npm run verify` exit 0 at
the first run (API 2,047). The four Chromium meal-draft scenarios with the fake provider: 4/4 at the first run, no
scenario changed. The fake harness on the frozen sets is unchanged (0 incorrectly accepted; recall 15/16 and 15/15).

## Consequences

- One more AI feature, off by default and independent of the other two; the suite's API runs it with the fake provider,
  the review API with it off.
- `hasControlCharacter` moved to `primitives.ts` (the run-search contract imports it; behaviour unchanged).
- `requestJson` gains an optional `timeoutMs`; the default stays 15 s.
- The logger's allow-list gains four integer field counts and one boolean.

## Not established

- **Generalisation**: 40 synthetic cases by the author of the rules, one model, one CPU; no real user text. The model on
  its own made wrong claims that only the grounding stopped. The feature stays off by default and is not a product claim.
- The grounding vocabulary is English and Russian only; other languages get abstentions (not wrong values), and a text
  in another language with English units may still pass the rules.
- The rules are conservative heuristics, not a parser of natural language: they withhold some correct values (see the
  amendment's consequences) and they cannot detect every negation or reference. Negation is still read only in the
  value's own clause ("No sauce, 500 kcal" keeps 500, by design), so a negation in a neighbouring clause that does apply to
  the number is not seen; a value the person means for a different meal in one clause is not detected either.
- Found while making the second correction and **not** fixed by it (it was limited to ranges and label totals): a bound
  or negation word separated from its number by a line break is not seen, because those checks read only the value's
  clause ("Pasta, up to\n600 kcal", "at least\n600 kcal", "более\n600 ккал" and "Salad, not\n400 kcal" still propose the
  number), and a Russian "до" alone ("Суп, до 600 ккал", "up to") is read as a bound only between two numbers. Each
  is a false acceptance that needs its own correction.
- The summing-phrase rule is wording, not understanding: a summing phrase that refers to something other than the meal,
  a label printed with such a phrase, or a "total" the person did mean as what they ate is not told apart. The range
  check sees only two numbers joined across whitespace by a dash, "to", "or", "до" or "или"; range wording outside that
  vocabulary is not recognised, before or after this correction ("Pasta, between 500 and 600 kcal" and "Паста, от 500 и
  до 600 ккал" still propose 600). Two adjacent same-unit (or unit-less) numbers joined by a dash are always read as a
  range, even when the person meant two lines.
- The corrected rules (both amendments) have not been measured with a real model: the 40-call evaluation predates them (the deterministic
  fake harness on the frozen sets is unchanged by them: 0 incorrect, development recall 15/16, held-out 15/15).
- A person can of course write a wrong number; the feature extracts what they wrote, it does not check it.
- No real iPhone, Safari or WebKit run; Chromium only. Ollama behind a container network was not tried.
- Provenance does not distinguish a confirmed draft from typed entry (Decision 5).

# Weekly insights: local model, states and evaluation (ADR-0076)

Weekly insights are off by default. Everything else in the application works without them and without Ollama. The
**Weekly review** on the Check-in tab ([ADR-0077](../adr/0077-deterministic-weekly-review.md),
`GET /api/orgs/:orgId/weekly-review`) is computed by the app on every read, never calls a model and never depends on
this setting; the AI insight is an optional section below it.

## Enable with a local model

1. Run Ollama on this machine (`OLLAMA_NO_CLOUD=1 OLLAMA_HOST=127.0.0.1:11434 ollama serve`), or start the optional
   compose service and pull a model into it:

   ```sh
   docker compose -f infra/compose/docker-compose.yml --profile ollama up -d ollama
   docker compose -f infra/compose/docker-compose.yml exec ollama ollama pull qwen3:4b
   ```

   `npm run db:up` never starts it (the service is only in profile `ollama`).
2. Set in `.env`: `WEEKLY_INSIGHTS_PROVIDER=ollama`, `WEEKLY_INSIGHTS_MODEL=<installed local model>` and, for the compose
   service, `WEEKLY_INSIGHTS_OLLAMA_BASE_URL=http://127.0.0.1:11435`. Choose the timeout and total budget from the
   evaluation below; a CPU-only machine needs minutes, not seconds.

**Recommendation (measured 2026-11-07, prompt `weekly-insight-v4`):** leave it off for people's data. No installed model
met the product target ([report](../reports/weekly-insights-model-evaluation-2026-11-07.md)): qwen3:8b produced 8/10
ready answers on the validation weeks, but one accepted answer stated something false ("Sleep was logged on every
check-in day" for 3 of 4 days); qwen3:4b produced 1/10. For an opt-in experiment on this workstation use
`WEEKLY_INSIGHTS_MODEL=qwen3:8b`, `WEEKLY_INSIGHTS_TIMEOUT_MS=180000` and `WEEKLY_INSIGHTS_TOTAL_BUDGET_MS=400000`
(cold 118 s, warm median 78 s, warm p95 109 s, CPU only). The prose is labelled AI-generated and is not verified beyond
its numbers, days and change verbs; the cited facts next to it are the code's.

Changing the prompt version (it is `weekly-insight-v4` since 2026-11-07) withholds insights generated with the previous
version (`outdated_policy`); the person can regenerate them.

## Network boundary

The API refuses public hosts and cloud model names, and it never sends notes, coordinates, identifiers or the person's
identity. It does send the week's computed numbers and their labels. A loopback URL keeps them on this machine. A
private address or a compose service name sends them to whichever host answers there, in clear text over http. Treat
that host as part of the trust boundary of health data.

## States the panel shows

| State | Meaning | What the person can do |
| --- | --- | --- |
| no insight (404) | never asked, or deleted together with a changed or deleted source record | Generate |
| queued / running | a job holds a lease; the panel polls (bounded, about four minutes) | wait, or Check again |
| ready, current | passed schema, claim grounding and safety checks | nothing to regenerate |
| ready, stale | the week's data changed afterwards; shown, marked out of date | Regenerate |
| outdated policy | validated under older rules; output hidden | Regenerate |
| generation_failed | no valid answer within the budget | Regenerate (3 attempts per input) |
| failed_grounding / failed_safety | the answer was discarded by the checks | only after the data changes |
| interrupted | shutdown, a lost process (expired lease), or the result could not be stored | Regenerate (3 attempts per input) |

## Evaluate local models (opt-in, never in CI)

```sh
npm run eval:weekly-insights -- --models qwen3:4b,qwen3:8b
npm run eval:weekly-insights -- --models qwen3:8b --prompt weekly-insight-v4 --cases validation --max-calls 10
```

It runs ten synthetic weeks per model through the production generator and checks. It reports the schema pass rate,
global (prose) and scoped (claim) grounding failures and failures by kind, unit/direction failures, safety failures,
attempt counts, timeouts, and cold and warm latency (median and p95; small sample). Reports go to
`apps/api/.local/eval-reports/` (`--out` to change). A model that is not installed is reported as unavailable, never as
passed.

- `--prompt` picks a kept prompt version (`weekly-insight-v2`, `v3`, `v4`; default: the production one).
- `--cases development` (default) is the set prompts are tuned on; `--cases validation` is the frozen held-out set.
  Do not tune a prompt on validation results, and do not edit the validation weeks (their hash is pinned by test). It
  has been used once (2026-11-07); a further prompt experiment needs a fresh validation set.
- `--max-calls` is a hard limit on actual provider calls, retries included: a call beyond it is never sent, the case
  is reported as cut short, and cases that cannot start are reported as not run.
- To re-check stored answers after a rule change, without any model call:
  `node --import tsx src/evaluation/weekly-insight-revalidate-main.ts <report.json>` (from `apps/api`).
- Token use per request is in the Ollama server log (`%LOCALAPPDATA%\Ollama\server.log`, "task.n_tokens" and
  "stop processing: n_tokens"); the window is 4,096 tokens.

# Weekly insights: local model, states and evaluation (ADR-0076)

Weekly insights are off by default. Everything else in the application works without them and without Ollama.

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
```

It runs ten synthetic weeks per model through the production generator and checks. It reports the schema pass rate,
global (prose) and scoped (claim) grounding failures, unit/direction failures, safety failures, attempt counts, and
cold and warm latency (median and p95; small sample). Reports go to `apps/api/.local/eval-reports/`. A model that is not
installed is reported as unavailable, never as passed.

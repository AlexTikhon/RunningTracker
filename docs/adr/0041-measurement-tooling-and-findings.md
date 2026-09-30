# ADR-0041: Measurement tooling, and what the first complete measurements show

- Status: accepted; P11.4 implemented and locally verified
- Date: 2026-09-30
- Scope: P11.4 only. It collects and reports. No product SQL, index, policy, limit, or interval was changed to make a
  number better; every optimization is P11.5 and must be re-measured with the same tools.

## Context

P11.3 produced raw workload samples but no plans, sizes, or response bytes, and its two runs per profile were not a
statistical basis. It also left one hypothesis (tile transactions delay organization-level writers) and several
unexplained observations. The plan asks for `EXPLAIN (ANALYZE, BUFFERS)`, real table and index sizes, response bytes,
and memory, and the SDD says a graph without a method confirms nothing.

## Decision

1. **Measure the production SQL, not a copy.** The hot statements were moved, unchanged, into exported constants
   (`renderArchiveTileSql`, `liveStateSql`, `listRunsSql`, `rawPointsPageSql`, `liveTrackSnapshotSql`,
   `liveTrackChangesSql`, `insertPointsSql`, `publishCandidateSql`); the services now use the constants, and the
   whole unit and integration suites pass unchanged. The catalogue (`explain-statements.ts`) is a pure function of the
   dataset plan, and its tests assert identity with the constants.
2. **Under the real role, always rolled back.** Runtime statements run as `running_tracker_runtime` with the tenant
   GUCs a request would set, maintenance statements as `running_tracker_maintenance`, in `BEGIN READ ONLY` or a normal
   transaction that ends in `ROLLBACK`. `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)` executes the statement, so the
   insert and the summary publication are real executions that are then rolled back; tests prove no row, revision, or
   summary changed. Each executed identity is recorded (`current_user`) and asserted.
3. **A reversible fixture for the two statements that need recording runs.** The seeded dataset has none. Each
   member's newest run is set to `recording` in one committed owner transaction and restored from the saved
   `finished_at` text in a `finally` path. A refusal happens first if those runs are not all `finished`; a failed
   restore is reported, and the dataset is verified again after collection. Tests cover a failing statement, a
   cancellation between statements, and an insert failure, and require the exact dataset afterwards.
4. **Plans are summarized, raw plans are opt-in.** `summarizePlan` keeps time, buffers, WAL, trigger time, sequential
   and index scans (with rows and loops), the five heaviest nodes by time exclusive of children, sort space, and JIT.
   A failing statement is recorded by SQLSTATE and error class only, since a database message can quote values.
   `--keep-plans` writes raw first plans to a separate file outside the sanitized result.
5. **Response bytes and service time are separate from SQL time.** For first pages and tiles the real service function
   runs in a tenant transaction and reports serialized bytes, the call time, and JSON serialization time; deep pages
   share the shape and are not repeated.
6. **RLS cost is isolated with a paired baseline.** Three count scans (`run_summaries`, `runs`, one run's
   `run_points`) run once as the table owner, which is not subject to row-level security, and once as a coach.
7. **Lock waits are observed with what a plain role can read.** Another role's `state` and `wait_event` are NULL to
   the owner, but `pg_locks` and the application name are not: a request with `granted = false` is a waiting backend.
   The runner samples those counts per application and lock type every 250 ms on the scenario clock (no statement
   text). A failing sampler ends sampling with a warning and never fails the run; a real lock wait is asserted in an
   integration test, and the filter was mutation-checked.
8. **A baseline without tile load.** `--no-tiles` sets zero tile-burst streams and nothing else, so ingestion can be
   compared like for like.
9. **The report is generated and rule-based.** `load:report` pools raw samples across runs of a group (profile, tile
   variant, seed, dataset instant) with nearest-rank percentiles, shows per-run spread, and evaluates each SDD target
   by a stated rule. A target the workload cannot decide stays `not confirmed`; nothing is `met` by default.

## Findings (all from 3 runs per group, one machine, ordinary and stress datasets; the report has every figure)

- **Targets met under the stated rules:** ingestion p95 (ordinary 89 ms, stress 218 ms, client-side over loopback),
  fresh point → observer p95 (about 2.0 s in both, bounded by the 2 s live poll), and no ingestion starvation from two
  overlapping tile streams (stress 218 ms with tiles, 158 ms without).
- **Not confirmed:** summary visibility (60.3–63.0 s from the finish command, which includes the 60 s worker cadence;
  publication cannot be timed from the client), LRU footprint (the cache peaked at 3.5 MiB of 32 MiB, so eviction
  never ran), SSE pending-buffer size (not exported; no stream dropped in any run).
- **Row-level security dominates every hot read.** The same scan costs 0.3–1.8 ms as the table owner and 83–185 ms
  under RLS on the ordinary set, and 4 ms versus 2,024 ms for one 42,857-point run: about 45–50 µs and 8 buffer hits
  per checked row, essentially all of the cost. The archive tile query performs three sequential scans of
  `run_summaries` (the GiST index is not used) and one index lookup per summary in `runs`, all paying that predicate:
  about 360–510 ms and 66,000 buffers per tile whatever its content, about twice that for the antimeridian route. The run
  list behaves the same (404 ms ordinary, 577 ms stress).
- **Reconnect reads are proportional to the run, not to the change.** At 42,857 points a live-track snapshot page
  takes about 2.4–2.6 s and one changes page for a 96-byte answer about 2.5 s (343,000 buffers), because the plan reads
  every point of the run before it limits the page; a full snapshot is about 43 such pages. Raw history, which does not
  evaluate edges, takes 57 ms for the same run.
- **Summary recalculation is not the slow part of the worker.** Calculating, simplifying, and publishing the largest
  run takes 0.45 s (ordinary) to 0.84 s (stress) at the median. P11.3's 50.8 s stress cycle and 111 s visibility did not
  reproduce in six later stress runs (60.3–61.5 s); the first ran right after a 3 M-row seed, and the cause was not
  established.
- **Writes are cheap in SQL.** A 100-point insert takes 5–14 ms and writes about 66–70 KB of WAL (a few full-page
  images), with 0.5 ms of foreign-key trigger time. The revision index is larger than the primary key
  (359 MB against 307 MB at 3 M points; 1.09 GB for the table with indexes, 0.36 KB per point in total).
- **The P11.3 lock hypothesis, answered for this workload.** With two tile streams the maintenance backend waited for a
  lock in 8–14 samples (about 2–3.5 s in total per group) and no API backend waited; without tiles almost nothing
  waited (0–1 samples). Tile transactions therefore delay summary publication by seconds, not by tens of seconds, and
  do not block ingestion here. Sampling is every 250 ms.
- Memory stayed at about 86–113 MiB resident and the pool wait p95 upper bound at 5 ms in every run; the tile queue was
  observed at 4 at most (15 s snapshots, and no tile was ever shed).

## Consequences and limits

- These are candidates for P11.5, not decisions: (a) the RLS predicates on `run_summaries`, `runs`, and `run_points`
  (any change must pass the whole D02 access matrix); (b) limiting the snapshot and changes window work to the page
  and its predecessor; (c) a tile query shape that lets the spatial index run; (d) the size of the revision index.
  Each needs a before/after with `load:explain`.
- One machine hosts the runner, the API, and PostgreSQL (Docker Desktop with a 7.4 GiB VM and no container limit);
  percentiles pooled over three runs are still one sample of that machine. Histogram percentiles are bucket upper
  bounds. EXPLAIN "first execution" is not a cold-cache figure. Statements inside PL/pgSQL functions appear as one
  node. No browser was driven, so frame time and the web app's polling are unmeasured.
- Data age, summary lag, dead tuples, and backup age are captured in the result (dead tuples) or remain unexported as
  metrics; adding database-reading collectors to the scrape endpoint would make a scrape run queries and is left as a
  deliberate later decision.

# ADR-0042: Set-based run visibility for row-level security reads

- Status: accepted; P11.5 implemented and locally verified
- Date: 2026-09-30
- Scope: P11.5 only. It applies the one optimization P11.4 confirmed (the per-row policy predicate) and measures it with
  the same tools. The other P11.4 candidates were evaluated against the new numbers and are recorded below as not
  applied.

## Context

P11.4 showed that essentially all of the database time of the hot reads was the row-level-security predicate, not the
work the statements do. The SELECT policies on `run_points`, `run_summaries` and, for rows the caller does not own,
`runs` called a `SECURITY DEFINER` function once per candidate row (`can_read_run`, `can_read_run_history`). Each call
re-checked the membership and looked the run and its share up again: about 8 buffer hits and 45–50 µs per row. The same
count scan cost 0.3–1.8 ms as the table owner and 83–185 ms under RLS on the ordinary set, and 4 ms against 2,024 ms for
one 42,857-point run. Archive tiles (three scans of `run_summaries`, about 360 ms), the run list (about 400 ms), raw
history, and the snapshot and changes pages (about 2.4 s at 42,857 points) all paid it.

The visible set is a function of the identity and the tenant, not of the row, so it can be computed once per statement.

## Decision

1. **Two set functions**, `app_private.readable_run_keys()` and `app_private.history_readable_run_keys()`, return the
   `(org_id, run_id)` pairs for which `can_read_run` and `can_read_run_history` are true. They are `SECURITY DEFINER`,
   `STABLE`, `search_path = pg_catalog`, executable by the runtime role only, and return no row without an active
   membership in the current tenant, with a missing or malformed context, or for another tenant's runs. Each is one
   statement: the caller's own runs plus a join of `runs` to `run_shares` on the caller's grants.
2. **The SELECT policies use the set** as an uncorrelated `(org_id, run_id) IN (SELECT ... FROM set_function())`, which
   PostgreSQL evaluates once per statement into a hash table; every row then costs one probe. The row estimate is
   declared (`ROWS 4000`, the SDD's 10 members × 365 days) so the planner hashes it. The `runs` policy keeps its owner
   branch first and as a plain column comparison, so a runner reading their own run never builds the set.
3. **The per-row functions stay** as the specification and for the explicit `can_read_run(...)` checks in the
   statements. A new integration test compares each set with them for every fixture identity and both tenants,
   including an identity with no membership, an inactive membership, and a user who does not exist.
4. **A narrowing scope for selective reads.** The set costs the same whether a statement touches three rows or three
   million, so the live-state poll (every two seconds, per subscription, about ten rows) got slower when only the
   set was applied (2 ms to 24 ms, measured). A transaction may declare `app.visibility_scope = 'live'`, which makes
   `readable_run_keys()` return only the readable runs that are recording or paused. The setting can only remove rows
   from the answer and can never add one, so a wrong, stale, or hostile value fails closed; any value other than the
   exact string `live` leaves the full set. It is chosen by one-time filters, so the planner does not execute the
   switched-off branches. `withTenantTransaction` takes it as `visibilityScope` and sets it in the same statement as
   the identity (no extra round trip); only the live hub uses it, and the EXPLAIN catalogue declares it for the
   live-state statement so the measured statement is the production one. `history_readable_run_keys()` has no scope.

## Security analysis

- Access is unchanged: the sets equal the per-row functions by test, no table privilege or grant changed, and no other
  policy (insert, update, delete, run_points insert, run_commands, run_tombstones) was touched. The complete existing
  access matrix (owner, grantee, live-only, history-only, no grant, inactive membership, cross-tenant, every status)
  passes unchanged under the runtime role.
- The functions read `runs` and `run_shares` as the table owner (definer), exactly as the per-row functions did, so
  the policies cannot recurse and a direct read of points or summaries cannot bypass the ACL.
- The scope is a narrowing hint, not an authorization input. Nothing reads it to grant anything.
- The set is built with the statement's snapshot, like the per-row calls were.

## Limits

- The hash table holds one entry per readable run (two UUIDs). The memory was not measured; at the SDD volume (3,650
  summaries per organization) it is small next to the 32 MiB tile cache, but a hashed sub-plan does not spill, so an
  organization with orders of magnitude more runs would need the set bounded or a different shape.
- A statement that reads a few rows of another member's run pays one set build (about 8–12 ms for a coach who can
  read all 3,650 runs) instead of a few point lookups. The owner path and the live poll do not.
- Every statement builds a set per table it reads through a policy: an archive tile builds two, a snapshot page two.
  Combining them would need a session-level cache, which was rejected as unsafe for a security predicate.

## Alternatives rejected

- **Cheaper per-row functions** (inlinable `current_*` helpers, hoisting the membership check into an InitPlan): the
  inlinable variants were measured slower than the current PL/pgSQL helpers (about 215–270 ms against 160–175 ms for
  the `run_summaries` count scan), and any per-row function still pays an executor start and two index probes for
  every point of a run. A cheaper per-row function was not built and measured, so its gain is unknown; the set removes
  the per-row term altogether.
- **An inlinable view with a correlated `EXISTS`**: PostgreSQL converts it to the same hashed sub-plan, and it was
  measured slower.
- **A per-transaction or per-connection cache of the last decision:** it would need a volatile function or session
  state inside a security predicate, and a stale entry would authorize a revoked read.
- **Reading points through a definer function that bypasses RLS:** it moves the authorization into new SQL that must
  duplicate the ACL; the policy approach keeps one definition.

## Measured effect (before: `docs/reports/p11-measurements.md`; after: `docs/reports/p11-5-measurements-after.md`)

Same commands, dataset (seed 42, instant 2026-09-30T00:00:00Z), machine, and repetitions as P11.4 (EXPLAIN: 5 repetitions
ordinary, 3 stress; load: 3 runs per profile with and without tile bursts). Median database execution time in ms and
shared buffer hits per statement under the real roles:

| Statement | ordinary before → after | stress before → after | buffers (stress) before → after |
| --- | --- | --- | --- |
| archive tile, Lisbon z11 | 360 → 56 | 365 → 42 | 66,010 → 15,423 |
| archive tile, antimeridian route z11 | 735 → 97 | 723 → 88 | 132,046 → 30,872 |
| count of `run_summaries` as a coach | 176 → 9 | 185 → 11 | 28,381 → 7,801 |
| count of `runs` as a coach | 169 → 23 | 173 → 23 | 26,710 → 7,589 |
| count of one run's `run_points` as a coach | 83 → 9 | 2,024 → 16 | 343,177 → 7,471 |
| run list (coach page) | 358 → 37 | 355 → 36 | 55,097 → 15,393 |
| raw history first page | 49 → 18 | 48 → 18 | 8,045 → 14,344 |
| live-track snapshot first page | 58 → 24 | 2,058 → 39 | 343,476 → 14,927 |
| live-track snapshot deep page | 90 → 21 | 2,045 → 59 | 343,936 → 15,379 |
| live-track changes, one batch | 87 → 18 | 2,102 → 78 | 343,936 → 15,379 |
| live-state poll, ten active runs | 2.0 → 2.3 | 2.1 → 2.5 | 298 → 200 |
| 100-point insert | 4.2 → 4.5 | 4.2 → 4.9 | 1,326 → 1,321 |
| summary publication, largest run | 388 → 373 | 762 → 726 | 2,681 → 2,695 |

Response bytes are identical for every statement except the antimeridian tiles (below). The live-state poll would have
been 24 ms without the scope. Raw history reads more buffers than before because a first page of 1,000 rows paid
about 8 buffers per row and now pays two set builds (about 7,000 buffers) once, and it is still faster.

Load scenario (pooled over 3 runs; the tile bursts are closed-loop, so faster tiles let the two streams send about five
times as many requests in the same time: 17,630 and 17,560 tile requests against 3,942 and 3,352 before):

- ingestion request p95: ordinary 89 → 95 ms, stress 218 → 105 ms; with tiles versus without: 95 against 103 ms
  (ordinary) and 105 against 91 ms (stress);
- fresh point → observer p95: 1,991 → 1,993 ms and 2,072 → 2,009 ms (bounded by the 2 s live poll);
- client-measured tile p95 under the bursts, ordinary: z9 1,250 → 182 ms, z11 1,194 → 156 ms, z13 711 → 131 ms;
  stress: z9 1,296 → 195 ms, z11 1,078 → 158 ms, z13 894 → 136 ms;
- summary visible after the finish command: 60.4–61.0 s in all 12 runs (was 60.3–63.0 s): still the 60 s worker
  cadence, so that SDD target stays not confirmed;
- maintenance backend lock waits with tiles: 4 and 4 samples of about 720 (was 14 and 8); one no-tile stress run showed
  API-side waits (2 samples, peak 9) that the earlier runs did not, which was not investigated;
- peak resident memory with tiles rose from 109–113 MiB to 207–217 MiB and the tile cache peak from 1.7–3.5 MiB to
  6.8–10.7 MiB, because the same wall time now serves five times the tiles. Nothing was shed, no error line was logged,
  and no run failed.

## Not applied, and why

- **Page-limited snapshot and changes reads.** At 42,857 points a page took about 2.1 s because the per-row predicate
  ran on every point of the run. With the set it takes 39–78 ms and 15,000 buffers, most of them the two set builds. The
  measurements no longer show the whole-run read as a problem; it was not changed.
- **A tile query that can use the GiST index.** The tile now costs 42–56 ms, of which two set builds (about 8 ms each)
  and the three scans of 3,650 summaries are most of it. The index does not pay off at the SDD volume; not changed.
- **The revision index (359 MB against a 307 MB primary key at 3 million points).** No statement measured a cost
  from its size, and it serves the changes window; not changed.

## Observations that need no fix

- **Antimeridian tile bytes changed by up to about 15 bytes** (for example 80,240 → 80,251 at z9). The same tile was
  rendered inside one rolled-back transaction under the old and the new policies and decoded: the 365 features have the
  same properties, the same order, and the same set of geometry parts each, but 190 of them list the parts of their
  multi-part geometry in a different order. The SQL never specified that order, and MVT gives it no meaning. Every
  other tile is byte-identical.

## Limits of this evidence

- One machine hosts the runner, the API, and PostgreSQL; three runs per group; EXPLAIN times are database execution
  only. The improvement is measured on the SDD-sized organization (3,650 runs, one coach who can read all of them, which
  is the largest set). A member who can read fewer runs builds a smaller set.
- The equivalence of the policies is proved for the fixture identities and tenants and the twelve-case status and grant
  matrix, not for every possible database state.

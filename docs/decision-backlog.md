# Required implementation decisions

This backlog preserves the mandatory clarifications from the implementation plan. P00 records ownership; each owner stage must resolve the item with executable evidence or an ADR.

| ID | Owner | Required outcome | Status |
|---|---|---|---|
| D01 | P02B/P04 | Strict six-field `PointInput`; seq normalized to bigint decimal, `-0` to `0`, UTC timestamps to nearest millisecond, canonical field equality for retries; verified through contracts and real PostgreSQL ingestion | RESOLVED — P04.1 |
| D02 | P02A/P02B | Complete identity/run/share/child direct/JOIN ACL matrix, including commands/tombstones, verified under the real runtime role; guarantee assumes trusted transaction-local tenant/user context and does not prove the P03 HTTP session boundary | RESOLVED |
| D03a | P03 | Explicit session endpoint, safe local identity allowlist, CSRF/Origin boundary, request identity, and production startup guard | RESOLVED — ADR-0007 |
| D03b | P12 | Production identity/session provider integration with no local or anonymous fallback | TODO |
| D04 | P05 | Concrete single-writer lease/ownership mechanism across tabs, devices, and reloads | RESOLVED — ADR-0010: fenced same-origin tab lease; cross-device conflicts use server invariants because offline global exclusivity is impossible |
| D05 | P05 | Terminal reconciliation for queued offline commands after server auto-finish | RESOLVED — ADR-0009: authoritative run read and atomic stale-command acknowledgement |
| D06 | P07 | Fixed-T pagination and proof that snapshot plus changes equals a fresh snapshot | RESOLVED — P07.1–P07.5 + ADR-0017–0021 |
| D07 | P08/P09 | Defined authorization check point for stream/cache revocation and cancellation of unsent data | PARTIAL — P08.2/ADR-0023 resolves stream revalidation and pending cancellation; P09 still owns cache invalidation |
| D08 | P10 | Time-bounded replay guarantee after tombstone expiry, or another explicit mechanism | RESOLVED — P10.4 + ADR-0036: one-year guaranteed window; the tombstone row is authoritative until maintenance reclaims it; ID reuse only after reclamation; retries after the window are outside the guarantee |
| D09 | P10/P12 | Deletion/ACL journal surviving node loss, with stated RPO and restore drill | PARTIAL — P10.5 + ADR-0037: deletion journal exported off-host, export order, owner-only reapplication command, and runbook are done and tested; the restore drill and access-restriction recovery remain P12.3/P12.4 |
| D10 | P06/P11 | Global GPS/simplification fixtures, measured error, and documented accuracy limits | TODO |

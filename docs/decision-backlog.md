# Required implementation decisions

This backlog preserves the mandatory clarifications from the implementation plan. P00 records ownership; each owner stage must resolve the item with executable evidence or an ADR.

| ID | Owner | Required outcome | Status |
|---|---|---|---|
| D01 | P02B/P04 | Strict six-field `PointInput`; seq normalized to bigint decimal, `-0` to `0`, UTC timestamps to nearest millisecond, canonical field equality for retries; verified through contracts and real PostgreSQL ingestion | RESOLVED — P04.1 |
| D02 | P02A/P02B | Complete identity/run/share/child direct/JOIN ACL matrix, including commands/tombstones, verified under the real runtime role; guarantee assumes trusted transaction-local tenant/user context and does not prove the P03 HTTP session boundary | RESOLVED |
| D03a | P03 | Explicit session endpoint, safe local identity allowlist, CSRF/Origin boundary, request identity, and production startup guard | RESOLVED — ADR-0007 |
| D03b | P12 | Production identity/session provider integration with no local or anonymous fallback | TODO |
| D04 | P05 | Concrete single-writer lease/ownership mechanism across tabs, devices, and reloads | RESOLVED — ADR-0010: fenced same-origin tab lease; cross-device conflicts use server invariants because offline global exclusivity is impossible |
| D05 | P05 | Terminal reconciliation for queued offline commands after server auto-finish | TODO |
| D06 | P07 | Fixed-T pagination and proof that snapshot plus changes equals a fresh snapshot | TODO |
| D07 | P08/P09 | Defined authorization check point for stream/cache revocation and cancellation of unsent data | TODO |
| D08 | P10 | Time-bounded replay guarantee after tombstone expiry, or another explicit mechanism | TODO |
| D09 | P10/P12 | Deletion/ACL journal surviving node loss, with stated RPO and restore drill | TODO |
| D10 | P06/P11 | Global GPS/simplification fixtures, measured error, and documented accuracy limits | TODO |

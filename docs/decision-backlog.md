# Required implementation decisions

This backlog preserves the mandatory clarifications from the implementation plan. P00 records ownership; each owner stage must resolve the item with executable evidence or an ADR.

| ID | Owner | Required outcome | Status |
|---|---|---|---|
| D01 | P02B/P04 | Storage is fixed as bigint seq/revision, integer segment, `timestamptz(3)`, PostGIS double-precision coordinates, and finite double-precision accuracy; input canonicalization for numbers, `-0`, timestamp spelling, and retries remains | TODO |
| D02 | P02A/P02B | P02A baseline is verified; non-recursive runs/shares plus points/summaries direct-read ACL are implemented but unverified; commands/tombstones and final executable matrix remain | PARTIAL |
| D03 | P03/P12 | Explicit session endpoint, safe local identity boundary, and production startup guard | TODO |
| D04 | P05 | Concrete single-writer lease/ownership mechanism across tabs, devices, and reloads | TODO |
| D05 | P05 | Terminal reconciliation for queued offline commands after server auto-finish | TODO |
| D06 | P07 | Fixed-T pagination and proof that snapshot plus changes equals a fresh snapshot | TODO |
| D07 | P08/P09 | Defined authorization check point for stream/cache revocation and cancellation of unsent data | TODO |
| D08 | P10 | Time-bounded replay guarantee after tombstone expiry, or another explicit mechanism | TODO |
| D09 | P10/P12 | Deletion/ACL journal surviving node loss, with stated RPO and restore drill | TODO |
| D10 | P06/P11 | Global GPS/simplification fixtures, measured error, and documented accuracy limits | TODO |

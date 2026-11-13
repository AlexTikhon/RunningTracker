-- TCX import into owner-only activities (ADR-0091). Additive for existing rows: every row is 'manual' or 'gpx' and
-- satisfies the new checks; no row, policy, grant or trigger changes.
--
-- 1. `source` gains 'tcx'. The value is the server's: only the TCX confirmation route writes it (a literal in its SQL); the
--    manual route still writes 'manual' and the GPX route 'gpx'.
-- 2. A tcx row carries an import fingerprint like a gpx row: SHA-256 over the domain line 'somalane-tcx-activity-v1' and
--    each lap's start, reported total time and distance as canonical decimals. Its duration_s is the reported duration
--    (the sum of the laps' TotalTimeSeconds, rounded once), never elapsed or moving time.
-- 3. Duplicate detection is per owner, organization AND source: the unique constraint now includes `source`, so a TCX
--    import is never deduplicated against a GPX import (the digests are domain-separated as well), a manual entry or a
--    recorded run. GPX rows all have source 'gpx', so their uniqueness is exactly what it was. The new constraint is added
--    before the old one is dropped, so no moment of this migration is without duplicate protection.
-- 4. A tcx row always has its import attempt's idempotency key, a distance, and no effort or notes (summary only).
--
-- Row-level security, the runtime role's table-level SELECT/INSERT/DELETE grants, the erasure-ledger trigger and the
-- weekly insight source triggers apply to tcx rows exactly as to the others.

ALTER TABLE activities DROP CONSTRAINT activities_source_known;
ALTER TABLE activities
  ADD CONSTRAINT activities_source_known CHECK (source IN ('manual', 'gpx', 'tcx'));

ALTER TABLE activities DROP CONSTRAINT activities_import_fingerprint_matches_source;
ALTER TABLE activities
  ADD CONSTRAINT activities_import_fingerprint_matches_source CHECK (
    (source IN ('gpx', 'tcx')) = (import_fingerprint IS NOT NULL)
  ),
  ADD CONSTRAINT activities_tcx_idempotency_key_present CHECK (
    source <> 'tcx' OR idempotency_key IS NOT NULL
  ),
  ADD CONSTRAINT activities_tcx_summary_only CHECK (
    source <> 'tcx' OR (distance_m IS NOT NULL AND rpe IS NULL AND notes IS NULL)
  ),
  ADD CONSTRAINT activities_owner_source_import_fingerprint_unique UNIQUE (org_id, user_id, source, import_fingerprint);

ALTER TABLE activities DROP CONSTRAINT activities_owner_import_fingerprint_unique;

COMMENT ON COLUMN activities.source IS
  'Server-owned provenance: manual (entered in the form, ADR-0072), gpx (imported from a GPX file, ADR-0086) or tcx (imported from a TCX file, ADR-0091). A gpx row''s duration_s is the elapsed time from the first to the last point, pauses included; a tcx row''s duration_s is the reported duration, the sum of its laps'' TotalTimeSeconds rounded once, neither elapsed nor moving time. Imported distances were computed by the server.';
COMMENT ON COLUMN activities.import_fingerprint IS
  'SHA-256 of the canonical imported activity, present exactly on gpx (ADR-0086, the track) and tcx (ADR-0091, the laps) rows; domain-separated per format and unique per owner, organization and source. Deleted with the row; never copied to the erasure ledger.';
COMMENT ON TABLE activities IS
  'Owner-only activities (ADR-0072): manual entries, GPX imports (ADR-0086) and TCX imports (ADR-0091), imports summary only: no point, lap, route or file is stored. No coach or grantee access, no UPDATE; deletions are recorded in the erasure ledger (ADR-0073). type = run overlaps with the runs table; there is no dual-write, link or deduplication between them or between sources.';

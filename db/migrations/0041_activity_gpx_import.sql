-- GPX import into owner-only activities (ADR-0086). Additive: no existing row, policy, grant or trigger changes.
--
-- 1. `source` gains 'gpx'. The value is the server's: the manual create route always writes 'manual' (the request
--    contract has no source field), and only the GPX confirmation route writes 'gpx'.
-- 2. `import_fingerprint`: the SHA-256 of the canonical imported track (segments, and each point's latitude, longitude
--    and time as parsed), 32 bytes, present exactly on 'gpx' rows. It is not reversible into a route and is not content
--    the person typed; it exists only to recognise the same track again and is deleted with the row. The erasure ledger
--    does not copy it (the ledger keeps identifiers and timestamps only, ADR-0073).
-- 3. Duplicate detection is per owner and organization: UNIQUE (org_id, user_id, import_fingerprint). NULLs are
--    distinct, so manual rows never collide. Another person importing the same file gets their own activity, and a
--    collision reveals nothing about anyone else's rows. Deleting an imported activity frees its fingerprint, so the same
--    file can be imported again afterwards, like a deleted activity frees its idempotency key (ADR-0073).
-- 4. An imported row always carries the idempotency key of its import attempt (the confirmation contract requires it).
--
-- Row-level security, the runtime role's table-level SELECT/INSERT/DELETE grants (which cover the new column), the
-- erasure-ledger trigger and the weekly insight source triggers apply to imported rows exactly as to manual ones.

ALTER TABLE activities DROP CONSTRAINT activities_source_known;
ALTER TABLE activities
  ADD CONSTRAINT activities_source_known CHECK (source IN ('manual', 'gpx'));

ALTER TABLE activities ADD COLUMN import_fingerprint bytea;

ALTER TABLE activities
  ADD CONSTRAINT activities_import_fingerprint_length CHECK (
    import_fingerprint IS NULL OR octet_length(import_fingerprint) = 32
  ),
  ADD CONSTRAINT activities_import_fingerprint_matches_source CHECK (
    (source = 'gpx') = (import_fingerprint IS NOT NULL)
  ),
  ADD CONSTRAINT activities_gpx_idempotency_key_present CHECK (
    source <> 'gpx' OR idempotency_key IS NOT NULL
  ),
  ADD CONSTRAINT activities_owner_import_fingerprint_unique UNIQUE (org_id, user_id, import_fingerprint);

COMMENT ON COLUMN activities.source IS
  'Server-owned provenance: manual (entered in the form, ADR-0072) or gpx (imported from a GPX file, ADR-0086). A gpx row''s duration_s is the elapsed time from the first to the last point, pauses included, and its distance_m was computed by the server.';
COMMENT ON COLUMN activities.import_fingerprint IS
  'SHA-256 of the canonical imported GPX track (ADR-0086), present exactly on gpx rows; unique per owner and organization. Deleted with the row; never copied to the erasure ledger.';
COMMENT ON TABLE activities IS
  'Owner-only activities (ADR-0072): manual entries and GPX imports (ADR-0086, summary only: no point or route is stored). No coach or grantee access, no UPDATE; deletions are recorded in the erasure ledger (ADR-0073). type = run overlaps with the runs table; there is no dual-write, link or deduplication between them.';

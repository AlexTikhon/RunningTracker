# ADR-0030: Atomic archive cache invalidation boundary

- Status: accepted; P09.4 implemented and locally verified
- Date: 2026-09-28
- Scope: P09.4 only

## Context

P09.3 validates active membership and the requested organization archive
revision before entering the process cache. Those reads alone do not serialize a
cache hit with a concurrent authorization change: a revocation could commit
after validation but before cached bytes are returned. TTL cannot close that
race, and independent API processes cannot coordinate by deleting local keys.

## Decision

1. A tile transaction calls an owner-defined capability that locks the
   organization row `FOR SHARE`, then rechecks active membership and returns the
   locked archive revision. Cache lookup occurs only after this capability
   succeeds and the requested revision matches. The shared lock is held through
   cache lookup and until the tenant transaction commits.
2. Summary publication retains its existing organization-first lock and atomic
   epoch increment. Migration `0013_archive_cache_invalidation.sql` adds
   transaction-local epoch triggers for published-summary deletion, effective
   history-grant changes, and active-membership revocation/restoration/deletion.
   A history-share change advances the epoch only when that run already has a
   published summary; later publication otherwise supplies the required epoch
   change.
3. Runtime history-share mutations take the organization row `FOR UPDATE`
   before inspecting or locking the run. The trigger then advances the already
   locked epoch. This preserves the established organization-before-run order
   and serializes concurrent share changes without granting runtime direct
   `UPDATE` privilege on organizations.
4. Epoch changes are ordinary writes in the same transaction as the summary or
   ACL mutation. A failed or rolled-back mutation also rolls back its revision
   increment. Old process-cache entries are unreachable because the revision is
   part of the complete cache key and expire under the P09.3 bounds; no broadcast
   invalidation channel is required.

## Consequences

- A cache hit performs a short database transaction and holds one organization
  row share lock until commit. An archive ACL writer may wait for that response
  transaction, which defines the authorization order without serving bytes
  after a committed revocation.
- Multiple API replicas remain independent for storage but observe one database
  epoch. Crashes or local cache loss affect hit rate only.
- Invalidation is intentionally organization-wide. Unrelated users and tiles
  regenerate after an archive-visible change, matching the small-organization
  scale assumed by the SDD.
- P09.5 still owns the archive React consumer and refresh behavior. P09.6 owns
  SQL timeout, generation concurrency/queue, and tile-byte limits.

## Verification

- Real runtime-role/PostgreSQL integration proves that history grants make old
  revision URLs fail before cache access, live-only grant changes do not churn
  the archive epoch, and rollback restores both ACL and revision.
- Integration covers summary deletion and membership deactivation increments.
  Blocked cache-hit harnesses prove both lock orderings: revocation waits behind
  an active tile transaction, while a tile waiting behind the writer rechecks
  committed membership and never enters the cache.
- Existing concurrent share and summary-publication suites verify that
  organization-first locking does not duplicate epoch changes or deadlock.

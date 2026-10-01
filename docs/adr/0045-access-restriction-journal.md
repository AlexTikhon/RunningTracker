# ADR-0045: An access-restriction journal, so an old backup cannot silently restore revoked access

- Status: accepted; P12.4 implemented and verified locally on a workstation
- Date: 2026-10-01
- Scope: P12.4 only. The production identity provider is P12.1 and the final documentation pass is P12.5.
  Resolves D09 for the mechanism and the local drill; a production RPO/RTO is still not claimed.

## Context

A backup is a snapshot of the past. ADR-0037 keeps deleted runs from coming back; the same is true of
access. A share the owner revoked, a share narrowed from "history and live" to "live", or a membership
deactivated after the backup is, in the restored database, still granted, still wide and still active.
Until something puts those restrictions back, the moment the API connects a person who lost access can read
the run again, and the archive map draws it for them. The SDD names this as the step after deletion
reapplication ("restore current access restrictions") and P12.4 requires that "an old backup must not
silently restore revoked grants". ADR-0044 left that step as the one the drill could never complete.

The sources of current permissions in this codebase are `memberships.active` and `run_shares`. Shares are
changed through the API (`PUT`/`DELETE /runs/{runId}/shares/{userId}`) and by the cascade of a run deletion.
Memberships have no application path at all yet (the identity provider is P12.1): they are changed by an
administrator's SQL. Sessions live in process memory and are gone after any restart, so there is nothing
to restore there, and no credential exists yet.

## Decision

1. **The same mechanism as the deletion journal, for restrictions.** Row triggers on `memberships` and
   `run_shares` write one row to `access_restriction_journal` in the same transaction as the change
   (migration 0020). Triggers rather than application code because they cover every path: the share API,
   an administrator's SQL, and the cascade of a deletion, and because a rolled-back change leaves no row.
   Maintenance exports the rows at least once to the same off-host directory and the same sink as the
   deletion journal (`access-journal-*.ndjson` in `DELETION_JOURNAL_DIR`, one more periodic runner, same
   interval), and removes a row only after its file is durable. The export transaction is the one the
   deletion journal uses; it was extracted into a shared function and the deletion exporter's tests were
   left unchanged. Nothing new needs configuring: if deletions are exported, so are restrictions.
2. **Only restrictions exist, in the journal and in the reader.** Three kinds: `membership_deactivated`,
   `share_revoked` and `share_narrowed` (carrying the new two booleans). A grant, a re-activation, a
   widening and a role change are never journaled. The strict file reader rejects any other kind, so a
   forged or stale file cannot express a grant at all. This matters because the files are unsigned
   (ADR-0037): the worst an attacker who can write to the directory can do is remove access, never add
   it.
3. **Reapplication only removes access, and is owner-only.** `app_private.reapply_access_restriction`
   deactivates a membership, deletes a share, or intersects a share's two booleans with the journaled
   ones. It is granted to nobody but the object owner. An absent membership or share is `already_applied`;
   an unknown organization is `skipped_unknown_organization`. The existing archive-revision triggers
   advance the organization's revision for every change, and the journal triggers record each change
   again on the recovered node, so history stays continuous. The command is `npm run
   restore:reapply-access -- --journal-dir <copy>` (owner login, counts only, validates every file before
   touching the database, one transaction per entry, rerunnable).
4. **Replay everything, in any order.** Entries are not filtered by the backup's age. Because each one can
   only remove access, replaying all of them, in any order and any number of times, can leave the database
   more restricted than the lost node was but never less. That is the fail-closed price, stated openly:
   a grant made after the backup is lost with the node and has to be made again, and a share revoked and
   then granted again before the loss is removed again.
5. **Order.** Restore, migrate, reapply deletions, reapply access restrictions, verify, and only then open
   access. Deletions first: reapplying a deletion removes the run's shares too, so most share entries of
   deleted runs are `already_applied`.
6. **The drill completes the last recovery step.** `restore:drill` now (a) upgrades the source to the
   repository's schema after the backup, as a release deployed between the backup and the loss, so the
   restored backup lacks the journal table and its reapplication function and the catch-up migration
   provides them; (b) makes three restrictions after the backup through the application's own paths: a share
   revoked by `revokeRunShare`, a share narrowed by `upsertRunShare` (both as the owner under the runtime
   role) and a membership deactivated by SQL; (c) exports both journals; (d) restores, migrates and
   reapplies deletions as before, then reapplies access twice; (e) probes who can read the surviving run
   as the runtime role under row-level security (`SET ROLE`, which needs no `CONNECT`) on the source before
   the loss, on the restored backup before reapplication, and on the recovered database. It passes only if
   the recovered permissions equal the lost source's, nobody gained access, the second pass changed
   nothing, and each change was journaled again. `current_permissions_restored` is then complete.
7. **Complete recovery still does not open the database.** The drill leaves `CONNECT` revoked from the
   runtime and maintenance logins and says "application access: closed". Opening the database is an
   explicit operator step in the runbook (`GRANT CONNECT ...`), never done by a tool.

## Alternatives rejected

- **Restore the whole permission state from the journal (grants too).** It would make an unsigned file
  able to grant access, and ordering between a revocation and a later grant becomes correctness-critical.
  Rejected; failing closed is the safer error.
- **Filter the journal by the backup's creation instant.** An entry just inside the margin that is wrongly
  skipped silently restores revoked access, the very failure this ADR prevents. Replaying everything
  costs, at worst, a re-grant.
- **Copy the permission tables off-host periodically instead of journaling changes.** A snapshot has the
  same recovery point as the backup it is meant to repair.
- **Application code writing the journal.** Misses administrator SQL (the only way to deactivate a
  membership today) and the cascade of a deletion.
- **A signed journal.** Deferred, as in ADR-0037. The reader being unable to express a grant bounds the
  damage of a forged file to removing access.
- **Opening the restored database from the tool once verification passes.** The checks cannot know that
  the environment around the database (credentials, network, the application version) is ready.

## Limitations

- Restrictions committed but not yet exported when a node is lost are lost with it: the recovery point is
  one export interval while the exporter is healthy and unbounded while it is failing, exactly as for
  deletions. A restriction in that window comes back with an old backup.
- A trigger journals what the database sees. `TRUNCATE` and a superuser disabling triggers are not
  covered; both are administrator actions outside the application.
- Rows describe pseudonymous identifiers (organization, user, run) and two booleans; the directory needs
  the same access control and retention as the deletion journal's (keep files at least as long as the
  oldest restorable backup).
- No credential, session, or provider state is restored: none exists (sessions are in process memory;
  P12.1 has no provider yet).
- A cascade revocation of the shares of a deleted run is journaled as well. They are harmless
  (`already_applied`) and bounded by the number of shares per run.
- Verified only on a workstation against a tiny database; nothing here establishes a production RPO or RTO.

## Verification

Real separated-role PostgreSQL/PostGIS integration (`apps/api/test/access-restriction-journal.integration.test.ts`,
15 tests: what is and is not journaled, rollback, no direct table access for the application roles,
claim/acknowledge, reapplication outcomes, no widening, an unknown kind or shape rejected, archive revision
advanced, journaled again) plus unit tests for the format (a grant cannot be parsed), the exporter, the
reapplication command and the pure drill evaluation, and two more real-drill integration tests (a forged
grant file stops the drill before any restore; an extra replay is a no-op). The drill report is
`docs/reports/p12-4-restore-drill.md`.

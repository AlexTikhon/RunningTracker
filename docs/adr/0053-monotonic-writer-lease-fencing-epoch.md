# ADR-0053: The writer lease fencing token is a durable epoch that release never erases

- Status: accepted; implemented and verified locally
- Date: 2026-10-07
- Amends: ADR-0010 decisions 2 and 3 (release no longer deletes the lease record)
- Scope: the browser-local IndexedDB writer lease only. There is no server-side writer lease; the server fences with
  control revisions, request ids and `(run, seq)` point identity (ADR-0010 decision 7).

## Context

The writer lease exists so that exactly one tab records for a user. Ownership alone (an owner id) is not enough: a tab
that was paused, throttled or slow can still hold an old lease value and act on it later. The fencing token is what
makes that harmless. Every writer-only transaction (`renewWriterLease`, `releaseWriterLease`, `allocateCaptureSegment`,
`appendPointForWriter`, `discardRejectedRun`, `discardRefusedRun`) re-reads the lease record in its own transaction
and proceeds only when owner **and** token still match and the lease is live.

That only works while a token is never issued twice. `releaseWriterLease` deleted the record, and `acquireWriterLease`
derived the next token from the stored one (`existing?.fencingToken ?? '0'` + 1). After a release there was nothing
stored, so the epoch restarted at 1: an ABA problem. Reproduced before this change: A acquires token 1, releases, A
acquires again (token 1 again), and the old `A/1` value renewed the new lease, appended points and released it. Any
owner id works here, and a reload is not needed: the coordinator's own `release()` followed by `claim()` is enough.

## Decision

1. **Ownership and generation are separate.** The per-user lease record is the durable epoch: its `fencingToken`
   only ever grows. Who currently owns it is a property of the record (`ownerId`, `expiresAt`, `releasedAt`).
2. **Release ends ownership and keeps the epoch.** A release by the current, unreleased holder rewrites the record
   with `releasedAt` set and `expiresAt` set to the release time. Nothing is deleted. A release by anyone else, or a
   second release, changes nothing and returns `false`.
3. **Liveness is one rule** (`isLiveLease`): not released and not expired. Acquire, renew and the in-transaction
   writer check all use it, so a released lease can not be renewed or used before its original expiry either.
4. **Acquire is one read-write transaction on the record.** A live lease of another, non-replaceable owner is a
   conflict. Otherwise the caller wins: a live lease of the same owner keeps its token (it is the same generation being
   re-confirmed); anything else (first lease, expired, released, or a provably dead owner replaced as in ADR-0047) gets
   `stored token + 1`. Two racing claimants serialise on the record, so only one receives the next token.
5. **Renew preserves the generation.** It only extends `expiresAt` for the exact live owner/token pair.
6. **Same owner, new generation.** An owner id equal to the old one gives no credit: after a release or an expiry the
   same owner receives a strictly newer token, and the earlier value is dead for good.
7. **No schema migration.** The record keeps its key and shape; `releasedAt` is optional. A record written before this
   change has no `releasedAt` and means exactly what it did (live while unexpired), so an existing valid lease stays
   valid. A pre-change lease that was already deleted had its epoch lost, which can not be recovered; the next lease is
   issued from token 1 for that user, which is only reachable when no lease value of the older generation is still in
   use by a running tab after an upgrade.
8. **Retention is one record per user, never deleted.** There is no history of generations and no cleanup of the
   record, so there is nothing whose removal could repeat a token. The database is dropped only as a whole (clearing
   site data), which also destroys every lease value that could be replayed against it.

## Example

```
A acquires          -> A / token 5
A releases          -> record: owner A, token 5, released
B acquires          -> B / token 6
stale A / token 5   -> renew null, release false, append / discard rejected (and also after A acquires again: A / 7)
```

## Consequences

- Outcome of the stale capability is the same whatever its route: release, expiry, takeover of a dead owner, same
  owner reacquiring, or a page restart.
- A released lease is immediately available to another tab; the former holder is read-only at once.
- The lease record is now written on release (previously a delete). A failed release leaves the holder and the epoch
  as they were.
- Limits: the lease is a same-origin, same-browser-profile lock. It does not fence other devices (see ADR-0010) and
  does not cover site-data clearing.

## Verification

`apps/web/src/writer-lease-epoch.spec.ts` against fake-indexeddb with overlapping transactions: first token; release
then reacquire (same and different owner) is strictly higher; expiry then reacquire is strictly higher; stale renew,
release, segment allocation, point append and refused-run discard are rejected and leave the successor untouched; a
released lease is dead before its original expiry; concurrent acquires after a release produce one winner with the next
token; a new storage instance on the same database continues the epoch; users have independent epochs; failed
acquire, release and renew keep the epoch; a fixed acquire/renew/release/expiry sequence issues strictly increasing
tokens; and the coordinator's `release()` + `claim()` yields a newer generation that the old lease can not touch.

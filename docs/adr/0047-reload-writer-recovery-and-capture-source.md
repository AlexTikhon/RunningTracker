# ADR-0047: Writer recovery after a reload, and a persisted capture source

- Status: accepted; implemented and verified in Chromium on a workstation (2026-10-03)
- Scope: the browser writer lease of ADR-0010 and the capture sources of ADR-0011. Nothing on the server changes.
- Amends: ADR-0010 decision 6 ("crash/reload recovery relies on bounded expiry"). The rest of ADR-0010, in particular
  the fencing token, stands.

## Context

Two defects were found by the first real-browser tests (`tests/e2e/reload-offline.spec.ts`) and decided to be defects,
not accepted limits.

1. **A reload conflicted with its own lease.** The lease record lives in IndexedDB for 15 s after its last renewal. A
   reload destroys the page without running React cleanup, so the reloaded page, which has a new random owner id,
   found a live lease of "another tab", showed Writer `conflict`, stayed read-only until the old lease expired
   (about 17 s) and never retried.
2. **The capture source was not restored.** It was React state that started as Device GPS, and the select is disabled
   while recording. A reloaded Simulator run therefore resumed on Device GPS, which fails without permission.

## Decision

### Writer recovery

1. **Liveness is proven by a Web Lock, not by a reused identity.** Each `WriterLeaseCoordinator` holds an exclusive Web
   Lock named after its random owner id from before that id is first written into a lease until the coordinator is
   disposed or its document is destroyed. The browser releases the lock when the document is destroyed, whatever the
   cause (reload, close, crash), with no cleanup code involved (`writer-presence.ts`).
2. **Replacement of exactly one proven-dead owner.** A claimant that meets a live lease of another owner waits for that
   owner's lock, event-driven and bounded (`takeoverWaitMs`, 3 s), with no polling. If the lock becomes free the
   holder is gone and the claimant calls `acquireWriterLease(user, owner, duration, [holder])`. Inside that single
   IndexedDB transaction a live lease is replaced only if its owner is in the list, and the fencing token is
   incremented. If the wait times out the claimant makes one ordinary attempt (the lease may have been released or
   expired meanwhile) and otherwise reports `conflict`.
3. **No identity is reused.** Owner ids stay random and in memory per coordinator. Nothing a tab can copy (a
   duplicated tab starts with the original's `sessionStorage`) can be used to claim a lease, which is why a
   per-tab id kept in `sessionStorage` was rejected: a duplicate would present the same owner id, the existing
   same-owner branch would reuse the same fencing token, and two live documents would write under one token.

Invariants:

- I1. Every renew, release, segment allocation and point append still re-checks owner, fencing token and expiry inside
  its IndexedDB transaction. Nothing in this ADR relaxes that check.
- I2. A live lease changes hands only by expiry, release by its holder, or replacement of an owner the claimant has
  proven gone. Replacement always increments the token, so the replaced instance is fenced even if it were somehow
  still running.
- I3. Two claimants racing for a dead owner's lease get one winner: the loser's transaction sees an owner that is not in
  its list and reports `conflict`.
- I4. A wrong "gone" verdict can cost availability, never safety (I1).
- I5. Recovery is bounded: at most one wait of `takeoverWaitMs` per claim, and no timer or loop runs while idle.
- I6. A live second tab, or a copy of a tab, never frees the lock of the owner it meets, so it ends in `conflict` after
  the bound and remains read-only.
- I7. Without the Web Locks API the presence is inert: nobody is proven gone and behaviour is exactly that of
  ADR-0010 (conflict until expiry).

### Capture source

The chosen source is a per-user selection, it may change while a run is paused, and it must survive both run changes and
clearing a finished run. It is therefore stored as an optional `captureSource` in the existing `profiles` record (no
IndexedDB version bump), written by `saveCaptureSource` and carried through every profile rewrite
(`putRunSnapshot`, `clearActiveRun`). `loadRecovery` returns it validated by `parseCaptureSourceKind`, which maps a
missing or unknown value to Device GPS. The persisted value is the semantic kind, never a `CaptureSource` object.

In `App`, the source is `null` until restored. The capture effect requires a non-null source and storage `ready`, and the
restored source is set in the same batch as `storage-restored`, so Device GPS can never start before the stored choice
arrives. The select is disabled until restored, and in a tab that does not own the lease while a run exists.

## Consequences

- A reloaded recording tab owns the lease again in about 0.2 s (three reloads measured: 199, 197, 232 ms from the reload to
  `owned`) with a new fencing token, resumes capture from the stored source in a new segment, and keeps its sequence.
- A tab left open on an older build holds no lock, so a newer tab treats it as gone and replaces its lease. The older
  tab is then fenced at its next renew or append (I1), which loses its recording, not data integrity.
- A genuine second tab shows `acquiring` for up to 3 s before `conflict`.
- A frozen or heavily throttled background tab keeps its lock but may fail to renew; its lease can expire and be taken by
  expiry exactly as before.
- The capture source is a preference: after "New run" the previous choice is still selected.

## Not established

- Only Chromium was exercised. Web Locks are standard in current Firefox and Safari, but the release timing on
  navigation was not observed there. Browsers that keep a document alive in a back/forward cache are not covered.
- Chrome's "Duplicate tab" could not be driven; the E2E models its one relevant effect (inherited `sessionStorage`).
- This remains a same-origin browser guarantee, not a distributed device lock (ADR-0010 decision 7).

## Verification

- Unit: replacement only of a named owner with a higher token; one winner for racing claimants; a reloaded owner owns
  at once with token 2 and the old instance is fenced; a live rival ends in `acquiring` then `conflict`; takeover as soon as
  the holder dies while the claimant waits; inert presence waits for expiry; an obsolete instance cannot release its
  successor; disposal is idempotent and releases presence; the real Web Locks adapter against Node's lock manager.
  Capture source: round trip through close/reopen, kept across snapshots and `clearActiveRun`, default for old and
  invalid records, refusal of unknown values.
- Browser: `reload-offline.spec.ts` (reload recovery), `second-tab.spec.ts` (live tab, and a copy with inherited
  `sessionStorage`); see `docs/progress.md` for the mutation checks.

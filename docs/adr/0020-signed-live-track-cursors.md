# ADR-0020: Signed and identity-bound live-track cursors

- Status: accepted; P07.4 implemented and locally verified
- Date: 2026-09-27
- Scope: P07.4 only

## Context

P07.1-P07.3 encoded live-track continuation state as unsigned base64url JSON.
The API validated its shape and org/run/operation fields, but a caller could alter
revision or sequence values, and an authorized user could replay another user's
cursor. A continuation also had no bounded lifetime.

## Decision

1. Live-track snapshot and changes cursors use a versioned `payload.signature`
   envelope. The signature is HMAC-SHA-256 over the exact base64url payload, and
   verification uses a constant-time comparison before JSON parsing.
2. The strict signed payload carries the operation, user, organization, run,
   algorithm version, target revision, last bigint sequence, and absolute expiry.
   Changes cursors additionally carry the source revision and require `A <= T`.
3. Every decode checks the authenticated user plus the route organization and run.
   Snapshot and changes tokens are not interchangeable. Signature, shape, binding,
   and expiry failures share the public `400 INVALID_CURSOR` result.
4. The first continuation cursor expires ten minutes after issuance. Later pages
   retain that absolute deadline instead of refreshing it, bounding the lifetime
   of the complete fixed-revision traversal.
5. `LIVE_TRACK_CURSOR_SIGNING_KEY` is canonical unpadded base64url decoding to at
   least 32 bytes. A documented local-only key supports development/test; production
   startup rejects it and requires deployment-specific key material.
6. Cursor validation does not replace authorization. Every valid continuation still
   rechecks session, active membership, current run ACL, raw availability, current
   algorithm version, and the cursor revision against current run state.

## Consequences

- Clients cannot forge pagination boundaries or transfer continuations between
  identities, runs, organizations, or live-track operations without detection.
- Key replacement intentionally invalidates outstanding cursors. Multi-key rotation
  is unnecessary for the ten-minute lifetime and remains deployment work, not a
  second cursor protocol.
- Run-list and raw-history cursors are unchanged because this stage is limited to
  the P07 live-track contract.
- Atomic browser-side application remains P07.5.

## Verification

- Unit coverage proves snapshot/changes round trips, all identity and operation
  bindings, payload/signature/key tampering rejection, exact expiry, and preservation
  of one deadline across a page chain.
- Runtime-role HTTP integration proves signed snapshot/change pagination, tamper and
  cross-user rejection, current ACL/raw-state rechecks, and all existing P07 edge and
  fixed-revision behavior.
- Full lint, strict typechecking, unit tests, production builds, migration preflight,
  and the complete real-role/PostGIS integration suite pass.

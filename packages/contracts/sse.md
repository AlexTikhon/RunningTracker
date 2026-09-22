# `/live` SSE contract

This document is the transport contract for `GET /api/orgs/{orgId}/live`. It complements, but is intentionally not embedded in, the OpenAPI document for ordinary HTTP operations.

## Request and authorization

- Method/path: `GET /api/orgs/{orgId}/live`.
- Request `Accept`: `text/event-stream`.
- Authentication: the same-origin `running_tracker_session` HttpOnly cookie. Tokens are never accepted in the URL.
- The server validates the session, active membership, and visible run grants before emitting state. An unavailable organization is not distinguishable from other denied organization access beyond the ordinary `ORG_ACCESS_DENIED` contract.

## Event frame

The only application event is named `live.state`. Its `data` field is one JSON value accepted by the exported `liveStateSchema` in `@running-tracker/contracts`.

```text
event: live.state
data: {"streamId":"9ea333f2-b02f-4a9e-85f9-af3a6016f677","sequence":0,"serverTime":"2026-09-22T10:00:00.000Z","algorithmVersion":"v1","runs":[]}

```

The payload is a strict object:

```ts
interface LiveState {
  streamId: UUID;
  sequence: number;
  serverTime: Timestamp;
  algorithmVersion: string;
  runs: Array<{
    runId: UUID;
    status: "recording" | "paused";
    dataRevision: Revision;
    position: null | {
      seq: Seq;
      coordinates: [longitude: number, latitude: number];
      recordedAt: Timestamp;
      accuracyM: number;
      quality: "confirmed" | "unconfirmed";
    };
  }>;
}
```

`Revision` and `Seq` are positive/nonnegative PostgreSQL-bigint-domain decimal strings as applicable; they are never JSON numbers. Coordinates and accuracy must be finite and within the shared runtime schema ranges. `sequence` is a nonnegative safe JSON integer because it is connection-local, not a database bigint revision.

## Ordering, disconnects, and reconnects

- The server emits the first complete `live.state` immediately after the connection is established. Later messages are complete current state, not a durable change log.
- `streamId` is a fresh UUID for every connection. `sequence` orders messages only within that `streamId` and increases monotonically for each emitted application event. A client must not compare sequence values across stream IDs.
- The server rechecks session expiry on the open connection and closes the stream when the session expires or is revoked. Transport failures and server shutdown also appear to the client as a disconnect; no terminal SSE event is guaranteed.
- After a disconnect, the client checks `GET /api/session`. It reconnects only when the session is valid and must stop an unbounded authorization-error reconnect loop when that check returns `401`.
- A reconnect establishes a new `streamId` and sequence domain. The first event is authoritative current state and replaces the prior connection state.
- SSE `id`/`Last-Event-ID` is not a replay guarantee. Durable track recovery uses the ordinary `live-track` snapshot and `live-track/changes` HTTP contracts keyed by run revisions and signed cursors.

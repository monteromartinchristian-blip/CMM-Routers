# Remote Worker Contract (v1, frozen boundary)

Version: `1` (`WIRE_VERSION` in `src/core/wire.ts`).

This contract freezes the internal provider boundary so a future
distributed worker can reuse the existing adapters without rewriting them.

## Explicitly out of scope for v1

v1 does **not**:

- open a remote listener;
- upload OAuth or provider secrets;
- implement cloud routing;
- bind any worker to `0.0.0.0`.

Future topology only:

```text
Qoder
→ Router / control plane (127.0.0.1:8790)
→ authenticated private worker
→ local provider auth
```

Worker credentials stay on the worker. Mutual authentication is a
design seam, not built infrastructure.

## Envelopes

- `WorkerRequestEnvelope`: `{version, requestId, provider, operation, payload}`
  with `operation` in `run | cancel | discover | health`.
- `WorkerEventEnvelope`: `{version, requestId, sequence, event}` carrying
  one normalized `RouterEvent`.
- `WorkerModelsEnvelope`, `WorkerHealthEnvelope`, `WorkerCancelEnvelope`,
  `WorkerErrorEnvelope`: discovery, health, cancellation, and safe errors.

All envelopes are JSON-serializable. Unknown protocol versions and
unknown providers/operations are rejected. Extension fields are allowed;
removing or retyping existing fields requires a version bump.

## Security boundary

No envelope may carry `authorization`, `api_key`, `access_token`,
`refresh_token`, `oauth`, `secret`, `cookie`, or `token` fields at any
depth — serialization and parsing both enforce this. Errors cross the
boundary only as `{code, message, provider?}` via `safeRouterError`.
Provider SDK objects, child processes, and streams are never serialized.

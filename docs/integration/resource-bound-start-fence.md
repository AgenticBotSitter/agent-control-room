# Resource-bound final start fence

Status: reusable, effect-free version-two component. This does not register a
live native or Codex start path and does not claim deployment or physical
connector acceptance.

`createCurrentResourceHolderFenceV2` captures the authenticated current-holder
lookup and trusted clock when the server or node composes the fence. Replacing
those configuration callbacks later cannot redirect a check. Each
`assertCurrent` call snapshots the exact expected tenant, project, job,
attempt, lease, node, run, resource admission, and start authorization before
its first asynchronous boundary.

The fence then performs one fresh authenticated lookup through a repository-owned
synchronous result collector. The trusted port returns only `Promise<void>`;
the proof never becomes that Promise's resolution value, so a hostile Proxy or
thenable cannot run traps or getters through Promise assimilation. The fence
takes exactly one submitted result, snapshots its ordinary data, and applies the shared
`verifyCurrentResourceHolderProofV2` contract against the trusted current time.
That contract requires the strict `control-room.current-resource-holder/v2`
shape, `held` state, exact expected fields, a non-future check, a future expiry,
and the existing maximum ten-second proof lifetime.

Every malformed, missing, changed, expired, future-dated, overlong, retired,
mutated, incomplete, multiply submitted, or failed lookup produces only
`current_resource_holder_unavailable`. The component does not expose lookup
details. The collector is aborted on every error. The component never caches a
successful proof, so a later check observes holder retirement.

## Integration rule

Call `assertCurrent` immediately before the irreversible operation in each
path:

1. Native: immediately before the owned transport releases start-request
   bytes.
2. Codex: separately before workspace preparation, `thread/start`, and
   `turn/start`.

Do not treat an earlier successful check, signed dispatch, receipt, activation,
or local-start binding as proof that the holder is still current. A refusal is
terminal for that attempted step: callers must not dispatch, start, resume,
retry, reactivate, prepare a workspace, or release transport bytes.

The fence deliberately accepts no effect callback and has no queue, transport,
process, workspace, retry, or holder-write port. Live compositions remain
responsible for placing their own callback directly after a successful check
and leaving it untouched when the check refuses.

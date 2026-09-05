# CR14C — current recovery-policy composition

Date: 2026-09-05. Repository-only component based on PR #306.

`createNativeCurrentRecoveryPolicy` resolves a separately pinned owner public approval key for one
exact configured enrollment and cleanup key ID. It does not sign recovery permission or turn ordinary
start approval into recovery authority. The recovery controller still checks the separately signed
status/stop permission, exact run binding, known native run, durable marker and outstanding claim.

## Sources and scope

The caller supplies already-open `PinnedApprovalTrustStore` and the same protected security repository
used by that approval store, plus a trusted synchronous node-local cleanup/credential state reader.
Tenant/node/class must match the configured approval scope. The local state must name the enrollment's
exact credential reference and provide explicit booleans plus a nonnegative safe-integer revision.
There is no default credential availability, default cleanup permission, browser input or remote flag.

Local revision rollback and same-revision conflicting content are rejected within this reader instance.
This is not a durable local-policy store or replacement for owner configuration provenance. The runtime
must supply that trusted service; tests use an explicit synthetic local-state service without reading
credentials. A changed decision must increment revision. Restart rollback protection is not claimed.

## Freshness and expired work

Before awaiting approval resolution, capture local state and the synchronous verified committed server
trust revision. After resolution, and after later profile/controller awaits, recheck that snapshot and
the approval store's validity/disposal state. Changes invalidate the earlier permission, not trigger an
automatic retry. The recovery controller rechecks durable run/claim evidence again after its bounded
Promise.race settles. Existing unresolved-work limits and timeout behavior remain intact.

The security repository exposes a trust-only revision fence, separately from the combined work ceiling
and trust fence. Recovery can therefore proceed under separately authorized cleanup permission after
the work lease/deadline expires, or when no work ceiling has been provisioned. It does not need or renew
work authority. Recovery expiry remains bounded by its signed permission and enrollment lifetime.
The start path still requires the signed work ceiling and lease.

Legacy abstract recovery-policy providers remain trusted seams and may omit `assertFresh`. This verified
composition always provides it; runtime wrappers must preserve it and use the same security repository.
The fence is not a cross-process transaction or a guarantee about physical effects after authorization.
The existing adapter still owns immediate pre-byte authorization, single stop-attempt recording,
ambiguous outcomes and no automatic stop replay.

## Not included

No store opening, native key read/unlock, provider call, listener, new database schema, runtime mounting,
production setup, deployment or merge. Profile/destination qualification remains a mandatory separate
trusted callback; no live evidence is fabricated here. Owner signing/intake, persistent local cleanup
configuration, production qualification, signed dispatch and revision submission remain unfinished.
This does not complete live C-WORK. Continue repository implementation on Astra Medium.

# CR14C canonical approval-packet storage

This block connects paired signature verification to current owner-authorized canonical preparation
in the same checked transaction. Immutable PostgreSQL packet evidence is not a canonical effect approval,
an admission claim, a dispatch instruction or a substitute for current node checks.

The stored record binds tenant/project/job/attempt, input/enrollment/operation/binding digests, exact signed
start/recovery packet, actor and acceptance time. An integrity tag protects readback; same-task identical
packet replay returns the original receipt, while a conflicting packet cannot replace it. Database triggers
reject update, delete and truncate. The private-web SQL role gains no packet access.

Verification must use explicit scoped owner trust, preserving separation from server signing keys. Verify
the packet against locked canonical preparation, then fence trust, session, grants, key validity and work
deadline before commit. Store signatures and safe references only, not prompt text or private key material.
Readback is evidence, never ongoing authority; expiry/revocation and canonical reservation are checked again
before any later dispatch. No signer, host setup, listener or live provider call is in scope.

The trusted coordinator method is `storeNativeApproval`, absent from `webOperation`. It snapshots the
packet before asynchronous canonical reads, uses the same transaction/lock ordering as preparation,
and receives an explicitly configured `NativeApprovalPacketStore`. Configuration is absent by default;
neither the lifecycle factory nor deployment bootstrap installs it yet. No new HTTP handler is mounted.

The store selects scoped owner trust using tenant/node/class. It reuses the paired intake verifier and
protected server-trust revision fence rather than a caller's verification flag. These trust dependencies
are supplied infrastructure; the store does not load a database, public pin file or credentials. The
verifier and signature schemas now live in the shared harness layer; native entrypoints re-export them.

Identical replay still requires fresh owner/session authorization, current reservation and successful
signature/trust verification. It returns the original acceptance timestamp even when the current owner
differs. A different signed packet cannot replace the original on the same attempt. A missing row can
be inserted only under the coordinator's serialized canonical locks; no last-writer-wins update exists.

Migration 0047 adds `control_native_approval_packets`. Coordinator setup grants only SELECT and INSERT;
private-web privileges remain unchanged. The exact schema digest is
`27323374215b98cf61e96fb336b872a1c1ec6c935065d6a69e99e76da0617d8d`, with 133 tables.
The preparation manifest and fixed inventory advance to 0001–0047. This changes offline setup contracts,
not an existing deployed database. Physical PostgreSQL ACL/concurrency rehearsal remains a separate gate.

Remaining: lifecycle/router mounting and bounded reconciliation UI, owner signer/custody, canonical signed
dispatch and node receipt consumption, trusted supervisor persistence, revisions and live qualification.
Stored signature evidence is not a row in `control_approvals` or a consumable effect authorization. The
existing node authority/admission/marker controllers must still enforce execution. No live effects occurred.

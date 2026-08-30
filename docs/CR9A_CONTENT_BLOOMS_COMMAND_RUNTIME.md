# CR-9A Content Blooms fake-backed command runtime

**Status:** Implemented for local synthetic acceptance only
**Runtime contract:** `control-room-content-blooms-placement-runtime/v1`
**Synthetic command contract:** `control-room-content-blooms-synthetic-command/v1`
**Live connector:** Absent and disabled

## Boundary

CB-060 implements the CB-050 placement contract against one deterministic injected fake. It does not add a Content Blooms URL, account, credential, client, socket, process, provider, source-database handle, or production constructor. The adapter constructor accepts only the exact repository synthetic-source class and rejects subclasses or other source objects.

The implementation requests one source-owned transcription-route preference. It never assigns a worker, issues or renews a lease, starts transcription, changes a source workflow state directly, or treats a local receipt as source truth.

## Protected ledger

Migration `0026_cr9a_content_blooms_placement.sql` adds separately bound records for:

1. reviewed placement declarations;
2. exact placement requests;
3. authorization plus the exact strong-factor approval request and decision;
4. separately signed node-approval verification evidence;
5. effect-scoped claims;
6. pre-effect markers;
7. source or ambiguity outcomes; and
8. permanent replay tombstones.

Every immutable row is append-only and every table rejects truncation. Effect claims allow only protected state transitions and reject deletion. An integrity key held outside the database authenticates every row and every mutable claim state, including its normalized mirrors, version, marker, outcome, and timestamps. Ordinary SHA-256 remains identity and evidence; it is not used as the only database-tamper boundary.

The request ID, deterministic source idempotency key, operation digest, and claim identity each have an independent uniqueness barrier. Exact replay returns the stored disposition. Changed replay, same-effect request renaming, row drift, or correlated identity fails closed.

## Dispatch order

The fake-backed adapter performs these checks in order:

1. resolve the declaration, request, authorization, approval records, and node-attestation evidence from the protected ledger;
2. resolve the active release, current control lifecycle, and current source work-item projection from the durable synchronization store;
3. repeat CB-050 pre-dispatch validation and exact source version/checksum/record-digest checks;
4. require time strictly before every effective expiry;
5. create or exactly replay one effect claim;
6. commit one complete pre-effect marker;
7. invoke only the injected fake source; and
8. persist an exact accepted, already-applied, rejected, or ambiguous outcome.

A duplicate marker never permits another source call. A crash before a marker leaves a claim safe to re-evaluate. A crash or unknown result after the marker becomes `ambiguous`; automatic retry remains prohibited even when the fake source shows that it may have applied the preference.

## Signed node evidence

The runtime verifies an exact Ed25519 `OwnerApprovalAttestationV1` against an injected public SPKI value. The attestation must bind one node, tenant, project, job, attempt, operation digest, medium risk, issue time, expiry, nonce, and approval-key ID. Its expiry may not exceed the placement request, route observation, or central authorization.

Only digest-bound verification evidence is stored in the placement ledger. The verification record itself grants no approval, command, network, lease, or execution authority and is single-use through the effect claim and nonce uniqueness barriers. Production approval-key custody and node-local trust-store operation remain deferred.

## Source outcomes and recovery

- `accepted` records a new fake source version.
- `already_applied` proves that the same source idempotency key was already observed.
- `rejected` preserves one bounded source reason and never invents a new request.
- `ambiguous` records that no authenticated source receipt settled the post-marker attempt.

The full outcome remains append-only. A tombstone is an additional permanent replay seal; this phase does not delete the full outcome. Sealing requires explicit known retention horizons and a future `retainUntil`. Ambiguous truth cannot be overwritten by a later accepted-looking local record. Source-assisted reconciliation remains a later, separately reviewed operation.

## CB-070 project pack

The repository project pack contains independently reviewed procedure and knowledge packages for three stages: research observation, transcription route preference, and article review observation. It uses the real immutable package registry for storage and review. It does not activate a harness mapping and cannot approve, dispatch, execute, perform live research, read transcripts or article bodies, or publish.

Its operator projection contains only sanitized work-item identity, title, source state, source version, record digest, attention identity, and a bounded next action. Source scheduling and lease ownership remain explicit.

## Deferred

- an authenticated Content Blooms read or command connector;
- endpoint identity, DNS/TLS policy, credential selection, or secret-provider use;
- actual node-local trust-store and approval-key custody;
- source reconciliation polling or an operator ambiguity-resolution command;
- live research, transcription, article material, publication, or source mutation;
- project-pack harness mapping, activation, or native execution;
- deployment, monitoring, backup, rollback, or cleanup; and
- any network, provider, process, native, production, or consequential external effect.

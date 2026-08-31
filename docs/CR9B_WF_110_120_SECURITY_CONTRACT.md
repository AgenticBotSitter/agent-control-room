# CR9B-WF-110/120 delivery authority and readiness contract

**Status:** Frozen and implemented locally with authenticated disabled truth
**Date:** 2026-08-29
**Authority:** ADR-063 through ADR-069, the CR-8 Completion Gate, and the repository security contracts

## Outcome

Wayfarer private upload and public publication are now two separate high-risk operation families. They cannot share a destination identity, content set, operation digest, idempotency key, approval request, readiness record, disposition, or effect authority. The accepted implementation defines exact candidate contracts and a durable disabled state. It contains no destination client and performs no media read, credential resolution, network call, upload, or publication.

## Exact destination and request identity

Each future destination is digest-only and boundary-specific:

- private upload uses an exact candidate `private_object_store` identity;
- public publication uses an exact candidate `public_video_channel` identity;
- origin, path, adapter release, and credential reference are represented only by digests;
- raw origins, paths, credential references, and credentials are forbidden; and
- a destination candidate proves neither adapter qualification nor authority.

Each request binds tenant, workspace, Wayfarer project, job, attempt, effect intent, delivery package, exact boundary, immutable content identities and sizes, Completion Gate resolution, destination identity and path, adapter release, credential reference, request window, and operation. Private upload requires the episode master, assembly manifest, and publication package. Public publication requires only the episode master and publication package. Cross-boundary role reuse fails closed.

The stable destination idempotency key binds the boundary, destination identity and path, immutable content set, and Completion Gate resolution. It does not use a delivery message ID or request ID. Every request still reports `deliveryAuthorized: false`.

## Approval separation

The central approval request is high risk and requires a fresh strong factor for the exact operation digest. It grants no execution authority. A later delivery also requires a separate node attestation, durable effect claim, pre-effect marker, destination receipt, cleanup receipt, and reconciliation procedure. Approval for private upload cannot authorize public publication, and publication approval cannot authorize upload.

## Ordered readiness gates

Each delivery lane has ten ordered gates:

1. exact preparation package;
2. immutable artifact content identities;
3. authoritative Completion Gate resolution;
4. exact destination identity;
5. qualified destination adapter;
6. protected credential custody;
7. node execution authority;
8. destination idempotency qualification;
9. cleanup and reconciliation runbook; and
10. fresh owner approval window.

Every gate records its evidence class, state, safe reason, check time, optional expiry, and evidence digest when present. Package evidence must equal the candidate package digest. Destination evidence must equal the exact candidate destination digest. Even ten current gates produce only `candidate_for_owner_window`; they do not authorize delivery or provide a live adapter.

## Current disabled truth

Both lanes currently have one of ten gates: the exact metadata-only preparation package. The other nine gates are missing. Each lane therefore has a separate digest-bound `disabled` disposition reporting:

- zero delivery attempts and destination contacts;
- zero artifact-byte reads and credential resolutions;
- zero claims, markers, destination mutations, or external effects;
- no upload, publication, approval, or execution authority;
- no automatic retry; and
- a required new assessment and authorization before reconsideration.

Assessment and disposition pairs append atomically to a tenant/workspace/project-bound SQLite ledger protected with keyed authentication. Private and public lanes advance independently. Exact replay is inert. Restart preserves current and historical truth. Row deletion, partial replay, chronology rollback, boundary substitution, metadata drift, schema injection, scope drift, and wrong-key access fail closed. Whole-file rollback still requires an independent checkpoint before any live use.

## Explicitly absent

No destination, account, bucket, path, channel, endpoint, credential, media byte, storage client, network client, provider, native process, upload, publication, deletion, deployment, or external effect was accessed or implemented. The candidate fixture exists only to test structural separation and is not current readiness evidence.

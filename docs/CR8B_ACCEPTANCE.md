# CR-8B completion and approval core acceptance

**Status:** Accepted locally for the effect-free repository core
**Date:** 2026-08-28
**Scope:** CR8B-001 through CR8B-008
**External or native effects:** None

## Delivered

- A versioned domain that keeps acceptance profiles, immutable review targets, advisory comments, completion reviews, verification results, findings, revisions, preferences, approval requests, and approval decisions separate.
- Strict schemas with literal negative-authority fields. Quality readiness and preference can never become approval or execution authority.
- Migration `0022` and a tenant/project-bound append-only ledger with collision-resistant semantic replay keys, canonical digests, external-key HMAC authentication, and update/delete/truncate guards.
- Mandatory producer/reviewer actor separation plus configurable worker, agent-profile, harness, and model-family separation. Counted reviewers must also be independent of one another.
- Target-row serialization so simultaneous correlated reviewers cannot both pass, and superseded targets cannot accept new reviews or verification evidence.
- Deterministic risk floors, exact named verification scenarios, immutable findings, complete finding resolution, one-step revision lineage, configured revision limits, and explicit supersession.
- Exact approval requests tied to a locked, still-proposed canonical effect and active job with recomputed operation and authority digests.
- Human approval decisions tied to an existing allowed security-policy decision, a current owner/operator grant, external-effect permission, and fresh strong-factor evidence. Decisions expire within both the request and policy proof.
- The same completion contract proven for code, media, document, and operation targets.

## Acceptance evidence

The focused CR-8B suite proves schema separation, immutable target/profile replay, conflicting semantic replay, producer and reviewer independence, simultaneous-review serialization, all four target classes, named verification, deterministic risk floors, advisory non-authority, preference non-authority, bounded revisions, supersession, late-evidence rejection, expiry, exact operation binding, strong-factor step-up, tenant-scoped IDs, append-only enforcement, and external-key tamper detection.

Completed local verification:

- CR-8B focused suite: 9/9 passed.
- Combined pretest group: 54/54 passed.
- Main repository suite: 416 total, 414 passed, zero failed, and two intentional Windows-only skips on macOS.
- Type checking and full lint: passed.
- Production build and two rendered-route tests: passed. The existing Vinext `node:crypto` browser-externalization warning and route-classification caveat remain non-failing.
- PostgreSQL migrations `0001` through `0022`: applied; 74 tables verified.
- `git diff --check`: passed.

## Authority boundary retained

An accepted completion snapshot still says `requiresSeparateApproval: true`, `grantsApproval: false`, and `grantsExecutionAuthority: false`. A centrally approved CR-8B decision still says `grantsExecutionAuthority: false` and `requiresSeparateNodeAttestation: true`.

CR-8B does not issue or consume the separately signed node-verifiable owner attestation required by CR-5C. It does not create a job, lease, reservation, dispatch, credential, node admission, effect claim, external effect, Telegram callback, network service, or deployment.

## CR-8Q hardening addendum

The later independent CR-8Q review proved that a database-local state head alone could not detect total module erasure or restoration of an older complete snapshot. Migration `0024` and the current store therefore add explicit tenant provisioning plus a monotonic owner-controlled checkpoint outside PostgreSQL. The historical counts above remain CR-8B acceptance evidence; current combined counts and re-review status are recorded in `BUILD_STATUS.md` and the CR-8Q review documents.

## Local-only hold

No commit, push, pull request, GitHub mutation, provider call, credential access, service change, or deployment was performed. The owner's local-only hold through 2026-09-01 remains in force.

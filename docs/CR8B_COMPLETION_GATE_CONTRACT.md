# CR-8B completion, review, verification, revision, preference, and approval contract

**Status:** Architect-frozen and locally accepted for the CR-8B repository core
**Date:** 2026-08-28
**Authority:** ADR-041, ADR-042, ADR-044, `SECURITY_AND_AUTHORITY.md`, and `CR5C_FINAL_SECURITY_CONTRACT.md`

## Outcome

Control Room records quality review, deterministic verification, findings, revisions, owner preferences, and consequential approval as different immutable facts. A record from one domain never grants the function of another. Completion readiness is evidence-backed quality state; it is never execution authority.

## Immutable review target and profile

Every target binds one tenant, project, subject ID and digest, producer provenance, target kind, immutable acceptance-profile digest, root target, and revision number. Initial targets are revision zero and are their own root. A revised target names exactly one superseded target and increments the revision number by one.

The acceptance profile freezes:

- target kind;
- the exact sorted verification scenarios;
- the number of independent completion reviews;
- required producer/reviewer separation by actor, worker, agent profile, harness, and model family;
- verifier/producer separation;
- the deterministic minimum risk floor;
- the maximum revision rounds; and
- whether a later policy may consider automatic low-risk disposition.

Automatic disposition is only a profile input in this block. It does not bypass required verification/review, grant approval, or issue an effect authorization.

## Review and verification

A review evaluates one exact target/profile digest. Advisory review can comment only and cannot create an authoritative finding. It cannot accept, reject, request an authoritative revision, approve an operation, or grant execution authority. Actor separation from the producer is mandatory. Completion-gate review also enforces every configured worker, agent-profile, harness, and model-family axis. The same configured axes are enforced between counted reviewers, and writes serialize on the immutable target so simultaneous correlated reviewers cannot both be counted. Missing provenance on a required axis fails independence rather than silently weakening it.

The effective risk is the maximum of reviewer-assessed risk and the deterministic profile floor. AI or reviewer scoring may raise this value but cannot lower it.

Verification is one immutable result for one exact target/profile/scenario. Outcomes are `passed`, `failed`, `blocked`, or `inconclusive`, each with evidence. Only named required scenarios count. A new target revision receives new verification records; prior evidence is not silently rebound.

Once a revision supersedes a target, that target accepts no new review or verification evidence. Exact replay of evidence already recorded remains safe and cannot be converted into a changed result.

## Findings and bounded revisions

Negative completion reviews carry explicit immutable findings. A revision must:

1. name the exact prior target and digest;
2. create a new immutable target with the same root, subject, kind, and profile;
3. increment revision by exactly one;
4. explicitly resolve the complete finding set on the superseded target;
5. remain within the profile's revision budget; and
6. bind the revising producer and timestamp.

The prior target becomes `superseded`. When unresolved findings remain at the configured limit, status becomes `revision_limit_reached` and requires attention. No overwrite or unlimited self-correction exists.

## Preference

A preference selects one digest from a fixed set of acceptable option digests for one subject. It may expire. It never accepts quality, passes verification, approves a consequential operation, or grants execution authority.

## Consequential approval

An approval request binds the exact existing, still-proposed effect intent, active job, project, attempt, recomputed operation digest, deterministic authority digest, risk, requester, strong-factor requirement, and expiry. Both request and decision creation recheck the locked canonical job/effect state. A central approval decision binds the exact request digest and operation digest, a human actor, strong authentication-event digest, decision, reason, and no-later expiry.

The human and strong-factor fields are not trusted declarations. A new decision must bind an existing allowed `control_policy_decisions` row for the exact effect, project, risk, actor, and decision time. That policy record must contain current owner/operator grant evidence, external-effect permission, and a live strong-factor evidence ID whose safe digest matches the completion decision. The completion decision cannot outlive either the request or the authenticated policy decision.

Request and decision creation use the store's trusted clock, never a caller-supplied or backdated timestamp. Historical exact replay remains readable after expiry, but a new request or decision is rejected at its expiry boundary. An owner/operator role grant must remain active through the complete decision lifetime, and a grant already revoked at the trusted decision-recording time cannot support approval.

Even an approved central decision returns literal `grantsExecutionAuthority: false` and `requiresSeparateNodeAttestation: true`. CR-8B does not issue the separately signed, node-verifiable `OwnerApprovalAttestationV1` required by CR-5C. Quality readiness, preference, proposal review, or artifact presence cannot substitute for either approval record.

## Persistence and integrity

Migration `0022` creates one append-only completion-gate ledger with strict record kinds, tenant/project-scoped identities, collision-resistant semantic replay keys, ordinary canonical digests, and external-key HMAC authentication. Migration `0024` adds a monotonic revision to its per-tenant state head. Update, delete, and truncate fail. Reads reparse the strict kind schema and compare every normalized selector, semantic key, digest, timestamp, authentication tag, and checkpoint revision before use.

Tenant/module initialization is an explicit one-time operation. Normal reads and writes never manufacture a missing state head. Every valid head revision is compare-and-swap pinned through `RollbackCheckpointStoreV1`, whose implementation must be owner-controlled and outside the protected PostgreSQL deletion/rollback domain. A missing head, missing checkpoint, complete module erasure, older valid database snapshot, wrong key, or checkpoint drift therefore fails closed. The included in-memory checkpoint is effect-free test evidence only and is forbidden as deployment storage; a crash between database and external-checkpoint commits intentionally requires owner recovery rather than guessing which state is current.

Exact replay is safe, including review and revision replay after later immutable history exists. Reusing an ID or semantic key for changed content fails, and racing identical inserts converge on the authenticated stored record. The external integrity key and rollback-resistant checkpoint must remain outside the database in production; this repository block does not define their production custody or recovery ceremony.

## Completion snapshot

A snapshot returns only:

- accepted independent review IDs;
- missing required verification scenarios;
- open finding IDs;
- current revision number; and
- `pending`, `changes_requested`, `verification_blocked`, `revision_limit_reached`, `ready`, or `superseded`.

Every snapshot says `requiresSeparateApproval: true`, `grantsApproval: false`, and `grantsExecutionAuthority: false`. It does not create a job, lease, reservation, dispatch, credential, node admission, attestation, effect claim, or external effect.

## Deferred to later CR-8 slices

- Exact owner step-up service and attestation issuance/consumption.
- Risk-policy evaluation and narrowly permitted automatic low-risk disposition.
- Completion Gate views, evidence/media/diff/report previews, and finding/revision UI.
- Telegram presentation and callback security.
- Node-local secret brokers and live canary drills.
- Protected production API, identity deployment, integrity-key and rollback-checkpoint custody, checkpoint provisioning/recovery, and owner-controlled services.

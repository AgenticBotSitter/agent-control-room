# CR13A-LIVE-450 — Private Observation-to-Attestation Pipeline Design

**Status:** independently accepted for architecture-only integration

**Accepted target policy product:** `6e716bd77c26ad7f70343ddd687dff990f5db12f`

**Accepted target policy tree:** `4010bdaa5fd90f486d7ccad6185a2116dd9345af`

**Accepted target policy review SHA-256:**
`483ab05695b5cecaa6fe02ca4cc63b2e640733ac42270e2a435364c6be0ea6d8`

**Accepted LIVE-430 product:** `a1c3230d4589ce72248038e722ccd4fd8600e9ee`

**Accepted LIVE-430 tree:** `03f778c35ef97a4335e888a3bcc192e3b5a4745d`

**Accepted LIVE-430 review SHA-256:**
`354e84ee68e1c1a202b738e0879070d6d449a268bbf001104eda4bdb246d0d0b`

**Accepted LIVE-440 architecture:** `711d4fc67f9e27f52553fd63152188203b173a9d`

**Accepted LIVE-440 tree:** `b5186bb238baf37fc23a9443824ed9b8c05f0124`

**Accepted LIVE-440 design SHA-256:**
`8c01036039e2a1a819968960fd87e2a0a3e4c960a70a905ec4d769e9b8b117ff`

**Accepted LIVE-440 review SHA-256:**
`e53ec53383720fe5e58d6cff5d23a572620226ac07585f090507fb2c06c3c518`

**Required model / effort:** `gpt-5.6-sol` / `xhigh`

**Effect boundary:** repository documentation only; no contract/source/provider implementation, native import or
invocation, host observation, key access, signing, database or high-water activity, network, deployment, DNS, or
production effect

## Purpose and hard conclusion

LIVE-450 freezes the private destination that must exist before the accepted LIVE-440 source may ever be read. The
existing eight-value source is necessary but cannot establish all fourteen accepted LIVE-140 claims. Five separate
private providers are mandatory: running executable content, exact OS boot session, high-entropy attestor process
session, running qualification harness artifact, and running physical driver artifact. None may be inferred from a
path, version, PID, wall time, uptime, checkout, declared release, or public file digest.

This design separates repository implementation authority, owner-native-execution authority, one-use invocation
authority, private attestation acceptance, candidate assembly, physical qualification, and activation. Passing any
one boundary grants none of the others.

## Authority separation and exact-product attempt ceiling

An accepted repository product authorizes only dormant code. Before a native source call, a separate one-use
`owner_native_execution_authorization` must be evaluated and consumed in addition to the broker's one-use invocation
authorization. It binds the exact:

- source-owner product and tree, dormant runner product and tree, construction capsule, all five provider products,
  privacy transform, signer, cleanup observer, ledger writer, high-water adapter, verifier, policy, and contract;
- tenant, project, connection, node, candidate proposal, attempt, operation, trusted time window, and use counts; and
- required cleanup facts, cleanup deadline, final review class, and prohibited effects.

The durable owner ledger enforces at most one native attempt for an exact source-owner-product/runner-product pair.
A diagnostic consumes that pair. A later real attestation requires a separately reviewed and accepted superseding
product pair; it is never a retry. Failure or uncertainty after either authorization may have committed closes the
product attempt. A proven no-commit result permits only a newly evaluated authorization; the same authorization is
never reused.

## Module-owned construction capsule

Before either authorization is spent, one production-only module-owned capsule must resolve and seal the exact source,
store, policy, contract, one-use privacy transform/key, platform signer/key, five supplementary providers, PostgreSQL
writers, high-water compare-and-swap adapter, private verifier, and cleanup observer/signer/key. The capsule returns no
capability, callback, raw value, key, signer, database handle, checkpoint handle, or dependency to its caller.

The existing accepted direct module factory may start the capsule only with accepted protected authorization and
database identities. The caller cannot inject or select source, raw data, provider, signer, privacy operation, key,
clock, nonce, database, checkpoint, callback, serializer, or dependency. Production, privacy, platform-signature,
provider, cleanup, authorization, TLS, node-channel, owner, and deployment keys are pairwise distinct, with exact
purpose, rotation, expiry, and revocation rules. The one-use privacy operation and its key are pre-resolved before
spend and their references are released before the first post-source `await`.

## Required supplementary provider lanes

Each provider is a separately accepted module-owned one-use lane with five non-collapsible steps: preflight before
owner spend; one synchronous invocation after source intake; exact result validation; protected transformation and
immediate raw/reference release; and binding of the exact protected result to the private payload.

| Provider | Required private fact | Forbidden substitute |
| --- | --- | --- |
| executable content | identity of bytes of the running executable under verified file identity and ownership | path, runtime version, checkout, or public digest alone |
| OS boot session | exact accepted platform boot/session identifier | wall time minus uptime |
| attestor process session | harness-minted high-entropy process-session epoch | PID, parent PID, start wall time, or uptime |
| qualification harness | identity of the running independently signed immutable harness artifact | requested release, repository checkout, or source tree alone |
| physical driver | identity of the running independently signed immutable driver artifact | declared build, source tree, or file name alone |

Each lane freezes its module identity, result schema, validation, transform domain, privacy key revision, use ceiling,
failure mapping, cleanup obligation, and review product. A lane cannot be folded into the eight-operation source or
called by ordinary repository tests.

## Exact execution and attestation stages

These 36 stages form the attestation subpipeline. Candidate assembly and activation are inherited successors, not
attestation stages. `candidate_proposal_id` is inert context and is not an assembled candidate.

1. Verify exact accepted policy, contracts, source/runner/capsule, provider, signer, persistence, verifier, cleanup,
   and review products and trees.
2. Construct the production-only module-owned capsule and prove all one-use dependencies and pairwise-distinct keys
   are available without exporting them.
3. Preflight the running-executable-content provider and reserve its one use.
4. Preflight the OS-boot-session provider and reserve its one use.
5. Preflight the attestor-process-session provider and reserve its one use.
6. Preflight the running-harness provider and reserve its one use.
7. Preflight the running-driver provider and reserve its one use.
8. Preflight and reserve the after-exit cleanup observer, exact product/key, attempt, process/root/resource set,
   attestation linkage, deadline, required facts, and one use.
9. Durably reserve private context: fresh nonce, trusted database time window, provisional acceptance reference,
   expected ledger head/revision, and expected independent high-water state.
10. Consume the separate owner-native-execution authorization and durably close the exact product-pair attempt slot.
11. Spend the broker's one-use invocation authorization.
12. Immediately recheck owner authorization, context expiry, policy/product/key state, ledger head, and high-water
    expectation against trusted database time.
13. Finalize the exact context synchronously, binding only the fresh spend/recheck object identities.
14. Perform the accepted exact private module-keyed source lookup.
15. Invoke that source synchronously exactly once, with no receiver and no arguments.
16. Validate the exact raw source result under LIVE-440 descriptor, prototype, key, symbol, string, finite-number, and
    safe-integer rules, without coercion, getter, Proxy trap, ambient method, or second read.
17. Apply the pre-resolved one-use keyed privacy transform synchronously under exact field domains.
18. Bind the exact transformed source result to finalized private context.
19. Clear source, raw, privacy operation, key, and intermediate lexical references immediately before any provider
    call or post-source `await`; outer `finally` cleanup remains defense in depth without claiming zeroization.
20. Invoke, validate, transform/release, and bind the executable-content provider exactly once.
21. Invoke, validate, transform/release, and bind the OS-boot-session provider exactly once.
22. Invoke, validate, transform/release, and bind the attestor-process-session provider exactly once.
23. Invoke, validate, transform/release, and bind the running-harness provider exactly once.
24. Invoke, validate, transform/release, and bind the running-driver provider exactly once.
25. Seal the private canonical payload containing all fourteen claim dispositions and five protected provider-result
    digests, with no raw observation or stable cross-attempt identifier.
26. Recheck trusted database time, nonce, policy/products, every key revision/status, ledger head, and high-water state
    after all transformations and before signing.
27. Sign the complete canonical envelope with the exact one-use platform evidence signer.
28. Privately verify canonical encoding, signature, products, claims, transformations, time, nonce, lineage, and
    expected persistence state before any append.
29. Append `attestation_pending_anchor` to PostgreSQL with exact prior/desired ledger and high-water values.
30. Issue the exact idempotent independent high-water compare-and-swap request.
31. Reconcile and finalize `attestation_checkpointed_pending_cleanup`, or a terminal state, from exact durable facts.
32. Terminate the disposable process and release every process-scoped handle.
33. After exit, run the reserved cleanup observer once and obtain its exact separately signed result.
34. Append cleanup pending state, advance its high-water anchor, and reconcile/finalize it under the same split-commit
    rules.
35. Append final acceptance and release the provisional private acceptance reference only when attestation, anchor,
    cleanup, and both exact reconciliations are accepted.
36. Submit sanitized evidence for a different independent report-only review; review cannot rewrite durable state.

Only after those stages may separate successors assemble a candidate, obtain a fresh owner physical-execution
authorization, attempt physical qualification, collect its cleanup evidence, receive independent review, and activate
the candidate. Each successor receives new authority and can fail without changing attestation history.

## Raw privacy and canonical envelope

Raw values never enter errors, logs, public results, database rows, high-water storage, evidence files, snapshots, or
test output. A transform may emit fixed policy conclusions, fresh-attempt domain-separated keyed commitments, and an
internal private payload digest. No public consumer receives commitments or a verifier oracle.

The canonical envelope codec rejects unknown, duplicate, missing, reordered, non-canonical, or differently encoded
fields. The signed bytes include exactly:

- codec, envelope, privacy, signature, claim-set, and attestation versions and algorithms;
- tenant, project, connection, node, platform, runtime, operation, candidate-proposal, and attempt identities;
- owner-native and invocation authorization IDs plus canonical authorization-body digests;
- exact products, trees, review digests, and release identities for source, runner, capsule, five providers, privacy
  transform, signer, cleanup, ledger, high-water, verifier, policy, and contract;
- signer key ID, fingerprint, and revision; privacy domain/key ID digest and revision;
- all fourteen claim dispositions and all five protected provider-result digests;
- trusted observed/expiry values and attestation nonce digest;
- prior/desired ledger heads and revisions, expected high-water state, and exact compare-and-swap request ID; and
- the private payload digest over protected claims/commitments only, followed by the signature over the entire
  canonical unsigned envelope.

The fourteen claim dispositions appear in the exact LIVE-140 order and spelling:
`platform_family`, `architecture_class`, `runtime_semantic_version`,
`runtime_executable_content_identity`, `operating_system_boot_epoch`,
`attestor_process_session_epoch`, `qualification_harness_identity`,
`accepted_physical_driver_build_identity`, `qualification_candidate_identity`,
`qualification_attempt_identity`, `fresh_request_nonce`, `trusted_observed_and_expiry_time`,
`platform_signer_key_identity_and_signature`, and `monotonic_acceptance_checkpoint_identity`. No aggregate or renamed
claim may replace one of those entries.

No raw value, path, PID, hostname, username, public stable host digest, secret, private key, or provisional acceptance
reference is part of a public projection.

## Trusted time, nonce, privacy, and key lifetime

Production trusted time and nonce reservation come from the sole authoritative PostgreSQL transaction. Local PGlite
and fixed time are tests only. The private context lives no more than 60 seconds from reservation through signature.
The nonce is high entropy, fresh, one-use, and domain-separated from both authorization nonces.

All provider and source transforms use fresh attempt material and pairwise-distinct field domains so equal host values
cannot be correlated across attempts. Privacy operations and keys are pre-resolved before authorization spend and
released before the first post-source asynchronous boundary. Provider raw/result references are released immediately
after their synchronous transform. The stage-26 recheck uses trusted database time and confirms all key revisions,
expiry, and revocation state after transformation and before signing.

## Durable states and writer ceilings

PostgreSQL is the sole global write authority. The independent high-water store contains only an authenticated
monotonic revision and ledger-head digest; it cannot claim, approve, schedule, coordinate, or store business state.
Distinct narrowly scoped database identities enforce these ceilings:

- the context writer may create only `context_reserved`, owner-spend, and invocation-spend facts;
- the pending writer may append only predetermined attestation/cleanup pending records;
- the finalizer may finalize only the exact pending record and matching high-water receipt; and
- the recovery reconciler may read exact state and append only a predetermined recovery terminal/finalization record.

No identity may perform the other's transition. Durable states are:

`context_reserved`, `owner_spent`, `invocation_spent`, `attestation_pending_anchor`,
`attestation_checkpointed_pending_cleanup`, `cleanup_pending_anchor`, `target_runtime_attestation_accepted`,
`terminal_rejected`, and `terminal_ambiguous_reconciliation_required`.

Every pending append records its exact prior/desired ledger heads and revisions, expected and desired high-water
revision/head digest, idempotent CAS request ID, writer identity, use ceiling, predetermined success state,
predetermined failure state, and acceptance-reference ciphertext/digest. The provisional acceptance reference remains
encrypted and private until final acceptance; rejection destroys its release path.

## Exact split-commit recovery matrix

Recovery never calls the source or any supplementary provider and never creates new attestation content. It reads the
exact PostgreSQL row and high-water receipt/state under the recovery identity:

| PostgreSQL fact | High-water fact | Required result |
| --- | --- | --- |
| no context reservation | exact old state | a new attempt may start only under separately evaluated fresh authorizations |
| reservation result was unknown, but exact row exists | exact old state | append terminal tombstone; never resume or reuse either authorization |
| exact pending row exists | exact old state | reissue only the same idempotent CAS request ID; conflict rejects, unknown remains ambiguous |
| exact pending row exists | exact desired state and matching receipt | idempotently finalize the predetermined next state |
| exact finalized row exists | matching exact desired state | return the durable state without a write or native action |
| accepted row exists | old, wrong, or missing exact high-water state | quarantine as rollback/tamper; never recreate acceptance |
| terminal row exists | exact desired state | preserve terminal state and append only its predetermined reconciliation link |
| no exact row exists | high-water is ahead | quarantine as deletion/fork/tamper |
| database head is ahead without the exact pending row | high-water old or different | quarantine as deletion/fork/tamper |
| CAS return is unknown | any unproven state | append/retain ambiguous state; later read-only reconciliation may query only the same request ID |

The same matrix applies to the cleanup anchor. If a finalizer return is uncertain after high-water committed, recovery
may idempotently finalize only the exact predetermined state already named in the pending row. It may never recompute,
reinterpret, resign, re-observe, reissue under a different request ID, or turn a terminal result into acceptance.

## Cleanup and final acceptance

The cleanup observer is reserved before owner spend and bound to the exact product/key, candidate proposal, attempt,
process identity, disposable root, enumerated resources, attestation envelope, deadline, and required facts. It runs
only after the disposable process exits and signs exactly these bounded observations:

- qualification process absent;
- descendants absent;
- listeners and enumerated resources absent;
- temporary database closed;
- disposable root absent; and
- bounded residue scan clean.

Cleanup uses a key distinct from the platform signer and cannot attest to observation content. Failure, deadline
expiry, signature uncertainty, missing fact, or split-commit uncertainty is terminal nonacceptance. Attestation-stage
acceptance remains provisional until the signed cleanup envelope, cleanup anchor, and database finalization all match.
Only then may stage 35 release the already reserved private acceptance reference.

## Terminal public outcomes

Private rows preserve the exact cause. Public projections expose only:

- `rejected_before_spend`;
- `terminal_owner_authorization_spent_or_uncertain`;
- `terminal_invocation_authorization_spent_or_uncertain`;
- `terminal_recheck_or_context_finalization_failed`;
- `terminal_source_lookup_failed`;
- `terminal_source_invocation_failed_or_uncertain`;
- `terminal_source_raw_validation_failed`;
- `terminal_source_intake_failed`;
- `terminal_supplementary_provider_failed_or_uncertain`;
- `private_evidence_pipeline_failed_or_uncertain`; or
- `private_target_runtime_attestation_accepted_for_exact_candidate_proposal_only`.

Raw validation and protected intake remain distinct transitions. A proven pre-commit rejection maps to
`rejected_before_spend`; it does not permit reuse, only a newly evaluated authorization. All post-spend failure or
uncertainty is terminal. Final acceptance clears only `target_runtime_attestation_missing` for one exact inert
candidate proposal. It grants no candidate assembly, physical qualification, listener, activation, command, lease,
execution, deployment, network, provider, production, or retry authority.

## Qualification classes and exact-product consequence

`local_native_diagnostic_only` may use local PGlite, repository fakes, no network, and no production service. It proves
only bounded behavior and clears no blocker, but its one source invocation consumes the exact accepted source/runner
product pair. Therefore a later real attempt must use a separately reviewed superseding pair. If preserving the pair
for real qualification is preferable, the diagnostic must be omitted.

`real_target_runtime_attestation` requires a superseding accepted product pair plus accepted real PostgreSQL writers,
protected keys, five providers, independent high-water custody, verifier, cleanup observer, and deployment products.
Its fresh owner packet may authorize only the narrowly required private connection and host providers. Neither class
may reuse an authorization, nonce, context, candidate/attempt, envelope, source read, provider read, cleanup record,
or acceptance reference.

## Deterministic repository verification

An inert contract may export only frozen policy, stage, state, blocker, outcome, zero-use, safe-error, and parser
records. It imports no native source/provider, signer, key store, database, checkpoint, or runtime consumer.

Later dormant tests must enter only through LIVE-440's direct-module fixed-scenario enum. The module mints all safe
synthetic raw and stage records, fixed time, fake keys, PGlite state, provider results, and high-water results. The
caller cannot provide a source, raw value, provider, signer, privacy operation, key, database, checkpoint, callback,
serializer, dependency, failure object, or arbitrary scenario contents. Tests cover every stage, owner/product
ceiling, fault, replay, concurrency, expiry, key change, rollback, deletion, fork, split commit, hostile input, cleanup,
and recovery row without importing or invoking a real native module.

The production construction capsule is inaccessible from the test seam and cannot be constructed or invoked by a
test. Production modules remain dormant until separately accepted native-execution work.

## Prohibited in LIVE-450

LIVE-450 must not implement a contract, source, capsule, provider, transform, signer, writer, checkpoint, verifier, or
cleanup observer; import or modify the source-owning module; call a source/provider; inspect a descriptor; read process,
OS, filesystem, executable, boot, session, host, path, environment, clock, credential, or key values; issue a real
nonce; sign; write PGlite/PostgreSQL/high-water state; access Keychain; create raw observation data; add a migration;
wire application, API, worker, scheduler, Idea Lab, Hermes, startup, or production use; contact a provider or VPS; open
a listener/network path; deploy; change DNS/hosting; clear a blocker; or grant authority.

## Architecture acceptance

Acceptance requires exact LIVE-140/LIVE-430/LIVE-440 binding; acknowledgement that eight source values do not satisfy
fourteen claims; separate owner-native authorization and exact-product attempt ceiling; the production-only capsule;
all five ordered provider lanes; all 36 attestation stages plus separate inherited successors; pre-resolved privacy
operation/key and post-transform trusted-time/key check; complete canonical signed envelope; separate raw validation
and intake; PostgreSQL as sole global authority; distinct writers; exact pending/CAS/receipt states and recovery matrix;
pre-reserved after-exit cleanup; complete terminal mapping; direct-module fake-only verification; zero current effects;
and a different independent report-only architecture review.

Acceptance freezes design only. It grants no implementation, provider, source call, native attempt, raw data, clock,
nonce, key, signer, database/checkpoint write, attestation, cleanup action, blocker clearance, candidate assembly,
physical qualification, activation, production contact, deployment, hosting, or DNS authority.

## Reevaluate

Reevaluate before implementing the inert contract, production capsule, privacy transform, any supplementary provider,
signer/key store, PostgreSQL/high-water/cleanup adapter, source-owner modification, source invocation, or native
qualification evidence.

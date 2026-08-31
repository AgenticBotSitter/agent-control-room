# CR-9A Content Blooms placement-request contract

**Status:** Frozen for effect-free repository implementation
**Contract:** `control-room-content-blooms-placement/v1`
**Core command:** `setWorkerPreference`
**Live connector and command dispatch:** Disabled

## Purpose

Content Blooms may later accept one narrowly bounded request to prefer a verified transcription route. That request is not a Control Room assignment, lease, retry, start, or domain transition. Content Blooms remains the scheduler and decides whether the current source work item is eligible and whether the preference can be recorded.

This contract defines the evidence and failure rules that CB-060 must implement before any command transport can exist. The repository code creates and validates local JSON records only. It has no Content Blooms endpoint, credential, client, network path, source database, command runner, native process, or external effect.

## Reviewed declaration

One independently reviewed declaration binds one Content Blooms scope and one accepted read release to:

- the core `setWorkerPreference` command name;
- the source operation `request_transcription_route_preference`;
- the fixed logical destination `content-blooms:source-scheduled`;
- exact command, source-receipt, conformance, Completion Gate, review, and completion evidence digests;
- a minimum `medium` risk and mandatory strong factor;
- stable source idempotency-key echo;
- current lifecycle revalidation, a durable effect claim, and a pre-effect marker; and
- literal denials of approval, network, command, lease, and execution authority.

The declaration does not change the read release's zero-command posture and does not activate a connector. Its acceptance records must be resolved from their authoritative stores before later use.

## Placement request

A placement request binds the exact:

- tenant, workspace, project, adapter, declaration, and active read release;
- adapter lifecycle revision and lifecycle digest;
- job, attempt, and effect-intent identity;
- transcription work-item source ID, source version, source checksum, and record digest;
- route-comparison digest plus one exact eligible route ID and observation digest;
- route-evidence validity window;
- bounded reason code, actor digest, request time, and expiry; and
- `medium` risk, strong-factor requirement, destination, idempotency key, and operation digest.

The selected route may be any eligible route from the exact comparison; it need not be the first-ranked route. This allows an authorized human preference without pretending the comparison assigned work. A rejected, offline, unverified, expired, cross-scope, or digest-different route cannot enter a request.

The source idempotency key is deterministic over the effect identity, lifecycle, expected source truth, and selected route. Changing a request ID, reason, actor, or time around the same effect cannot create a second semantic command: the stable key conflicts unless the whole durable request is exact replay. A new source version, adapter lifecycle, job attempt, or effect intent produces a new effect identity and requires a new request.

## Lifecycle invalidation

Content Blooms adapter control state now carries a separate lifecycle revision. Enable, disable, upgrade, and rollback increment it and record before/after lifecycle digests in the transition receipt. Ordinary read high-water commits keep it unchanged.

This separation prevents an unrelated successful read from cancelling a pending placement request while ensuring that disable, re-enable, upgrade, or rollback invalidates every earlier request and approval. A disabled adapter fails before any source invocation. Re-enabling the same release does not resurrect old placement authority.

## Approval binding and pre-dispatch gate

A placement authorization binds the exact request to the authoritative CR-8 Completion Gate approval request and approved strong-factor human decision. The approval request must bind the same tenant, project, job, attempt, effect intent, operation digest, and `medium` risk. The decision must bind the exact approval-request digest and expire no later than the approval request, placement request, or route evidence.

The authorization record does not create or carry execution authority. Before a later dispatcher can cross an external boundary it must still:

1. resolve the declaration, read release, lifecycle state, approval request, and approval decision from protected authoritative stores;
2. verify the current lifecycle exactly matches the placement request;
3. verify time is strictly before every expiry;
4. consume the separately trusted node approval attestation required by CR-5C;
5. durably claim the exact effect and serialize its idempotency key; and
6. persist the complete pre-effect marker immediately before transport.

The repository pre-dispatch function checks contract consistency only. Its output continues to say that it grants no network, command, lease, or execution authority.

## Source receipts

An authenticated source response normalizes to one of three dispositions:

- `accepted`: Content Blooms recorded the preference and returned a new source version;
- `already_applied`: Content Blooms confirmed the same stable idempotency key was already applied; or
- `rejected`: Content Blooms refused the request with one bounded safe code.

Every source receipt echoes the exact stable idempotency key and binds the request, authorization, operation, selected route, expected source version, dispatch claim, pre-effect marker, authenticated transport evidence, dispatch time, source observation time, and receipt time. Claim, marker, and transport evidence digests must be distinct and must later resolve from protected stores. A stale-version rejection carries only a digest of the newly observed source version, not source content.

No source receipt claims that Control Room leased or started work. Accepted and already-applied receipts say only that a source preference was recorded. Rejected receipts do not mutate the local request into a new source version or route.

## Honest ambiguity and replay

If transport crossed the pre-effect marker but no authenticated source receipt proves the outcome, the result is `ambiguous`. The ambiguity receipt binds distinct claim, marker, and ambiguity-evidence digests and states all of the following literally:

- no source receipt was observed;
- automatic retry of the same effect is prohibited;
- source reconciliation is required; and
- any genuinely new effect requires a new request and authorization.

An ambiguous result cannot be overwritten by a later accepted-looking receipt under exact replay rules. A protected implementation may settle it only by resolving authoritative source evidence against the same idempotency key; it may not blindly dispatch again.

## Exact input and redaction

All declaration, request, authorization, receipt, ambiguity, replay, and binding operations accept exact ordinary JSON only. Proxies, accessors, prototype drift, extra fields, unsafe strings, secret-shaped values, scope drift, digest drift, correlated review, ineligible routes, stale lifecycle, under-classified risk, weak or denied approval, expiry equality, wrong source idempotency echo, correlated evidence digests, and detached re-digested outcomes fail closed with bounded safe codes.

## Explicitly deferred to CB-060 or later

- durable placement declaration, request, approval-binding, claim, marker, outcome, and tombstone storage;
- an injected fake command source and bounded command adapter;
- authoritative Completion Gate and node-attestation resolution;
- authenticated Content Blooms transport and endpoint identity;
- credential and secret-provider integration;
- live source reads, writes, placement, scheduling, or lease behavior;
- retry/reconciliation polling and operator ambiguity resolution;
- production deployment, monitoring, rollback, or cleanup; and
- any native, network, provider, source, or consequential external effect.

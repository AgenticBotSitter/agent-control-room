# CR9B-WF-040 Wayfarer storage security contract

**Status:** Accepted for the exact effect-free local implementation
**Contract:** `control-room-wayfarer-storage/v1`
**Scope:** Logical local/R2 identities, immutable object identity, private locator custody, capacity proposals, lifecycle, retention, quarantine, cleanup, retry, and ambiguity
**Not authorized:** Filesystem access, R2 access, credentials, locator resolution, object writes, deletion, network, upload, publication, native tools, or deployment

## Boundary

This block defines what a future Wayfarer storage adapter must prove. It does not contain an adapter and cannot access either storage class. All accepted outcomes are deterministic evaluations of injected metadata.

The two logical stores are fixed as:

| Store | Class | Logical namespace | Credential binding | Current state |
|---|---|---|---|---|
| `store:wayfarer:local-private:v1` | `local_private` | `namespace:wayfarer:local-artifacts:v1` | none at this layer | unconfigured and ineligible |
| `store:wayfarer:r2-private:v1` | `r2_private` | `namespace:wayfarer:r2-artifacts:v1` | owner-configured broker-private | unconfigured and ineligible |

These are logical identities, not paths, buckets, accounts, endpoints, or credentials. Both stores are immutable, no-overwrite targets with exact digest and size verification. The contract itself sets filesystem and network access to false.

## Locator custody

Control Room retains only a digest reference scoped to `registry:wayfarer:private-locators:v1`. The private registry is a future protected boundary. This repository implementation never stores or resolves:

- local paths or directory roots;
- R2 bucket, account, endpoint, or region values;
- signed or presigned URLs;
- credential references or resolved credential material;
- object-key strings or artifact bytes.

A locator-reference digest is evidence of identity only. It grants no permission to resolve, read, write, move, quarantine, or delete an object.

## Immutable object identity

An artifact declaration binds the exact artifact ID, episode, role, content type, content digest, byte size, creation time, tenant, workspace, project, and Wayfarer pack digest. That material produces an artifact-identity digest.

The immutable object-key digest additionally binds the selected logical store. Therefore the same artifact has separate local and R2 plan, reservation, object-key, outcome, and retention identities. Changing the store or any artifact field changes those identities. Overwrite is never permitted.

The control plane receives no bytes. A capacity reservation is only a 15-minute proposal for one exact object and byte count. It does not acquire capacity and cannot write.

## Lifecycle

The allowed graph is deliberately incomplete:

```text
declared -> reserved -> write_marker_recorded -> stored_unverified
reserved -> released
write_marker_recorded -> ambiguous
stored_unverified -> verified | quarantined | ambiguous
verified -> quarantined | retention_candidate
quarantined -> verified | retention_candidate
retention_candidate -> cleanup_proposed
```

There is no `deleted` state and no transition from ambiguity back to a write attempt. A future real adapter must add separately approved effect, evidence, reconciliation, and deletion contracts rather than treating this graph as effect authority.

## Retry and ambiguity

One automatic retry is permitted only after an exact definite pre-marker failure, including capacity unavailability before the marker. The second pre-marker failure exhausts the retry ceiling.

Once the write marker exists:

- exact declared digest and size may produce a simulated verified result;
- a digest or size mismatch produces quarantine;
- unknown result or restart produces terminal ambiguity;
- no automatic retry is permitted;
- ambiguity requires authoritative reconciliation and cannot be cleared by another attempt.

The current evaluator transfers no bytes, resolves no locator or credential, and touches no filesystem, network, or object store.

## Retention and cleanup

The project pack remains the source of retention durations and clock types. A caller supplies a separate retention-clock evidence digest. The evaluator can produce only:

- `not_due` before the retention deadline;
- `blocked_by_legal_hold` whenever legal hold is active;
- `owner_review_candidate` when due and not held.

Every result requires owner review and independent evidence. Nothing is automatically scheduled, no proposal deletes an object, and legal hold always wins.

A cleanup receipt concerns only the synthetic attempt envelope. It records no remaining temporary object and a reservation disposition. It never resolves a locator, deletes an object, or serves as deletion evidence. Ambiguous reservations remain held for reconciliation.

## Implemented fake boundary

CR9B-WF-050/060/070 implement an injected metadata-only fake adapter, owner-facing media/review projections, and synthetic GPU/scratch-placement scenarios against this exact contract. They introduce no path, bucket identity, credential, native tool, network client, media bytes, or live effect. See `CR9B_WF_050_070_ACCEPTANCE.md`.

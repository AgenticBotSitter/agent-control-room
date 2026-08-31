# CR11B-AUTO-050 Protected Production Boundary Contract

Status: repository-only candidate; independent security and authority review required

Date: 2026-08-30

## Purpose

AUTO-050 converts the nine blockers in the accepted AUTO-040 activation packet into an exact production-proof contract.
It specifies how a later protected multi-process consumer, policy custodian, clock, database, reference broker, and
ambiguity reconciler must be qualified without implementing or activating any of them in this phase.

The candidate binds exact accepted AUTO-040 implementation commit
`fb549ebbcf5a2cbd9ca3d3cbef6842578e280074` and independent-review SHA-256
`bc1b02f52b68ad9ce836253eb890c4df561513eed158b8a7875de4c7200cde07`. It consumes only an authenticated,
digest-valid AUTO-040 activation packet. The packet remains blocked and cannot authorize this contract.

## Non-authority rule

AUTO-050 has no activation function, production consumer, database client, reference resolver, network client, process
launcher, provider adapter, deployment client, or policy-enrollment operation. It cannot accept caller-declared
`qualified` evidence. Every requirement emitted by this repository has status `unobserved`, a null evidence digest, and
`repositoryCanSatisfy: false`.

Repository code may describe a future proof. It cannot mint that proof, approve it, or convert it into production
authority.

## Exact plan

One production-boundary plan binds:

- the authenticated activation packet ID and digest;
- the accepted simulation run ID and digest;
- the accepted AUTO-040 implementation and review identities;
- all nine production gate codes in canonical order;
- a separate-service-principal consumer process;
- a mutually authenticated Ed25519 handoff protocol;
- one transactional owner for each handoff claim;
- hosted PostgreSQL as required but unconfigured;
- node-local reference resolution only;
- protected monotonic and database-boundary time evidence;
- owner-signed policy custody with an external high-water checkpoint; and
- destination evidence or a new owner-authorized action for ambiguity.

The plan is `defaultDisabled: true`, contains no production configuration or protected material, and states that no
consumer or policy is installed. Every permission and effect flag is false. Plan time must follow packet creation and
have a positive validity window of no more than one hour.

## Nine proof requirements

The exact ordered requirements are:

1. `ambiguity_reconciliation_unproved`: destination reconciliation must bind tenant, workspace, handoff, idempotency,
   destination evidence, and terminal disposition.
2. `consumer_channel_unqualified`: consumer qualification must bind the exact artifact, service identity, protocol,
   egress policy, cancellation contract, and signed receipt contract.
3. `credential_broker_unbound`: protected-reference custody must bind the reference, broker identity, node scope,
   operation digest, and proof that plaintext does not enter central state.
4. `hosted_postgresql_unqualified`: database qualification must bind topology, database identity, migration set,
   isolation level, backup/restore evidence, and the transaction boundary.
5. `multi_process_concurrency_unproved`: concurrency qualification must bind the test identity, process count, unique
   claim behavior, crash checkpoint, and replay result.
6. `production_clock_custody_unproved`: clock custody must bind source identity, monotonicity, skew policy, commit
   boundary, and expiry behavior.
7. `production_independent_review_missing`: a different reviewer must bind the exact candidate commit, contract,
   tests, reviewer identity, and disposition.
8. `production_owner_approval_missing`: fresh strong owner approval must bind the plan, assessment, nonce, issue and
   expiry times, and strong-factor evidence.
9. `production_policy_custody_unproved`: policy custody must bind revision, predecessor, owner signature, external
   high-water checkpoint, effective time, and expiry.

Each requirement has one fixed evidence class and proof authority. Gate omission, reordering, substitution, added
fields, or digest drift fails closed. Eight gates require a separate independent verifier; owner approval is itself
issued by the distinct owner-approval authority and cannot be issued by AI review.

## Assessment and disabled disposition

The repository assessment always reports:

- state `blocked_design_only`;
- all nine gate codes blocking;
- nine remaining proofs;
- no eligibility for owner approval or activation;
- a required new production-evidence assessment;
- a required independent security review and fresh strong owner approval; and
- zero approval, activation, claim, lease, dispatch, execution, or effect authority.

The resulting disposition is `disabled_before_consumer_construction`. It records that no production configuration was
read, no database or network was contacted, no protected reference was resolved, no consumer was constructed, no handoff
was consumed, no claim or lease was attempted, no agent or provider was contacted, no deployment was attempted, and no
external effect occurred.

The safe projection contains only tenant/workspace, plan/assessment identities, the nine safe gate codes, the remaining
proof count, and false capability flags. It cannot contain protected material or an operational control.

## Reconciliation state machine

AUTO-050 includes a pure decision table, not a consumer. It describes these allowed transitions:

- `pending` plus `claim_acquired` to `claimed`;
- `claimed` plus `definite_precontact_failure` to `failed_before_contact`;
- `claimed` plus `delivery_marker_written` to `delivery_started`;
- `delivery_started` plus `post_marker_unknown` to `ambiguous`;
- `delivery_started` or `ambiguous` plus qualified destination confirmation to `confirmed`;
- `delivery_started` plus a qualified destination-absence observation to `ambiguous`; and
- `ambiguous` plus a separate independent destination-absence confirmation to `reconciled_not_delivered`.

All permitted transitions require a protected database transaction. Destination conclusions require qualified destination
evidence. `ambiguous` and `reconciled_not_delivered` require a new owner-authorized action before any retry. The decision
table always reports `automaticRetryAllowed: false`, performs no consumer action, and contacts no destination.

No transition leaves a terminal state. No event before a durable delivery marker may be represented as a post-marker
unknown. Destination absence immediately after a marker cannot authorize a retry; it first becomes ambiguity.

## Hostile boundary

The candidate must prove:

- exact packet authentication and chronology;
- all nine fixed requirements and canonical ordering;
- caller-declared qualified evidence cannot enter the assessment;
- plan, assessment, requirement, disposition, decision, and projection digests detect drift;
- accessors and Proxies reject without executing callbacks or traps;
- every post-marker unknown is non-retriable;
- impossible and terminal-state transitions remain inert;
- the safe projection rejects protected or credential-shaped fields; and
- the implementation imports no runtime database, filesystem, process, network, delivery, or dispatch client.

## Stop boundary

AUTO-050 does not prove or perform production policy enrollment, hosted-database qualification, multi-process execution,
clock or key custody, protected reference resolution, consumer construction, destination reconciliation, approval,
scheduling, claims, leases, agent messages, GitHub mutation, dispatch, execution, recurrence, DNS, Cloudflare, hosting,
deployment, or external effects.

An independent review may accept only this exact default-disabled repository design. A later implementation that adds a
real production verifier, evidence store, consumer, database, broker, process, network, policy enrollment, owner-decision
ingress, or activation path is a new security block and requires fresh owner authority and proportionate review.

# CR11B-AUTO-110 PostgreSQL Rehearsal Contract

Status: owner-directed, effect-free repository candidate; independent review pending

Date: 2026-08-31

## Purpose

AUTO-110 converts the owner's direction to begin the PostgreSQL rehearsal phase into a strict controlled-effect request.
It does not reinterpret a conversational direction as permission to contact the VPS, resolve protected references, start
processes, connect to PostgreSQL, write a migration, run backup or restore work, or deploy Control Room.

The request binds the independently accepted AUTO-100 implementation and review, embeds and re-verifies one exact
AUTO-100 readiness packet and disabled disposition, and carries all 36 unresolved live-production gate keys forward.

## Two distinct owner gates

The request records `phasePreparationAuthorized: true`. That means Codex may prepare, test, document, and independently
review the AUTO-110 packet.

The same request fixes all live-effect fields to false. A future effect window requires a fresh exact owner decision with
a strong factor, the protected host reference and access path, the precise allowed operations, current start and expiry,
an effect-scoped claim and pre-effect marker, rollback material, separately authorized cleanup, and accepted independent
review. General chat authorization, a digest of that direction, repository evidence, or this packet cannot substitute
for those items.

## Requested bounded rehearsal

The proposed rehearsal has one ordered ten-stage envelope:

1. verify the protected host identity;
2. verify the private-network boundary;
3. observe PostgreSQL runtime state;
4. verify role and credential-reference custody;
5. verify backup and WAL configuration;
6. run a disposable non-production restore;
7. verify migration compatibility;
8. verify health and resource headroom;
9. collect sanitized evidence; and
10. clean up disposable resources.

The maximum requested envelope is one native attempt, one host session, four database sessions, 1,800 seconds, and
1,048,576 bytes of sanitized evidence. Production data, a public database endpoint, writes to an existing production
schema, raw-evidence retention, automatic retry, service installation, and service control are excluded. Rollback is
mandatory. Cleanup is mandatory, separately authorized, and receipt-backed.

The envelope is a request, not a runner. If PostgreSQL is absent, access is unsafe, a reference cannot be resolved, any
gate is missing, the time window expires, or any result becomes ambiguous, the attempt remains stopped. It does not
install or start PostgreSQL and does not retry.

## Exact source binding

The request pins accepted AUTO-100 implementation
`34750ed8ec5cf34134d166505f3df50897afe3f7` and accepted review SHA-256
`aa2116b832ed6e5587c72705dcf6dc826f8ef0e7201c5b284c7876b93f53c0a9`.

It embeds the complete readiness packet and disabled disposition, re-runs their exact parsers, binds all four source IDs
and digests, and preserves the 36 blocker keys in their canonical order. Source substitution, re-digested identity drift,
stage or blocker reordering, false authority, and cross-request disposition or projection reuse fail closed.

The owner phase-direction record contains only a digest and time. Raw conversation, host identity, hostname, address,
port, username, protected locator, credential reference, credential value, connection string, or deployable
configuration is forbidden from the request and projection.

## Safe disposition and projection

Until every live prerequisite and the exact effect window exist, the only disposition is
`disabled_before_protected_reference_resolution`. It records that no reference, host, process, database, migration,
backup, restore, cleanup, consumer, deployment, raw evidence, or external effect was touched.

The safe operator projection shows the Hostinger target, preparation authorization, blocker count and keys, requested
attempt and time ceilings, and false capability flags. It cannot resolve a protected reference or initiate an operation.

## Architecture retained

- one self-managed private PostgreSQL primary on the Hostinger KVM2 VPS remains the sole global write authority;
- database access remains host-local/loopback or private-network only;
- AWS RDS remains excluded;
- PGlite remains local-development/test-only; and
- R2 remains artifact/backup storage, never transactional or coordination state.

## Negative authority

AUTO-110 contains no host, process, network, database, credential, provider, deployment, DNS, or service-control client.
The repository candidate performs no native attempt and grants no approval, claim, lease, dispatch, execution,
deployment, consumer activation, or external-effect authority.

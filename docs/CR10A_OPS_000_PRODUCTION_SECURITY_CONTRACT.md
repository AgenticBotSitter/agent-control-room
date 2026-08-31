# CR10A-OPS-000 production operations security contract

**Status:** Complete for the value-free, effect-free local contract
**Date:** 2026-08-29
**Authority:** Architecture and security boundary only; this document grants no deployment, network, host, database, backup, restore, or service-control authority.

## Outcome

Control Room now has an exact production-candidate operating model before any production values or machinery are introduced. The contract fixes the service boundaries, allowed communication paths, release identity, deployment gates, health evidence, backup identity, recovery ordering, and rollback rules. Every record is strict, digest-bound, secret-rejecting, and explicitly non-authorizing.

The selected architecture is a single-host modular monolith behind a protected edge. PostgreSQL is the only global write authority. Nodes connect outbound through the protected edge and are never exposed as inbound listeners. Approved object storage holds immutable artifacts, backups, and audit anchors; it is never a queue, lock, scheduler, or coordination database.

## Exact service identities

The production candidate contains seven roles. Every role receives a distinct derived operating-system principal and a distinct artifact identity. Shared operating-system principals, root operation, host administration, public listeners, and direct node listeners are forbidden.

| Role | Lifecycle | Trust zone | Permitted responsibility |
|---|---|---|---|
| Edge connector | Steady state | Edge | Protected owner and node ingress; local handoff to the application |
| Control Room application | Steady state | Application | Authenticated control-plane work and ordinary application database mutations |
| Migration runner | One-shot owner window | Operations | Forward-only schema and data migration under a separate principal |
| PostgreSQL primary | Steady state | Data | Sole durable global write authority |
| Backup controller | Steady state | Operations | Database reads and encrypted archive writes only |
| Audit anchor | Steady state | Operations | Audit reads and external immutable anchor writes only |
| Operations observer | Steady state | Operations | Read-only independent health observation |

Only the migration runner may mutate database schema. Its identity is not the application identity, and its lifecycle is a one-shot owner window rather than a permanent service.

## Exact communication boundary

Fifteen flows are allowed: owner browser to protected edge; outbound node bridge to protected edge; edge to application; application to PostgreSQL and approved object storage; migration runner to PostgreSQL; backup controller to PostgreSQL and object storage; audit anchor to PostgreSQL and object storage; and five read-only observer flows to the edge, application, migration runner, PostgreSQL, and backup controller.

Every flow requires exact peer identity. Redirects, wildcard destinations, undeclared flows, raw address storage, and network authority inferred from the record are forbidden. The contract contains no hostnames, addresses, ports, credential values, or deployable configuration.

## Immutable release and deployment admission

A release candidate is reference-only. It binds the application, migration, public asset, schema, configuration, provenance, software bill of materials, signature, source, and build identities. It contains no artifact bytes, locator, command, environment value, credential material, or effect authority.

A deployment plan binds exactly one topology and one release. Its strategy is one-host canary followed by a fresh owner promotion decision. Database migration is forward-only and runs separately. Automatic promotion, automatic rollback, down migration, retry after change, service control, configuration changes, network changes, and database changes are absent from the plan.

All eighteen ordered gates must be current and independently evidenced:

1. topology contract
2. release identity
3. release signature
4. provenance attestation
5. software-bill-of-materials policy
6. configuration schema
7. credential-reference custody
8. protected-edge access policy
9. database backup freshness
10. write-ahead-log archiving health
11. restore rehearsal
12. migration compatibility
13. rollback material
14. health-probe contract
15. resource headroom
16. monitoring and alert path
17. audit-anchor freshness
18. fresh owner window

Passing all gates creates only an owner-window candidate. It does not deploy. The current synthetic disposition intentionally has only the topology, release, and health-contract gates present: 3 of 18. It therefore reports fifteen blockers, zero attempts, zero effects, and no retry.

## Deployment lifecycle

The pure lifecycle evaluator recognizes these bounded transitions:

`planned -> readiness_candidate -> canary_pending -> canary_observing -> promotion_pending -> active`

A failed canary becomes `rollback_pending`. Any uncertain observation becomes terminal `ambiguous`. The evaluator returns a next-state recommendation only; it cannot execute an action, create authority, retry, promote, or roll back.

## Independent health contract

Health is evidence, not a side-effect API. The observer identity must be different from the observed service principal. The exact probe vocabulary is process identity, release identity, configuration identity, dependency connectivity, database transaction, audit append, queue progress, backup freshness, WAL archiving, resource headroom, and monotonic clock.

Each service role has an exact applicable probe set. Evidence has bounded freshness and expiry. Missing, stale, self-reported, foreign-topology, reordered, or inapplicable results fail closed. A migration runner outside an owner window is `dormant_ready`, not falsely reported as a permanently live daemon. A completely valid snapshot becomes only `ready_candidate`; it grants no deployment authority.

## Backup and point-in-time recovery

The backup manifest contains only immutable digests and times: database and schema identity, base backup, bounded WAL endpoints, audit-chain head, external anchor, protected object-location reference, protected encryption-key reference, manifest signature, encrypted byte count, and restore window. It contains no database bytes, WAL bytes, object locator, or credential material.

Recovery is allowed only into a distinct disposable isolated target. A production service principal cannot be used as the restore target. The exact ordered phases are:

1. isolate disposable target
2. verify topology and release
3. verify backup manifest
4. resolve protected recovery references
5. restore base backup
6. replay bounded WAL
7. verify database integrity
8. verify audit chain and external anchor
9. reconcile node journals without overwriting node truth
10. run independent health validation
11. request a fresh owner cutover window

Every phase starts `not_started` and `phaseAuthorized: false`. Production overwrite, direct production cutover, down migration, automatic retry after a restore marker, and implicit cutover are forbidden. Unknown state after a restore marker is terminal ambiguity.

## Rollback boundary

Application rollback and database restore are different operations. An application-only rollback may name the database `unchanged_verified`. If a prior database state is required, the plan must bind a verified backup for the previous release and use the recovery flow. Previous application release activation still requires a canary. There is no automatic rollback, down migration, service control, database mutation, or retry after an uncertain change.

## Threats closed by this block

- A structurally valid record cannot add fields, accessors, proxies, secrets, or unknown network flows.
- Re-signing a changed nested role, principal, flow, probe, gate, phase, backup, release, topology, or operation does not make the mutation valid.
- A release cannot drift away from the exact topology artifacts or configuration schema.
- A stale or self-reported health result cannot authorize deployment.
- A backup from a foreign topology or release cannot authorize recovery.
- A restore point outside the manifest window cannot be selected.
- A production identity cannot be passed off as a disposable restore target.
- A prepared, healthy, restored, or all-green record never becomes execution authority by itself.

## Explicitly absent

This block did not start a service, inspect a host, resolve a credential, open a network connection, create a database, write a backup, restore data, alter infrastructure, contact a provider, or deploy anything. Values and native adapters belong to later separately authorized work.

## Source and evidence

- `src/operations/v1/` contains the exact topology, deployment, health, recovery, safe-error, and strict parsing contracts.
- `tests/operations-security-contract.test.ts` contains the focused adversarial suite.
- `docs/CR10A_OPS_000_ACCEPTANCE.md` records the acceptance result.
- `docs/CR10A_OPS_010_090_IMPLEMENTATION_PACKETS.md` defines the next real build wave.

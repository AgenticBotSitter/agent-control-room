# CR11B-AUTO-040 No-Relay Simulation and Protected Activation Contract

Status: implementation candidate; independent review required

Date: 2026-08-30

## Purpose

AUTO-040 proves one complete repository-only path from an authenticated AUTO-000 proposal and AUTO-020 standing-policy materialization through accepted AUTO-030 ready promotion, one injected fake handoff delivery, and one bounded fake acknowledgement. It removes the owner as a message relay from the simulation while preserving the rule that repository evidence is not production authority.

The accepted AUTO-030 implementation commit is `adf0804a52a13d544192afc90506c3e989254ffd`. Its accepted independent report is bound by SHA-256 `18df9e9611c5f9053962b776b8261304512b98244ba7b627fd99f4821a79fa2`. AUTO-040 consumes that exact protected boundary without adding a real handoff consumer.

## Exact composed path

One strict no-relay request binds the tenant, workspace, AUTO-020 materialization request, current ready-policy identity, promotion request, promotion and reservation times, fake-delivery deadline, run identity, and every negative-authority statement. The coordinator:

1. parses the exact request without executing accessors or Proxy traps;
2. samples an injected trusted delivery clock before any canonical mutation and rejects a pre-promotion or malformed time;
3. calls the accepted materialization service and derives all later facts from its authenticated receipt;
4. calls the accepted ready-promotion service and derives the fake delivery only from its authenticated promotion receipt and dedicated handoff packet;
5. samples the delivery clock again and requires non-decreasing time;
6. records a durable `delivery_started` marker before contacting the fake; and
7. records either one authenticated fake acknowledgement or terminal ambiguity.

The exact replay of a terminal run returns the authenticated ledger result without materializing, promoting, or delivering again. Changed reuse of a run identity fails. A same-process overlapping call is rejected. Multi-process convergence remains explicitly unproved and production-blocking.

## Fixed injected fake

The only delivery implementation accepted by the coordinator is an exact, privately registered, frozen instance of `ReadyFrontierInMemoryFakeDeliveryV1`. The coordinator calls the captured base-class method, not a caller-selected function or overridden method. Subclasses, Proxies, altered prototypes, unfrozen instances, callbacks, locators, and arbitrary delivery ports are rejected.

The fake has three repository modes: acknowledge, throw after the marker, or return malformed data. It has no network, filesystem, process, GitHub, provider, agent-message, credential, claim, lease, dispatch, execution, or external-effect seam. Its acknowledgement must exactly match run, delivery, job, route, and handoff identity and fall between the authenticated delivery start and deadline. A thrown, malformed, early, late, or mismatched result is terminal ambiguity and is never retried.

## Durable reconciliation ledger

The owner-mode SQLite ledger stores append-only versioned run records. Every run is digest- and HMAC-authenticated; every complete ordered database state is HMAC-authenticated and compared with a separately injected rollback checkpoint. The store verifies exact schema, owner-only file identity, tenant/workspace scope, request identity, state transitions, chronology, and complete prior facts before use.

Allowed states are:

- `delivery_started`;
- `acknowledged_repository_simulation`;
- `terminal_ambiguous`; and
- `expired_before_delivery`.

An unsettled `delivery_started` record found after restart becomes `terminal_ambiguous` without a second fake contact. Expiry before fake contact records `expired_before_delivery` and makes zero delivery calls. Exact restart preserves terminal truth. Row tampering, changed completion facts, changed start facts, schema drift, wrong scope/key, deletion, and complete database rollback fail closed.

## Operator truth

The safe projection contains only run, project, job, route, terminal state, safe reason, attempt count, and time. It omits objectives, source evidence, handoff payloads, owner evidence, authentication tags, private locators, and all authority material. An unsettled marker cannot be projected until it is reconciled.

The portfolio and Project Workspace show repository simulation status, per-project fake acknowledgement and attention counts, and a separately blocked production-activation status. The server fixture honestly reports `not_run`, zero runs, and `blocked_no_simulation_evidence`. The surfaces contain no delivery, activation, materialization, approval, schedule, claim, lease, message, dispatch, or execution control.

## Protected activation packet

Only an acknowledged repository-simulation run can produce the separately keyed activation packet. It binds the exact run digest, accepted AUTO-030 commit, accepted AUTO-030 report hash, creation time, and this complete ordered production-gate list:

- ambiguity reconciliation unproved;
- consumer channel unqualified;
- credential broker unbound;
- hosted PostgreSQL unqualified;
- multi-process concurrency unproved;
- production clock custody unproved;
- production independent review missing;
- production owner approval missing; and
- production policy custody unproved.

The packet is digest- and HMAC-authenticated but always has state `blocked_pending_production_proof`. Every production evidence and permission flag is false. The packet cannot enroll policy, carry protected material, use the network, mutate GitHub, contact an agent/provider, dispatch, execute, or activate itself.

## Stop boundary

AUTO-040 creates repository-only evidence. It does not enroll a real standing policy, consume a production handoff, reconcile a real ambiguous destination, create a schedule, recurrence, GitHub issue or pull request, send an agent message, access a credential, claim or lease work, dispatch or execute a job, contact a provider, read a native profile, use DNS or Cloudflare, host, deploy, or perform any production effect.

The candidate requires a fresh independent review of the exact committed snapshot. Passing repository tests is necessary but cannot make the phase accepted or authorize production activation.

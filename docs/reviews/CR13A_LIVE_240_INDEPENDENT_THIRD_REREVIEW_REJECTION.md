# CR13A-LIVE-240 fourth independent rereview rejection

**Disposition:** rejected
**Findings:** High 0 / Medium 1 / Low 0
**Review mode:** fourth different independent report-only zero-repair review
**Product:** `01e01748c2d9a06ce603caff5d0d0a92d0537fc0`
**Product tree:** `cf3eb5fac8e25c8dd08d66b5f38428df7f82121e`
**Verified sole parent:** `5bbcec299a0612b30d4468c2e96eaafad85d275f`
**Packet SHA-256:** `76efbb6285b882ae296febf866451b4d3a14fb0b50bf699998579102c7758992`

## Reproduced evidence

The reviewer used a fresh local-only detached clone with copied prepared dependencies. All twelve fixed commands ran
exactly once and in order. Initial and final status were empty; exact product, tree, parent range, whitespace, macOS
stage zero, TypeScript, lint, 10/10 focused tests, all five build phases, 4/4 rendered routes, and migrations
0001-0036/119 PostgreSQL tables passed. No install, download, retry, substitution, repair, repository edit, generated
executable, native invocation, network contact, or external effect occurred. The disposable root was removed and exact
absence was verified.

The corrected parent closed M-004. The immutable product also closed M-001, M-002, and M-003: the one promise exists
before execution and remains sticky after failure; frozen copy-on-write histories preserve every event and earlier
snapshots; and exact binding plus simulated expiry validation each occur once before claim, spends, and factory
retrieval.

## M-005 — inherited `then` can execute ambient behavior and replace promise settlement

The branded status is an ordinary frozen object and therefore inherits from `Object.prototype`. The captured native
Promise resolver receives that status. Native promise resolution reads `then`, including an inherited property. A
post-import `Object.prototype.then` getter or callable can therefore execute, force rejection, leave settlement pending,
or substitute an arbitrary unbranded result.

The existing ambient test covered eleven replacements but not inherited thenable assimilation. This does not permit a
second state-machine execution, so M-001 remains closed, but it violates the required post-import ambient
non-execution and branded result boundary. The exact product remains unaccepted.

## Scenario, custody, and ceiling evidence

All six frozen histories were otherwise correct:

- `transferred_then_closed`: binding, expiry, claim, both spends, uncertainty marker, factory, fake resource, listener,
  private locator, adapter offer/accept, transfer, close, verified cleanup, absence, tombstone, checkpoint.
- `rejected_before_effect_marker`: binding, expiry, definite pre-effect rejection.
- `ambiguous_after_effect_marker`: binding, expiry, claim, both spends, uncertainty marker, factory, ambiguous native
  settlement.
- `adapter_rejected_issuer_closes`: the common resource path, adapter rejection, issuer close, verified cleanup,
  absence, tombstone, checkpoint.
- `adapter_acceptance_uncertain`: the common resource path and uncertain adapter acceptance, with owner unresolved and
  no cleanup guess.
- `cleanup_failed_then_observed_absent`: transfer, one close attempt, preserved cleanup failure, independent absence,
  observed-absent recovery, tombstone, checkpoint.

All fourteen one-use ceilings were one. Per-scenario observed count vectors were
`[1,1,1,1,1,1,1,1,1,1,1,1,1,1]`, `[1,1,1,1,0,0,0,0,0,0,0,0,0,0]`,
`[1,1,1,1,1,1,1,1,0,0,0,0,0,0]`, `[1,1,1,1,1,1,1,1,1,1,1,1,0,1]`,
`[1,1,1,1,1,1,1,1,1,1,1,1,0,0]`, and `[1,1,1,1,1,1,1,1,1,1,1,1,1,1]`.
Earlier history snapshots remained frozen and unchanged.

Custody remained exact: successful transfer moved the same fake resource from issuer to adapter; definite adapter
rejection preserved issuer custody until issuer cleanup; uncertain acceptance left ownership unresolved and blocked
cleanup; cleanup failure recovered only through independent absence without replacement or reopen.

## Provenance, privacy, effects, and authority

The product imports only `../../security`. Its only source consumer is the safe connection-registry barrel and its only
review consumer is the focused test. It has no runtime, LIVE-220, or LIVE-190 consumer. Hostile accessors and proxies
executed zero behavior, and the eleven tested ambient replacements executed zero behavior, subject to M-005.

Every actual host, port, reservation, factory, native backend/resource, listener, close, locator, capability, adapter,
driver, persistence, timer, network, and protected-value total remained zero. Caller dependency acceptance, private
port or fake-resource export, retry/rebind/reopen, real composition, LIVE-220 consumption, real adapter use, live
persistence, runtime wiring, external effect, blocker clearance, candidate or activation eligibility, approval, and
every qualification/candidate/activation/network/command/lease/execution authority remained false.

Remediation must make the fulfilled branded status immune to inherited thenable assimilation, extend the hostile
ambient evidence, and receive another different independent zero-repair review. No native, persistence, adapter,
qualification, wiring, deployment, blocker-clearance, or production authority is granted.

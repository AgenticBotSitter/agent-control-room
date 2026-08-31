# CR10A OPS-090 executable-but-disabled runbooks

**Status:** Complete for the exact local synthetic, non-authorizing boundary
**Scope:** Eight exact operations runbook graphs, authenticated resumable state, synthetic evidence, safe guides, abort and ambiguity handling, cleanup, and reconciliation
**Not in scope:** Native execution, commands, hosts, paths, endpoints, credentials, target selection, owner approval material, service control, databases, storage, providers, networks, deployment, restore, isolation, or any external effect

## Exact registry

`src/operations/v1/runbooks.ts` compiles the accepted OPS-000 through OPS-080 contracts into eight fixed state machines:

1. deploy release;
2. forward migration;
3. one-host canary;
4. application rollback;
5. backup and WAL;
6. isolated restore;
7. incident isolation;
8. audit-anchor recovery.

Definitions have exact identifiers, order, evidence classes, change boundaries, cleanup, and reconciliation. Each definition is compared with the repository-built canonical graph after strict parsing, so recomputing ordinary digests cannot authorize reordered, substituted, enabled, or extended semantics.

Every effect-shaped step is only an `effect_slot`. The registry and every definition state that the native executor, target, command lines, automatic retry, approval, authorization, and execution authority are absent.

## Evidence and ordering

An instance starts with one exact runbook, definition digest, scope digest, and operation digest. Each step requires fresh synthetic evidence bound to the exact instance, operation, step, step digest, and evidence class. Evidence contains no approval material, raw output, command, action, or authority.

Only the current step can advance. A skipped or out-of-order step is rejected. Exact replay is inert; changed replay is rejected. Evidence cannot move between instances, operations, definitions, or steps. Expired evidence is recorded as stale and blocks before change rather than being relabelled as success, definite failure, or an unknown native outcome.

Owner gates are synthetic rehearsal points only. Passing one during a fake rehearsal proves that the graph can continue; it does not capture a human decision or create approval.

## Authenticated resume state

`OperationsRunbookAuthenticatorV1` seals the whole instance state with an external integrity key and identity digest. The key boundary accepts only an exact, offset-zero `Uint8Array` backed by its complete ordinary `ArrayBuffer`. Shared, detached, partial, subclassed, shadowed, or otherwise hostile binary views are rejected without invoking attacker properties.

An instance can be serialized and verified by a new authenticator with the same exact identity and key. An ordinarily re-digested state forgery still fails the HMAC boundary, and the wrong key fails. The current authenticator is explicitly test-only; closing it wipes the internal key and permanently disables further use. No production persistence or key-custody adapter is shipped.

## Abort, uncertainty, and cleanup

Before a change boundary, failed, stale, unknown, or aborted work becomes `blocked_before_change` with no retry path. At or after a change boundary, failure, uncertainty, or abort does not continue the ordinary graph. It jumps only to the runbook's exact cleanup step, then requires the exact reconciliation step, and ends as `terminal_ambiguity`.

Cleanup cannot be skipped and reconciliation cannot run early. No state can turn uncertainty into success, restart an effect slot, or infer that an external action happened. `effectAttemptCount` remains zero throughout because this implementation has no executor.

## Safe guide and rehearsal

The guide renderer emits only the fixed title code, ordered step cards, evidence class, and boundary. Controls and command collections are empty. The fake rehearsal walks every graph with synthetic evidence and ends as `completed_evidence_only`; it performs no external action and grants no approval or authority.

## Deliberately absent

- shell, subprocess, filesystem, socket, HTTP, database, storage, service, container, provider, deployment, or notification clients
- commands, scripts, target selectors, hosts, endpoints, paths, accounts, credentials, locators, or production values
- native executor construction, owner approval capture, automatic promotion, rollback, retry, restore, isolation, or cutover
- any conversion of a runbook, owner gate, synthetic evidence, completion, cleanup, or reconciliation record into authority

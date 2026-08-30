# CR10A OPS-080 canary and rollback planner

**Status:** Complete for the exact local planner-only boundary
**Scope:** Exact deployment evidence composition, ordered proposals, owner questions, authenticated effect-intent truth, restart reconciliation, safe projection, and a disabled executor seam
**Not in scope:** Commands, hosts, endpoints, credentials, targets, service control, migration, canary execution, promotion, rollback, restore, providers, network calls, or any external effect

## Planner boundary

`src/operations/v1/canary-rollback-planner.ts` consumes three already accepted OPS-000 records:

1. an exact deployment plan with a previous release;
2. an exact eighteen-gate readiness assessment that is still inside its fresh owner window;
3. an exact application rollback plan for the same topology and releases.

The rollback plan must leave the verified database unchanged. A rollback plan that requires database restoration is rejected because restore belongs to the separate eleven-phase recovery path. The planner also rejects foreign topology, current release, previous release, deployment identity, stale owner windows, incomplete readiness, gate substitution, and expiration outside any source window.

The output is one fixed eight-step plan:

1. verify all exact readiness evidence;
2. ask whether to open an external canary authority review;
3. propose the forward-only migration intent;
4. propose the one-host canary intent;
5. require independent canary observation;
6. ask the owner to choose promotion, application rollback, or stop;
7. prepare only the chosen branch;
8. reconcile terminal evidence or stop in ambiguity.

Three fixed owner questions contain safe prompt codes and choices only. The planner does not record an answer, interpret an answer as approval, or perform the selected action.

## Four distinct effect intents

The planner creates four proposal-only intents:

- forward migration candidate;
- one-host canary candidate;
- promotion candidate;
- application rollback candidate.

Every intent is digest-bound to the planner, topology, deployment plan, rollback plan, current release, previous release, action, and expiration. It has no command, target, credential reference, client, approval, deployment authority, rollback authority, or execution authority.

The ledger enforces the following sequence:

- canary evidence cannot start before verified forward-migration evidence;
- promotion can be claimed only after independently verified `canary_passed` evidence;
- application rollback can be claimed only after independently verified `canary_failed` evidence;
- promotion and rollback are mutually exclusive;
- no branch is selected automatically.

## Authenticated restart-safe intent truth

`OperationsEffectIntentLedgerV1` records proposed intents, evidence-only claims, pre-effect markers, and complete independent receipts. The protected state has:

- an external integrity key accepted only through the repository's exact whole-buffer binary boundary;
- whole-state HMAC authentication;
- a monotonic revision and time high-water mark;
- an external compare-and-swap rollback checkpoint;
- exact replay with changed replay rejected;
- authenticated portable snapshots for a separately supplied storage boundary;
- no filesystem, database, provider, network, process, or storage client.

The current repository port is test-only memory. Exported snapshots demonstrate restart portability, but this phase intentionally ships no production persistence adapter. An older still-authentic snapshot fails against the external checkpoint.

If reopened after a claim but before a marker, the intent becomes `failed_before_change`. If reopened after a marker but before a complete receipt, it becomes `ambiguous`. Neither state can retry. Success or failure after a marker needs both an effect receipt digest and an independent verification digest; partial receipts fail closed.

## Disabled executor seam

The repository-created disabled executor accepts only an intent produced by the trusted planner or ledger. It always returns `disabled_before_execution` with:

- no command lines;
- no target;
- no client;
- no credential resolution;
- no effect attempt;
- no approval or execution authority.

A parsed or re-signed caller-created intent is refused even if its ordinary digest is valid.

## Operator projection

The owner-facing projection reports fixed question codes, four safe intent cards, digest references, and one of four states: owner questions pending, evidence in progress, completed evidence only, or terminal ambiguity. Its control and command collections are always empty.

## Deliberately absent

- shell, subprocess, service, container, database, storage, provider, HTTP, socket, DNS, or deployment clients
- executable commands, scripts, native adapters, paths, hosts, endpoints, accounts, credentials, and targets
- automatic promotion, rollback, retry, migration, restoration, or branch selection
- down migrations or database restoration inside application rollback
- any conversion of planning, claim, marker, receipt, health, or monitoring evidence into authority

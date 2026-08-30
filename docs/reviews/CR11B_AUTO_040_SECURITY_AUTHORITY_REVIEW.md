# CR11B-AUTO-040 security and authority review

**Review status:** rejected; remediation and a fresh independent re-review are required  
**Candidate commit:** `c16939f6e57a7c34eeffeeae9ffdd3b97430b824`  
**Compared parent:** `d8f115393b79bf52d2c541407fceca9e9ce54e5a`  
**Branch observed:** `codex/cr11b-auto-040-no-relay-simulation`  
**Review date:** 2026-08-30  
**Reviewer:** fresh independent Codex security-and-authority reviewer; not the implementer and not an AUTO-030 reviewer  
**Mode:** owner-authorized, report-only review; no implementation, test, contract, acceptance, decision-log, status, commit, credential, provider, agent, GitHub, network-delivery, deployment, or production-effect change

## Snapshot binding and scope

Before review, `git rev-parse HEAD` returned the exact candidate commit, `git rev-parse HEAD^` returned the exact stated parent, and `git merge-base` returned that same parent. `git status --porcelain=v1` was empty and this report path was absent. The candidate changes 19 paths relative to the parent: the AUTO-040 contract and acceptance record, the no-relay coordinator/fake/schema/store/types/functions, exports, dedicated tests, package scripts, status/decision/completion documents, and read-only UI projection wiring.

I read `AGENTS.md`, `docs/BUILD_STATUS.md`, `docs/CR11B_AUTO_040_NO_RELAY_SIMULATION_AND_ACTIVATION_CONTRACT.md`, `docs/CR11B_AUTO_040_ACCEPTANCE.md`, the relevant AUTO-020 and accepted AUTO-030 contracts, ADR-098 through ADR-105 as relevant, `docs/SECURITY_AND_AUTHORITY.md`, and the time/effect/authority portions of `docs/CR5C_FINAL_SECURITY_CONTRACT.md`. I also inspected every changed implementation, test, export, and UI path. The prior accepted AUTO-030 snapshot remains an input boundary, not authority for this new slice.

## Commands and observed evidence

- `git rev-parse HEAD`, `git rev-parse HEAD^`, `git merge-base d8f1153... c16939f...`, `git status --porcelain=v1`, and the report-absence check: exact commit and parent relationship confirmed; checkout clean; report absent.
- `git diff --name-status d8f1153...c16939f` and `git show --stat c16939f...`: candidate scope reconstructed as 19 changed paths and 1,559 insertions / 19 deletions.
- `pnpm exec tsx --test tests/ready-frontier-no-relay.test.ts`: did **not** run the suite; the `tsx` CLI failed with `listen EPERM` on its temporary IPC pipe. This blocked invocation is preserved as such and is not counted as passing evidence.
- `node --import tsx --test tests/ready-frontier-no-relay.test.ts`: **13/13 passed**, zero failures or skips.
- `pnpm test:cr11b`: **80/80 passed**, including all AUTO-000/010/020/030/040 and view cases.
- `pnpm check`: passed (`tsc --noEmit`).
- `pnpm lint`: passed (`eslint .`).
- Static searches over the new coordinator/store/packet/UI paths found no imported HTTP, network, child-process, Octokit, provider, credential, attempt, lease, generic outbox, dispatch, or executor client. The ready-frontier view adds no form, button, delivery, activation, approval, schedule, claim, lease, dispatch, or execution control. Existing unrelated Owner Focus behavior is not an AUTO-040 control.
- A shell-only post-construction replacement probe reported: `{"writable":true,"configurable":true,"marked":true,"effectCount":3,"resultState":"acknowledged_repository_simulation","completionState":"acknowledged_repository_simulation","authenticatedAck":true}`.
- A shell-only activation-input accessor probe reported: `{"accesses":2,"runUpdatedAt":"2026-08-30T18:04:06.000Z","packetCreatedAt":"2026-08-30T18:03:00.000Z","createdBeforeAcknowledgement":true,"parsed":true,"state":"blocked_pending_production_proof","canActivateItself":false}`.
- The probes used only in-process repository modules and disposable/in-memory values. They created no tracked or retained temporary file and made no external contact.

Because reproducible security findings reject the snapshot, I did not reinterpret the passing suites as acceptance and did not spend additional authority on the full `pnpm test`, production build, stage-zero, or migration lifecycle. Those gates cannot cure either boundary defect.

## Findings

### AUTO040-SAR-001 — High — Constructor validation can be invalidated and an arbitrary delivery callback can produce accepted success

`ReadyFrontierNoRelayCoordinatorV1` validates the supplied fake once in its constructor (`src/ready-frontier/v1/no-relay-coordinator.ts:58-66`) but stores the fake, materializer, promoter, store, and clock as ordinary TypeScript `private readonly` parameter properties. At runtime those are own properties, and `fakeDelivery` is both writable and configurable. Delivery later calls the captured base implementation with the **current mutable property** as `this` (`no-relay-coordinator.ts:133-135`). TypeScript privacy and readonly annotations provide no runtime protection.

The probe constructed a coordinator with an initially registered exact frozen fake, observed the writable/configurable property descriptor, replaced `coordinator.fakeDelivery` with a Proxy, and ran a valid exact request. The Proxy getters executed three times after `store.begin` had recorded the marker. By returning `"acknowledge"` and an in-window acknowledgement time, the hostile object caused the captured base method to create a digest-valid acknowledgement, and the coordinator recorded and returned `acknowledged_repository_simulation` rather than rejecting the replacement. A getter could perform any ambient operation available to the host process before returning those values; false capability flags and the later acknowledgement digest do not undo such behavior.

The same construction boundary accepts arbitrary duck-typed materializer, promoter, store, and clock objects and dynamically calls them (`no-relay-coordinator.ts:72,85-87,106,128,150-161`). The probe used such objects to supply fabricated receipt fragments and a fabricated store result. The coordinator does not independently authenticate those returned receipts or prove that the accepted AUTO-020/AUTO-030 implementations produced them. Post-construction replacement therefore defeats both the exact fixed-fake claim and the claim that delivery facts necessarily derive from authenticated accepted-module receipts.

This is an exploitable structural failure of the central AUTO-040 negative-authority boundary. The repository contains no real effect client, but the exported coordinator admits and invokes arbitrary behavior, so source-string absence cannot prove zero callback, network, provider, agent, GitHub, credential, or external-effect authority in the composed path.

**Required remediation:** keep every security-sensitive collaborator and the validated fake in runtime-unforgeable module-private state (for example, a non-exported WeakMap/factory binding or true ECMAScript private slots), and do not expose writable/configurable aliases. Bind the exact registered instances and captured exact base methods for the lifetime of a run; do not rely on TypeScript `private`, `readonly`, or caller convention. The coordinator must either independently authenticate complete materialization/promotion results or consume them only through an unforgeable exact accepted-service binding. Add hostile tests for assignment, deletion, `Object.defineProperty`, Proxy/subclass substitution, own-method replacement, prototype replacement, arbitrary collaborator objects, and post-construction mutation; each must execute zero trap/callback, create no marker or canonical result where appropriate, and never return an acknowledged run. Re-audit all coordinator dependency fields, not only `fakeDelivery`.

### AUTO040-SAR-002 — Medium — Activation builder executes caller accessors and authenticates impossible chronology

`buildReadyFrontierActivationPacketV1` reads `input.run`, reads `input.createdAt` for the chronology check, then later reads `input.packetId` and `input.createdAt` again while constructing the packet (`src/ready-frontier/v1/no-relay.ts:213-229`). It does not first take one exact ordinary-data snapshot of the input. The activation packet schema validates canonical field shapes but does not re-establish `createdAt >= acknowledged run.updatedAt` after those repeated reads (`src/ready-frontier/v1/no-relay-schemas.ts:97-112`).

The probe supplied an ordinary object with a `createdAt` accessor. The first access returned `2026-08-30T18:05:00.000Z`, passing the check against a run acknowledged at `18:04:06Z`; the second returned `18:03:00Z`. The builder executed the accessor twice, emitted an authenticated packet dated before its acknowledged simulation run, and `parseReadyFrontierActivationPacketV1` accepted the packet. Thus the purported protected evidence can have impossible chronology, and a Proxy/accessor boundary can execute caller behavior before rejection.

The reproduced packet remained `blocked_pending_production_proof`, retained all false permission flags, and could not self-activate. This finding therefore corrupts protected planning evidence and exact-input guarantees without independently granting production authority.

**Required remediation:** exact-snapshot the complete builder input once before any property access using the repository's host Proxy/accessor-safe mechanism; reject Proxies, accessors, unexpected prototypes, symbols, and extra fields without executing traps; parse and use only that immutable snapshot; and perform the acknowledged-run chronology check against the exact `createdAt` value that is placed into the authenticated packet. Add tests proving zero getter/Proxy execution, mutation resistance, rejection of pre-acknowledgement creation time, and exact replay/parser behavior.

## Attack disposition and surviving negative evidence

- **Exact fake / callbacks / subclasses / prototypes / alternate direct calls:** rejected by AUTO040-SAR-001. Construction-time subclass rejection passes, but post-construction replacement bypasses it and can return authenticated success.
- **Mutable and hostile inputs:** the top-level no-relay request correctly rejects accessors and Proxies without trap execution in the dedicated suite. The activation builder fails the same standard under AUTO040-SAR-002.
- **Clock, start, deadline, and acknowledgement identity:** ordinary-path tests pass for preflight time, monotonic second delivery sample, marker-before-contact, expiry-before-contact, early/late acknowledgement ambiguity, and exact identity matching. The clock collaborator is nevertheless runtime-mutable under AUTO040-SAR-001, and the activation creation-time binding fails under AUTO040-SAR-002.
- **Authenticated receipt derivation:** the normal real-service suite reaches the accepted AUTO-020/030 path and leaves one ready job, reservation, and dedicated handoff with zero attempts/leases. The exported coordinator can instead accept fabricated collaborator results, so the universal derivation claim is not established.
- **Durability, replay, restart, tamper, rollback, and ambiguity:** recorded tests pass for one delivery, terminal replay, changed request/start/completion rejection, unsettled-restart ambiguity without redelivery, row tamper, exact restart, and full-database rollback detection. These properties do not close the callback seam.
- **Projection and controls:** normal projections are sanitized, do not project unsettled markers, and expose only blocked/read-only truth. The server fixture honestly reports `not_run`, zero runs, and `blocked_no_simulation_evidence`; no AUTO-040 operational control was found.
- **Approval, schedule, claim, lease, dispatch, execution, provider, agent, GitHub, network, credential, and effects:** no concrete client or direct operation for these authorities is present in the candidate, and canonical ordinary-path counts remain zero for attempts and leases. AUTO040-SAR-001 nonetheless permits arbitrary host behavior to be invoked at the claimed fixed-fake seam, so the stronger structural absence claim fails.
- **Activation packet completeness and self-activation:** all nine required production gate codes are present in their exact order; accepted AUTO-030 commit/report evidence is exact; all production evidence/permission flags are false; and no activation executor exists. The packet cannot self-activate. AUTO040-SAR-002 means its creation evidence is not yet exact.

## Residual and negative-authority boundary

No live network, provider, credential, agent, GitHub, native profile, DNS, Cloudflare, hosted service, claim, lease, dispatch, execution, deployment, production policy enrollment, production approval, or external effect was exercised in this review. Multi-process/hosted PostgreSQL convergence, protected production clock/key/checkpoint/policy custody, consumer-channel qualification, credential brokerage, destination reconciliation, production independent review, and fresh production owner approval remain unproved and blocked. The candidate does not dishonestly claim multi-process PostgreSQL proof.

The passing repository tests and the packet's blocked flags are retained as positive evidence only for their exact exercised paths. They cannot convert either reproduced negative result into acceptance. AUTO-040 remains open until a remediation commit receives a fresh independent review.

REJECTED_SECURITY_AUTHORITY_FINDINGS

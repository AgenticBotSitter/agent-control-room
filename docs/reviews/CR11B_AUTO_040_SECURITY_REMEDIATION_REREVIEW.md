# CR11B-AUTO-040 security and authority first-remediation re-review

**Disposition:** rejected; one High security/authority finding remains
**Exact remediation commit:** `8344dd698bc8bc2786b611fdb246e9e5aca3dc4e`
**Rejected candidate / remediation parent:** `c16939f6e57a7c34eeffeeae9ffdd3b97430b824`
**Branch observed:** `codex/cr11b-auto-040-no-relay-simulation`
**Review date:** 2026-08-30
**Reviewer:** different independent Codex security/authority reviewer; not the implementation or remediation author and not the author of either initial AUTO-040 report
**Mode:** owner-authorized report-only re-review; no implementation, test, contract, prior-report, commit, credential, provider, agent, GitHub mutation, deployment, or production-effect change

## Snapshot and preserved evidence

`git rev-parse HEAD` returned `8344dd698bc8bc2786b611fdb246e9e5aca3dc4e`; `HEAD^` and the merge base with the rejected candidate both returned `c16939f6e57a7c34eeffeeae9ffdd3b97430b824`. The checkout was clean when this review began. No pull request or issue matched the AUTO-040 branch/block. The remediation changes thirteen paths and preserves both original negative reports. `docs/reviews/CR11B_AUTO_040_SECURITY_AUTHORITY_REVIEW.md` remained byte-for-byte unchanged at SHA-256 `aed60806370152b6136857d32ae3cbd973f24975add5578af5c553cc2f708a3d`; its negative disposition is not replaced or reinterpreted.

I read the active build status, AUTO-040 contract and acceptance record, ADR-105 and ADR-106, the two initial reports, the accepted AUTO-020/AUTO-030 boundaries needed for composition, every remediation implementation and regression path, and the relevant authority contracts. I treated producer tests as claims to reproduce, not acceptance authority.

## Commands and observed evidence

| Command or probe | Exact observed result |
|---|---|
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; Node `>=22.13.0`, pnpm `11.19.0`, `tsx` and `zod` resolved; no native attempt |
| `node --import tsx --test tests/ready-frontier-no-relay.test.ts` | 14/14 passed; zero failures or skips |
| `pnpm test:cr11b` | 81/81 passed; zero failures or skips |
| `pnpm check` | Exit 0; `tsc --noEmit` passed |
| `pnpm lint` | Exit 0; full ESLint gate passed |
| Independent post-construction evaluation-alias probe using the real stores, materialization service, promotion service, canonical PGlite store, no-relay store, fixed fake, and fixed delivery clock | Exit 0 and emitted `{"callbackCount":2,"resultState":"acknowledged_repository_simulation","fakeDeliveryCount":1,"evaluationAliasOwn":true,"coordinatorOwnNames":[]}` |
| Independent activation-input accessor and Proxy probe | Exit 0 and emitted `{"getterCalls":0,"accessorCode":"invalid_input","proxyTrapCount":0,"proxyCode":"invalid_input"}` |

The focused and combined suites reproduced ordinary end-to-end acknowledgement, terminal replay, thrown/malformed ambiguity, expiry, early/late acknowledgement, preflight rejection, restart recovery, tamper and complete-database rollback detection, direct-store capability denial, capacity preflight, activation blocking, hostile top-level input rejection, honest projection, UI truth, and absence of a concrete effect client. Those passes do not close the independently reproduced nested-alias execution seam below.

## Finding

### AUTO040-SAR-001 — High — remains open: a post-construction nested collaborator alias executes arbitrary behavior inside an acknowledged composed run

The remediation successfully removes the original writable own properties from `ReadyFrontierNoRelayCoordinatorV1`: its direct materializer, promoter, store, fake, fixed delivery clock, key, and capability are ECMAScript-private, the instance has no own string-named properties, and the coordinator invokes captured closures or base methods. Direct duck-typed materializer, fake Proxy/subclass, coordinator assignment, and direct fake/store method replacement attacks now fail.

The exact-service binding is nevertheless not a closed runtime dependency graph. `ReadyFrontierMaterializationServiceV1` stores the caller-supplied evaluation and policy stores in private slots (`src/ready-frontier/v1/materialization-service.ts:18-19,26`) but dynamically invokes `this.#evaluations.evaluation(...)` and `this.#policies.withCurrentPolicy(...)` later (`materialization-service.ts:32-34`). `ReadyFrontierPromotionServiceV1` similarly retains and dynamically invokes caller-held evaluation, standing-policy, ready-policy, canonical-store, and trusted-clock objects (`src/ready-frontier/v1/promotion-service.ts:112-116,144-155`). The service instances and their own prototypes are frozen, but the captured collaborator objects are not exact-bound by those services. In particular, `ReadyFrontierSimulationStoreV1` remains externally aliased and extensible, and its `evaluation` method is dynamically dispatched (`src/ready-frontier/v1/durable-store.ts:202-204`).

The independent probe built the ordinary real repository composition, then, **after** both services and the coordinator existed, defined an own `evaluation` method on the externally held simulation-store instance. That method incremented an arbitrary-callback counter and delegated to the original real method. The callback ran twice—once through materialization and once through promotion—yet the fixed fake was contacted once and the coordinator returned `acknowledged_repository_simulation`. The coordinator itself still had no own string-named properties. A counter is the harmless proof payload; the same admitted callback can perform any ambient operation available to the host process.

This reproduces the essential `AUTO040-SAR-001` invariant failure through a narrower alias than the original direct coordinator-field replacement. Runtime-private coordinator fields prevent replacement of the service object, but they do not prevent post-construction replacement of a dynamically called object retained inside that accepted service. The contract statement that post-construction aliases cannot enter the composed operation is therefore false, and the stronger effect-free/fixed-collaborator claim is not established. A successful acknowledgement and false authority flags cannot erase behavior already executed before that acknowledgement.

The producer regression at `tests/ready-frontier-no-relay.test.ts:320-355` checks a direct duck materializer, Proxies, coordinator own properties, fake/prototype replacement, and one direct no-relay-store method replacement. It does not mutate the evaluation store, standing-policy store, ready-policy store, canonical store, or promotion clock retained behind the branded services. It therefore could not catch this exploit.

**Smallest safe remediation direction:** make the complete composed dependency graph runtime-exact, not only its top-level service objects. Each accepted service should bind privately registered exact collaborator identities and captured base operations, with no externally mutable object used for later dynamic dispatch; alternatively, construct the entire AUTO-040 composition behind one module-private factory that owns those bindings. The promotion clock must receive the same exact frozen treatment. Add post-construction assignment, deletion, `Object.defineProperty`, Proxy/subclass, own-method, and prototype-replacement probes for every nested evaluation, policy, canonical-store, and clock dependency. Each probe must execute zero hostile callback, must not create a canonical marker or terminal result where the rejection can occur before mutation, and must never return an acknowledged run. A different independent reviewer must repeat the full security/authority boundary after remediation.

## AUTO040-SAR-002 remediation determination

`AUTO040-SAR-002` is independently verified repaired on this exact commit. `buildReadyFrontierActivationPacketV1` first uses `exactHostDataSnapshotV1` over exactly `packetId`, `run`, and `createdAt` (`src/ready-frontier/v1/no-relay-store.ts:329-336`), requires the exact process-local frozen acknowledged run returned or replayed by the coordinator (`no-relay-store.ts:333-338`), and uses the one parsed local `createdAt` value for both chronology and authenticated packet construction (`no-relay-store.ts:336-357`).

The focused suite rejects a syntactically valid cloned run, rejects `createdAt` before acknowledgement, prevents mutation of the frozen eligible run, rejects an accessor with zero execution, and preserves exact packet parse/tamper behavior. The independent hostile-input probe separately supplied an accessor and a throwing Proxy at the complete builder-input boundary; both returned `invalid_input` with zero getter or Proxy-trap execution. I found no remaining repeated-read, impossible-chronology, clone-eligibility, or self-activation path for this finding.

## Residual and negative-authority boundary

AUTO-040 remains open because `AUTO040-SAR-001` remains reproducible. The passing repository suites are retained only for their exact exercised paths and cannot convert this finding into acceptance.

No live network, credential, provider, agent, GitHub mutation, native read, DNS, Cloudflare, scheduling, claim, lease, dispatch, execution, hosting, deployment, production policy enrollment, or external effect was exercised. Protected production policy and clock/key/checkpoint custody, hosted PostgreSQL, multi-process convergence, a qualified consumer channel, credential brokerage, cross-service ambiguity reconciliation, production independent review, and fresh owner approval remain unproved and blocked.

REJECTED_SECURITY_AUTHORITY_REMEDIATION_FINDINGS

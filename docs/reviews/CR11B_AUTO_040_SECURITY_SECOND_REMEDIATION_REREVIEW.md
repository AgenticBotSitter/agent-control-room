# CR11B-AUTO-040 security and authority second-remediation re-review

**Disposition:** rejected; one High security/authority finding remains  
**Exact reviewed commit:** `033b9ef81439f30ed88dc9727ffe32e9f32e6e69`  
**Compared first-remediation commit:** `8344dd698bc8bc2786b611fdb246e9e5aca3dc4e`  
**Branch observed:** `codex/cr11b-auto-040-no-relay-simulation`  
**Review date:** 2026-08-30  
**Reviewer:** fresh independent Codex security/authority reviewer; not the implementation author or any earlier AUTO-040 reviewer  
**Mode:** owner-authorized, report-only review; no implementation, test, contract, status, prior-report, git-metadata, credential, provider, agent, GitHub, network, deployment, or production-effect change

## Exact snapshot and preserved evidence

Preflight returned exact `HEAD` `033b9ef81439f30ed88dc9727ffe32e9f32e6e69`, branch
`codex/cr11b-auto-040-no-relay-simulation`, and an empty porcelain status. Recent history showed this commit directly above
first remediation `8344dd698bc8bc2786b611fdb246e9e5aca3dc4e`. The requested report path was absent.

I read `AGENTS.md`, `docs/BUILD_STATUS.md`, the complete AUTO-040 contract and acceptance record, ADR-105 through ADR-107,
and all four existing AUTO-040 reports. Their byte-for-byte SHA-256 values remained:

- initial security/authority: `aed60806370152b6136857d32ae3cbd973f24975add5578af5c553cc2f708a3d`;
- initial durability/replay: `ac2fbad63eed913ea95b185e35d1b905b72614b643ce6b6a80eb97d9a8019515`;
- accepted first-remediation durability: `392af82a4462c6cccc8ea2098b248962b95a1a49331b0ae5aa4f69edb7600e6a`; and
- rejected first-remediation security: `14405beb724bf29f08f6ed4747d247f88ab19efbf6d3763e38d20481f5aef6dc`.

The exact `8344dd6..033b9ef` diff changes 16 paths with 828 insertions and 409 deletions. I inspected every changed
implementation, test, contract, decision, status, completion, and review path. `git diff --check
8344dd698bc8bc2786b611fdb246e9e5aca3dc4e..033b9ef81439f30ed88dc9727ffe32e9f32e6e69` passed.

No GitHub query was made because this review expressly prohibited provider/GitHub contact. Local repository history,
documents, implementation, tests, and prior immutable reports supplied the review boundary.

## Commands and observed results

| Command or independent probe | Observed result |
|---|---|
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; Node `>=22.13.0`, pnpm `11.19.0`, `tsx` and `zod` resolved; no native attempt |
| `node --import tsx --test tests/ready-frontier-no-relay.test.ts` | 16/16 passed; zero failures or skips |
| `pnpm test:cr11b` | 83/83 passed; zero failures or skips |
| `pnpm check` | Exit 0; `tsc --noEmit` passed |
| `pnpm lint` | Exit 0; full ESLint gate passed |
| Independent complete-graph mutation matrix using real PGlite, all four real SQLite stores, materialization and promotion services, both fixed clocks, the exact fake, and the coordinator | Thirteen instance/prototype mutation checks, eleven throwing-Proxy rejections, and ten hostile-subclass rejections produced zero hostile callbacks and zero boundary traps. A fabricated direct-store capability returned `policy_denied`. Before the normal run: zero canonical jobs/handoffs, no no-relay run, and zero fake contacts. The untouched exact path then acknowledged with one fake contact, one ready job/handoff, and zero attempts/leases. |
| Corrected reproduction of the initial coordinator-field attack and first-remediation evaluation-alias attack | Coordinator had no own string-named fields. Assignment, deletion, and `defineProperty` against `fakeDelivery`, materializer, promoter, store, clock, and the evaluation method produced zero hostile callbacks and zero Proxy traps. Before the normal run there were zero jobs, handoffs, no-relay rows, and fake contacts; the real frozen path then acknowledged with one genuine fake contact. |
| Independent activation accessor, throwing Proxy, clone, and normal-packet probe | Accessor rejected as `invalid_input` with zero getter calls; Proxy rejected as `invalid_input` with zero traps; cloned run rejected as `policy_denied`; the exact eligible run produced an authenticated `blocked_pending_production_proof` packet with every effect permission false. |
| Post-construction raw-PGlite and frozen-adapter mutation probe | Replacing the raw PGlite instance's own methods and prototype after `adaptPglite`, and attempting assignment/deletion/`defineProperty`/prototype replacement on the frozen adapter, executed zero hostile database callbacks; the captured adapter path remained functional. |
| Post-construction captured-receiver probe described below | Exit 0 and emitted `{"postConstructionReceiverCallbacks":{"database":2,"evaluationCheckpoint":2,"standingCheckpoint":2,"readyCheckpoint":1,"noRelayCheckpoint":8},"resultState":"acknowledged_repository_simulation","fakeDeliveryCount":1,"authorityCounts":{"ready":"1","handoffs":"1","attempts":"0","leases":"0"},"coordinatorOwnNames":[]}`. |
| Static import/call inspection | No delivery, agent, provider, GitHub, credential, claim, lease, dispatch, executor, child-process, HTTP, or fetch client exists in the no-relay coordinator/store/fake or the bound materialization/promotion/store modules. However, `src/persistence/database.ts` exports `createPostgresClient`, a networked implementation of the same unbranded `DatabaseClient` accepted by every branded `CanonicalStore`. |

A preliminary version of the coordinator-field probe read one method from its own observed Proxy twice while assembling
the probe and therefore counted two reviewer-setup traps. It did not indicate boundary execution. The corrected probe
above performed no such read and observed zero rejected-boundary traps and callbacks; only the corrected result is used
for the finding dispositions.

The focused and combined suites independently reproduced ordinary end-to-end acknowledgement, marker-before-fake ordering,
terminal replay, thrown/malformed ambiguity, expiry, early/late acknowledgement handling, invalid-preflight rejection,
restart recovery without redelivery, request/start/completion drift checks, row tamper and database rollback detection,
direct-store capability denial, terminal-capacity preflight, blocked activation, sanitized projection/UI truth, and zero
attempts or leases. These passing paths do not close the alternate admitted receiver path below.

## Prior security finding dispositions

### AUTO040-SAR-001 — exact prior exploits closed, structural invariant still open

The initial direct coordinator-property replacement is closed: the coordinator exposes no own string-named collaborator
field, is frozen, and calls private captured closures. The exact first-remediation exploit is also closed: the simulation
store and its prototype are frozen, assignment/own-method creation/deletion/`defineProperty`/prototype replacement fail,
and both services call the captured base `evaluation` operation. The corresponding corrected probe executed zero hostile
callbacks and created no marker, canonical row, or fake result before the real unmodified run.

The broader `AUTO040-SAR-001` invariant is not satisfied, however, because the supposedly complete captured dependency
graph still admits caller-held mutable database and rollback-checkpoint receivers. `AUTO040-SSRR-001` below is a new exact
reproduction of arbitrary behavior inside an acknowledged composed run. Therefore SAR-001 cannot receive an overall closed
security disposition on this commit.

### AUTO040-SAR-002 — closed

The activation builder snapshots exactly `packetId`, `run`, and `createdAt`, requires the process-local exact eligible run,
and authenticates the same one-time `createdAt` value it checks. Independent accessor and Proxy inputs executed zero
behavior and were rejected; a cloned authenticated-shaped run remained ineligible; the ordinary packet remained complete,
blocked, and non-self-activating. I found no repeated-read, impossible-chronology, clone-eligibility, or activation executor
path.

## Finding

### AUTO040-SSRR-001 — High — captured operation identity retains mutable generic receivers that execute arbitrary callbacks inside acknowledged success

The second remediation freezes and brands the outer canonical/store/service objects, but it does not make the complete
port graph exact.

`CanonicalStore` accepts any non-Proxy object with three appropriately named functions. It captures those function
identities, then later invokes each with the original caller-held `db` object as `this`
(`src/persistence/canonical-store.ts:203-215`). Every such store is added to the same `canonicalStores` registry, and the
frontier binder checks only that outer store's registry membership, exact prototype, and frozen state
(`canonical-store.ts:1253-1273`). It does not distinguish a canonical store backed by the captured frozen PGlite adapter
from one backed by an arbitrary ordinary `DatabaseClient`.

The simulation, standing-policy, ready-policy, and no-relay stores repeat the same incomplete pattern for rollback
checkpoints. Each captures `checkpointStore.read/initialize/advance.bind(checkpointStore)` while preserving the ordinary
caller-held checkpoint object as the receiver (`durable-store.ts:106-118`, `standing-policy-store.ts:77-85`,
`ready-policy-store.ts:90-99`, and `no-relay-store.ts:92-103`). The new WeakSet/frozen-instance binders prove only the
outer store identity. They do not prove the behavior of those bound ordinary receiver methods.

The independent probe supplied ordinary database and checkpoint ports whose initially safe methods delegated to the real
frozen PGlite adapter and real in-memory checkpoint implementations. It populated the genuine evaluation and policy
stores, constructed the canonical store, both services, both exact clocks, no-relay store, fake, and coordinator, and
confirmed all resulting outer objects were frozen. Only after the full composition existed, it replaced each port's
ordinary `delegate` property with a harmless counting wrapper that continued delegating to the real implementation.

The coordinator then invoked those already-captured methods. Two database callbacks, two evaluation-checkpoint callbacks,
two standing-policy callbacks, one ready-policy callback, and eight no-relay-checkpoint callbacks executed. Nevertheless,
the exact fake was contacted once and the coordinator returned `acknowledged_repository_simulation`; canonical truth held
one ready job and one internal handoff with zero attempts and zero leases. The callback counter is only the proof payload.
The same admitted methods can perform any ambient operation available to the host before delegating.

This is also a concrete alternate runtime client boundary. `src/persistence/database.ts:17-50` exports
`createPostgresClient`, whose returned object satisfies the same unbranded `DatabaseClient` accepted by `CanonicalStore`
and performs networked PostgreSQL operations. No network was contacted in this review, but nothing in the AUTO-040 service
or coordinator binders prevents a `CanonicalStore` constructed from that client from receiving the exact frontier brand.
The claim that the composed repository simulation structurally has no network/effect client is therefore false even though
the default PGlite fixture is safe and the fake delivery itself remains exact.

This is High for the same reason as the original SAR-001: arbitrary host behavior executes inside a run that is then
authenticated as acknowledged. False effect flags, exact receipts, and one fixed fake contact cannot erase behavior already
executed at a nested persistence/checkpoint seam.

**Required remediation:** make repository-simulation database and checkpoint provenance exact, not structurally typed.
The AUTO-040 canonical binder should accept only a canonical store constructed by a privately registered repository
adapter/factory whose complete implementation and receiver state are runtime-private and non-caller-mutable. Generic
PostgreSQL canonical stores may remain available to other contracts but must not acquire the AUTO-040 repository-simulation
brand. Each SQLite store must likewise retain only operations from an exact registered checkpoint implementation or a
module-private capability/factory; binding an arbitrary receiver method is insufficient, even if the outer store is frozen.
Add post-construction receiver-state and closure-state mutation probes, ordinary duck-port probes, networked database-client
rejection, Proxy/accessor zero-trap checks, and subclass checks for each port. Rejection must occur before canonical or
no-relay mutation, execute zero hostile behavior, contact the fake zero times, and produce no eligible run or packet. A
fresh different independent reviewer must then repeat every earlier SAR path and this receiver-delegate path.

## Durability note

The accepted durability report remains immutable and correctly bounded to first-remediation commit
`8344dd698bc8bc2786b611fdb246e9e5aca3dc4e`. I did not redo that review merely for form. The current focused and combined
tests show no separate regression in direct-store capability, start-state replay, deadline chronology, or terminal-row
capacity. The new High seam does reach rollback-checkpoint operations and therefore also undermines provenance of durable
evidence when exploited, but the reproduced defect is recorded once as a security/authority callback-path failure rather
than relabeling or rewriting any accepted `DR` disposition.

## Residual and negative-authority boundary

The exact fake, both fixed clocks, frozen PGlite adapter, outer stores, canonical operations, materialization and promotion
services, coordinator, direct-store capability, activation packet, and read-only projection behave correctly on their
intended exact paths. No alternate delivery consumer or activation executor was found. The rejected Proxy/subclass and
mutation paths executed zero hostile behavior and left zero pre-run marker, canonical, fake, or packet result.

This review made no live network, database-service, credential, provider, agent, GitHub, native-profile, DNS, Cloudflare,
hosting, schedule, claim, lease, dispatch, execution, deployment, production-policy enrollment, or external-effect contact.
Protected production policy/clock/key/checkpoint custody, hosted PostgreSQL, multi-process convergence, a qualified real
consumer, credential brokerage, cross-service ambiguity reconciliation, production independent review, and fresh owner
approval remain unimplemented and blocked. AUTO-040 also remains open until the High receiver-alias finding is remediated
and accepted by another fresh independent reviewer.

REJECTED_SECURITY_AUTHORITY_SECOND_REMEDIATION_FINDINGS

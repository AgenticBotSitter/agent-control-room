# CR11B-AUTO-040 security and authority third-remediation re-review

**Disposition:** rejected; one High security/authority finding remains
**Exact reviewed commit:** `3a9972ff18f07d1f9e2e832f42893a490f239ef9`
**Compared second-remediation commit:** `033b9ef81439f30ed88dc9727ffe32e9f32e6e69`
**Branch observed:** `codex/cr11b-auto-040-no-relay-simulation`
**Review date:** 2026-08-30
**Reviewer:** fresh independent Codex security/authority reviewer; not the implementation author or an earlier AUTO-040 reviewer
**Mode:** owner-authorized, report-only review; no implementation, test, contract, status, prior-report, git-metadata, credential, provider, agent, GitHub, network, deployment, or production-effect change

## Exact snapshot and preserved evidence

Preflight returned exact `HEAD` `3a9972ff18f07d1f9e2e832f42893a490f239ef9`, parent
`033b9ef81439f30ed88dc9727ffe32e9f32e6e69`, branch `codex/cr11b-auto-040-no-relay-simulation`, and an empty porcelain
status. I read `AGENTS.md`, the active build status, the complete AUTO-040 contract and acceptance record, ADR-105 through
ADR-108, and all five existing AUTO-040 reports. Their byte-for-byte SHA-256 values remained:

- initial security/authority: `aed60806370152b6136857d32ae3cbd973f24975add5578af5c553cc2f708a3d`;
- initial durability/replay: `ac2fbad63eed913ea95b185e35d1b905b72614b643ce6b6a80eb97d9a8019515`;
- rejected first-remediation security: `14405beb724bf29f08f6ed4747d247f88ab19efbf6d3763e38d20481f5aef6dc`;
- accepted first-remediation durability: `392af82a4462c6cccc8ea2098b248962b95a1a49331b0ae5aa4f69edb7600e6a`; and
- rejected second-remediation security: `b2812a4cba936eba688343e3e21d52fe92a1e3977193e291882ce48f6cfb48eb`.

The exact third-remediation delta changes sixteen paths with 554 insertions and 64 deletions, including preservation of
the fifth report. `git diff --check` over the delta excluding that immutable Markdown report passed. The preserved report
contains its pre-existing deliberate two-space Markdown line breaks and was not altered. No GitHub or provider query was
made because this review expressly prohibited that contact; local history, documents, implementation, tests, and immutable
reports defined the review boundary.

## Commands and observed results

| Command or independent probe | Observed result |
|---|---|
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; Node `>=22.13.0`, pnpm `11.19.0`, `tsx` and `zod` resolved; no native attempt |
| `node --import tsx --test tests/ready-frontier-no-relay.test.ts` | 19/19 passed; zero failures or skips |
| `pnpm test:cr11b` | 86/86 passed; zero failures or skips |
| `pnpm check` | Exit 0; `tsc --noEmit` passed |
| `pnpm lint` | Exit 0; full ESLint gate passed |
| Independent rejected-database composition matrix | Generic `adaptPglite`, a mutable delegate duck, a null-prototype ordinary client, an inherited wrapper, and `createPostgresClient` were unable to bind the no-relay coordinator. Accessor and Proxy database inputs were rejected with zero getter calls and zero Proxy traps. Across five composition attempts there were zero delegate callbacks, zero fake contacts, zero no-relay rows, zero canonical jobs/handoffs/attempts/leases, and no eligible run or activation packet. The PostgreSQL client was constructed but never queried; no network request occurred. |
| Independent four-checkpoint-seam matrix | Duck, accessor, Proxy, subclass, inherited-wrapper, and prototype-drift values were tried against each of the simulation, standing-policy, ready-policy, and no-relay stores: 24/24 constructions rejected before file creation, with zero callbacks, getters, or Proxy traps. |
| Independent post-construction mutation and ordinary exact-path probe | Added checkpoint delegates/own methods, changed checkpoint prototypes, attempted exact-client mutation, changed the shared PGlite prototype after factory construction, and attempted nested store/service/fake/clock method replacement. Zero hostile callbacks executed. The exact path acknowledged, exact replay was inert, the fake count remained one, canonical truth held one ready job/reservation/handoff and zero attempts/leases, a clone was activation-ineligible, and the exact packet remained `blocked_pending_production_proof` with no self-activation or effect permission. |
| Independent pre-factory PGlite prototype-variation probe | Replaced only the writable/configurable shared PGlite base `transaction` method before calling `createRepositorySimulationDatabaseV1`, while delegating to the original implementation. The factory privately branded the resulting client. The hostile wrapper executed twice inside the composed path, which still returned `acknowledged_repository_simulation`, contacted the fake once, created one ready job/reservation/handoff, created zero attempts/leases, and produced an eligible but blocked activation packet. |
| Static import, registry, and call inspection | No alternate delivery consumer, activation executor, timer, agent/provider/GitHub client, credential client, claim/lease/dispatch/execution call, HTTP client, or network call exists in the coordinator, no-relay store, fixed fake, or activation builder. `createPostgresClient` remains a generic unrelated persistence client and does not receive the repository brand. `createRepositorySimulationDatabaseV1` is referenced only by the AUTO-040 test composition. |

The temporary probes used only in-process repository modules, PGlite, private local temporary directories, and fake values.
They were removed before this report was written. No credential, native read, service, network, provider, agent, GitHub,
deployment, production activation, or external effect was used.

## Intended third-remediation boundary

The third remediation correctly closes the exact mutable receiver-delegate paths recorded in `AUTO040-SSRR-001` for
caller-supplied ports:

- only the frozen client in the module-private `repositorySimulationDatabaseClients` registry can mark its exact
  `CanonicalStore` as repository-simulation eligible;
- generic `adaptPglite`, ordinary interface-compatible clients, inherited wrappers, null-prototype ducks,
  `createPostgresClient`, accessor-bearing values, Proxies, and canonical subclasses cannot acquire that brand or enter the
  no-relay coordinator;
- all four checkpoint seams accept only an exact instance registered by the base
  `InMemoryRollbackCheckpointStoreV1` constructor with its exact prototype; and
- checkpoint operations call base methods captured at module evaluation over ECMAScript-private map state, while the
  accepted database client is frozen and its factory captures bound operations. Later receiver, delegate, own-method, and
  prototype changes did not alter captured behavior.

Rejected compositions reached no canonical or no-relay mutation, fake contact, eligible run, or packet. The ordinary exact
composition still completed and replayed exactly. The focused and combined gates also reproduced thrown/malformed/early/
late terminal ambiguity without retry, expiry before contact, invalid-preflight rejection, unsettled-marker restart
reconciliation without redelivery, changed request/start/completion rejection, row tamper and complete-database rollback
detection, terminal-capacity preflight, zero attempts/leases, blocked activation, sanitized projection truth, and absence of
an alternate consumer/effect client.

Those results close the literal post-construction receiver-delegate exploit but do not establish the broader exact-source
invariant because the factory can privately register behavior selected through a previously changed shared prototype.

## Prior finding dispositions

### AUTO040-SAR-001 — exact prior exploits closed; broader arbitrary-callback invariant remains open

The original writable coordinator-property attack and the first-remediation nested simulation-store alias attack remain
closed. Exact outer objects are registered and frozen, collaborator calls use captured base operations or closures, and the
independent later-mutation matrix executed zero hostile behavior. The broader invariant cannot be closed because
`AUTO040-STRR-001` below executes caller-selected code inside acknowledged success through the supposedly exact repository
database source.

### AUTO040-SAR-002 — closed with no regression

The activation builder snapshots its exact input once without executing accessors or Proxies, requires exact process-local
eligible-run identity, and authenticates the same creation time it checks. A cloned run remained ineligible. The ordinary
packet included the exact accepted AUTO-030 evidence and complete ordered production gates, remained blocked, and granted
no authority.

### AUTO040-DR-001 through AUTO040-DR-004 — closed for the documented repository slice; no durability regression found

Direct store mutation remains protected by the module-private coordinator capability; changed initial state is exact replay
drift; start/deadline and completion chronology remain enforced; and capacity reserves the marker plus terminal record
before canonical mutation. Focused tests independently exercised exact replay, restart recovery, ambiguity, tamper,
complete-database rollback, and capacity. The accepted durability report remains immutable and bounded to
`8344dd698bc8bc2786b611fdb246e9e5aca3dc4e`; this review found no new durability defect distinct from the provenance
failure below.

### AUTO040-SSRR-001 — literal generic-receiver attack closed; exact private provenance remains incomplete

Mutable generic database/checkpoint receivers, network-capable PostgreSQL, inherited wrappers, accessors, Proxies,
subclasses, and post-construction delegate/prototype mutation no longer execute inside the no-relay composition. The exact
remediation requirement was broader, however: the privately branded client must have exact implementation provenance.
`AUTO040-STRR-001` shows that the factory can brand a client whose captured operation came from a caller-varied shared
prototype, so the security invariant motivating `SSRR-001` remains open.

## Finding

### AUTO040-STRR-001 — High — the private factory brands a pre-varied shared PGlite prototype operation that executes inside acknowledged success

`createRepositorySimulationDatabaseV1` dynamically imports PGlite, constructs an instance, and then obtains `query`,
`transaction`, `exec`, and `close` through ordinary property access before binding them
(`src/persistence/database.ts:41-49`). PGlite's `query`, `transaction`, and `exec` implementations reside on a shared base
prototype whose descriptors are writable and configurable. The factory does not capture or validate those implementation
identities before a caller can vary that shared prototype. It nevertheless places the newly built client into the private
repository registry solely because the factory built it (`database.ts:67-73`). The later canonical and service brands then
correctly preserve that already-contaminated operation.

The independent probe imported PGlite, replaced only the shared base `transaction` implementation with a harmless counting
wrapper that delegated to the original implementation, and then called the repository factory. It did not mutate the
returned client, raw receiver, canonical store, services, coordinator, fake, clocks, or checkpoints. The factory captured
and privately branded the wrapper. During one ordinary run it executed twice, yet the coordinator returned an authenticated
`acknowledged_repository_simulation` result, contacted the exact fake once, and made the expected ready/reservation/handoff
writes. The exact acknowledged run was activation-eligible and produced the blocked packet.

The counter is only the proof payload. The admitted wrapper can perform any ambient action available to the host before
delegating. A blocked packet and false effect flags cannot erase behavior that already executed in the composed run. This
is High for the same authority-boundary reason as `AUTO040-SAR-001` and `AUTO040-SSRR-001`: structural repository evidence
can authenticate success after arbitrary host behavior at a persistence seam.

The smallest safe remediation is to make implementation identity part of the private factory boundary before any exported
factory call can observe a caller-varied PGlite prototype. Capture and validate the required PGlite base operations in a
module-private initialization path, freeze or otherwise make the accepted prototype surface immutable, and reject any
prototype/descriptor/implementation drift before creating or registering a client. Add a pre-factory prototype-variation
probe for `query`, `transaction`, and `exec`, in addition to the existing post-construction probes. Rejection must occur
before canonical/no-relay mutation with zero hostile callbacks, zero fake contact, no eligible run, and no packet. A fresh
different independent reviewer must then repeat every `SAR`, `SSRR`, and `STRR` path.

## Residual and negative-authority boundary

No alternate production consumer or activation executor was found. The exact fake, packet flags, ordinary completion,
replay, ambiguity, restart, rollback, capacity, and zero-attempt/zero-lease behavior remain valid on their exercised paths.
They cannot convert the reproduced prototype-provenance callback into acceptance.

Protected production policy and clock/key/checkpoint custody, hosted PostgreSQL, multi-process convergence, a qualified
consumer channel, credential brokerage, cross-service ambiguity reconciliation, production independent review, and fresh
owner approval remain unimplemented and blocked. This review made no live network, credential, provider, agent, GitHub,
native-profile, DNS, Cloudflare, hosting, schedule, claim, lease, dispatch, execution, deployment, production-policy
enrollment, or external-effect contact. AUTO-040 remains open and production activation remains unauthorized.

REJECTED_SECURITY_AUTHORITY_THIRD_REMEDIATION_FINDINGS

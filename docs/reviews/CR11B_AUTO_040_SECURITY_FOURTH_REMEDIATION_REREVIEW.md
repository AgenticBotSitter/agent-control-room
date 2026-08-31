# CR11B-AUTO-040 security and authority fourth-remediation re-review

**Disposition:** accepted for the exact effect-free, single-process repository-simulation slice; production activation remains blocked
**Exact reviewed commit:** `fb549ebbcf5a2cbd9ca3d3cbef6842578e280074`
**Exact reviewed tree:** `b72c6e7f6b5a0b5e2745789d7d8d2922df987821`
**Compared third-remediation commit:** `3a9972ff18f07d1f9e2e832f42893a490f239ef9`
**Branch observed:** `codex/cr11b-auto-040-no-relay-simulation`
**Review date:** 2026-08-30
**Reviewer:** fresh independent Codex security/authority reviewer; not the implementation author or an earlier AUTO-040 reviewer
**Mode:** owner-authorized local report-only re-review; no implementation, test, contract, status, prior-report, git-metadata, credential, provider, agent, GitHub, network, deployment, or production-effect change

## Exact snapshot and preserved evidence

Preflight returned exact `HEAD` `fb549ebbcf5a2cbd9ca3d3cbef6842578e280074`, parent
`3a9972ff18f07d1f9e2e832f42893a490f239ef9`, tree `b72c6e7f6b5a0b5e2745789d7d8d2922df987821`, branch
`codex/cr11b-auto-040-no-relay-simulation`, and an empty porcelain status. I read `AGENTS.md`, the active build status,
the complete AUTO-040 contract and acceptance record, ADR-106 through ADR-109, and every prior AUTO-040 report. The six
immutable report SHA-256 values matched the recorded values byte for byte:

- initial security/authority: `aed60806370152b6136857d32ae3cbd973f24975add5578af5c553cc2f708a3d`;
- initial durability/replay: `ac2fbad63eed913ea95b185e35d1b905b72614b643ce6b6a80eb97d9a8019515`;
- rejected first-remediation security: `14405beb724bf29f08f6ed4747d247f88ab19efbf6d3763e38d20481f5aef6dc`;
- accepted first-remediation durability: `392af82a4462c6cccc8ea2098b248962b95a1a49331b0ae5aa4f69edb7600e6a`;
- rejected second-remediation security: `b2812a4cba936eba688343e3e21d52fe92a1e3977193e291882ce48f6cfb48eb`; and
- rejected third-remediation security: `98265a5b35b19a049c9221c97bf892076b273feb494ff31ed885f22192b3cba4`.

The exact fourth-remediation delta changes nine paths with 471 insertions and 23 deletions, including preservation of the
third-remediation report. The implementation delta adds `src/persistence/pglite-provenance.ts`, changes only the dedicated
repository-simulation factory/session handling in `src/persistence/database.ts`, and extends the focused AUTO-040 test.
Generic PGlite and PostgreSQL adapters remain available for their earlier contracts. `git diff --check` over the delta
excluding the newly preserved immutable third-remediation report passed. That report was not altered.

The package manifest pins `@electric-sql/pglite` exactly to `0.3.14`; the frozen lockfile resolves the same exact version.
The observed lockfile SHA-256 was `48af07084f582b02c5c1827e5816df9bf8a3cd8643dbd22ba041807cd9e2383a`.
This review was intentionally local. No issue, pull-request, provider, or other remote metadata was queried, so this report
makes no claim about current remote coordination state.

## Commands and independently observed results

| Command or independent probe | Observed result |
|---|---|
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; exact Node and pnpm floors, frozen lockfile, `tsx`, and `zod` resolved; no native attempt |
| `node --import tsx --test tests/ready-frontier-no-relay.test.ts` | 20/20 passed; zero failures or skips |
| `pnpm test:cr11b` | 87/87 passed; zero failures or skips across AUTO-000/010/020/030/040 and views |
| `pnpm check` | Exit 0; `tsc --noEmit` passed |
| `pnpm lint` | Exit 0; full ESLint gate passed |
| Independent complete pre-factory PGlite descriptor matrix | Every one of the 34 executable method/getter descriptors across the exact leaf and base prototypes was replaced separately before factory construction. All 34 factory calls rejected implementation drift; changed callbacks executed zero times. No repository database, canonical record, no-relay record, or delivery was created. |
| Independent post-factory shared-descriptor and private-receiver probe | After exact private receiver creation, all 34 shared executable descriptors were changed together. Migrations, exact composition, acknowledgement, exact replay, queries, and close continued through the sealed receiver; changed callbacks executed zero times. Later own-method/delegate changes on all four accepted checkpoint objects also executed zero times. |
| Independent alternate database matrix | Ordinary mutable duck, inherited wrapper, null-prototype ordinary client, generic `adaptPglite` client, and network-capable PostgreSQL client each failed the repository coordinator brand gate. Across five rejected compositions there were zero changed callbacks, zero delivery, zero no-relay rows, and zero canonical requests, workflows, jobs, handoffs, attempts, or leases. The PostgreSQL client was never queried; no network contact occurred. |
| Independent four-checkpoint-seam matrix | Duck, accessor, Proxy, subclass, and inherited checkpoint objects were each tried against simulation, standing-policy, ready-policy, and no-relay stores. All 20 constructions rejected before file creation with zero callbacks, getter calls, Proxy traps, or retained files. |
| Independent normal exact path | Returned `acknowledged_repository_simulation`; exact replay was inert; the fixed fake count remained one; canonical truth contained one ready job, one reservation, one handoff, zero attempts, and zero leases. The exact activation packet remained `blocked_pending_production_proof`, `canActivateItself: false`, and `productionOwnerApprovalPresent: false`. |
| Static import and call inspection | No alternate delivery consumer, activation executor, timer, agent/provider/GitHub client, credential client, HTTP/fetch call, child process, claim, lease, dispatch, or execution call exists in the no-relay coordinator/store/fake/activation or new provenance module. The generic networked database adapter is separately exported but cannot receive the repository-simulation brand. |

The temporary reviewer probe used only in-process repository modules, PGlite, private local temporary directories, and fake
values. It was removed before this report was written. It made no service, credential, native-read, provider, agent,
GitHub, DNS, hosting, deployment, production-policy, or external-effect contact.

## Fourth-remediation correctness and provenance determination

The fourth remediation closes the exact `AUTO040-STRR-001` pre-factory shared-prototype path.

`createExactPgliteReceiverV1` captures safe host reflection and function-source operations at module evaluation. Before
constructing a receiver, it verifies the exact PGlite constructor source, its non-replaceable `prototype` descriptor, the
exact leaf-to-base-to-`Object.prototype` chain, exact own-key sets, descriptor kinds and flags, absence of callable Proxies,
and SHA-256 source identity for every executable descriptor on both prototype levels. It additionally requires the leaf
constructor descriptor to point to the exact checked class. Validation and receiver construction/sealing are synchronous,
so there is no event-loop handoff between the checked surface and its installation.

The factory then installs the verified method/getter surface as non-writable, non-configurable own descriptors on the
withheld receiver. It binds `query`, `transaction`, `exec`, and `close` only from the captured verified functions, freezes
the exposed client, and gives the repository-simulation WeakSet brand only to that exact client. The raw receiver is not
returned by `createRepositorySimulationDatabaseV1`. Later shared-prototype assignment therefore cannot change direct
operations or the internal dynamic dispatch performed by the pinned PGlite methods.

The transaction callback introduces a separate PGlite-created session object. Static inspection and a local runtime shape
check confirmed that PGlite 0.3.14's verified `transaction` implementation creates a null-prototype transaction value with
an own `query` data function closing over the verified receiver internals. The repository adapter obtains only that data
method through `dataMethodV1`, rejects an accessor, Proxy, or missing method, and binds it to the transaction value. This
does not reopen the shared PGlite prototype path and preserves the existing pre-commit-check transaction behavior.

The independent full-descriptor matrices are stronger than the five named producer probes: all 34 executable descriptors
were varied before factory construction and again after private receiver creation. Pre-factory changes were rejected before
the changed functions/getters could execute. Post-factory changes did not enter migrations, transaction callbacks, normal
acknowledgement, replay, queries, or cleanup. `AUTO040-STRR-001` is closed on this exact commit.

## Private receiver, compatibility, and earlier-finding determination

The repository-only brand remains separated from structural database compatibility. A generic `CanonicalStore` and the
earlier generic materialization/promotion services may still be constructed for their accepted standalone contracts, but
the no-relay coordinator binds only services carrying the exact repository-canonical brand. The independent five-client
matrix reached that rejection before any evaluation, policy, canonical, no-relay, or fake-delivery behavior. In particular,
the still-exported networked PostgreSQL client was never queried and cannot enter AUTO-040 merely by satisfying
`DatabaseClient`.

All four rollback-checkpoint seams still bind only the privately registered exact in-memory reference implementation and
invoke captured base operations over ECMAScript-private state. Ordinary ducks, inherited wrappers, accessors, Proxies, and
subclasses rejected without callbacks or file creation. Later aliases and own methods on accepted checkpoint receivers were
ignored. The literal receiver-delegate attack from `AUTO040-SSRR-001` remains closed.

The original coordinator-property and nested simulation-store attacks from `AUTO040-SAR-001` remain closed by exact frozen
outer objects, captured base operations/closures, private collaborator state, and coordinator brand checks. The focused
suite repeated assignment, deletion, `defineProperty`, Proxy, subclass, own-method, prototype, fake, clock, and direct-store
capability cases. Rejected paths created no acknowledged result or delivery. With both `SSRR-001` and `STRR-001` now closed,
the broader arbitrary-callback invariant underlying `SAR-001` is closed for this repository slice.

`AUTO040-SAR-002` remains closed. Activation input is snapshotted without accessor or Proxy execution, only the exact
process-local frozen acknowledged run is eligible, the checked creation time is the authenticated time, and cloned evidence
is denied. The independent exact packet remained complete, separately keyed, blocked, non-self-activating, and without
production owner approval.

`AUTO040-DR-001` through `AUTO040-DR-004` remain closed with no regression. The focused and combined gates repeated direct
store capability denial, exact start-state replay, deadline chronology, terminal-capacity preflight, marker-before-contact,
thrown/malformed/early/late ambiguity without retry, unsettled-marker restart reconciliation without redelivery, changed
request/start/completion rejection, row tamper, and complete-database rollback detection. The ordinary exact path contacted
the fixed fake once, replayed without another contact, created no attempt or lease, and retained blocked activation.

The change is deliberately compatibility-narrow: exact PGlite source/descriptor drift now fails closed and a dependency
upgrade requires explicit manifest review and new evidence. Generic PGlite/PostgreSQL behavior outside AUTO-040 was not
removed. The combined CR11B gate, typecheck, and full lint found no source, type, earlier-frontier, or view regression.

## Alternate effect inspection and findings

No concrete defect was found. The fixed fake remains the only delivery implementation accepted by the coordinator, and its
captured base method has no callback, locator, network, filesystem, process, credential, agent, provider, GitHub, claim,
lease, dispatch, execution, or external-effect seam. The repository database factory is test-only; its only callers in the
reviewed tree are AUTO-040 tests. No production consumer, activation executor, or control was added by the fourth-remediation
delta. A blocked packet and repository acknowledgement still grant no operational capability.

## Residual and negative-authority boundary

Acceptance is bounded to the exact local, effect-free, single-process snapshot. Runtime function-source and descriptor
pinning proves the installed PGlite 0.3.14 prototype surface used here; it is not hostile-process isolation, protected
dependency-distribution custody, or hosted-database qualification. Protected production policy, clock, key, and checkpoint
custody; hosted PostgreSQL; multi-process convergence; a qualified real consumer channel; credential brokerage;
cross-service ambiguity reconciliation; production independent review; and fresh owner approval remain unimplemented and
blocked.

This review did not enroll a standing policy, create a schedule, claim or lease work, dispatch or execute a job, contact an
agent/provider/GitHub/service, access a credential or native profile, use DNS or hosting, deploy, or perform a production
effect. Exact-slice acceptance does not authorize any of those actions and does not reinterpret any earlier immutable
negative report.

ACCEPTED_SECURITY_AUTHORITY_FOURTH_REMEDIATION

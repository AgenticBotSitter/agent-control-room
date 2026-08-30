# CR-7Q independent remediation re-review

**Reviewed snapshot:** `14de468999b1ebf4584c13026114d40a0f66cea7` plus the owner-held local CR-7A through CR-7Q working tree present on 2026-08-28.
**Mode:** Independent, read-only repository acceptance review.
**Reviewer independence:** This reviewer did not author the CR-7 implementation, the architect remediation, `CR7Q_INDEPENDENT_REVIEW.md`, or any of the eight repairs reviewed here.
**Effects:** Repository reads, static analysis, and the packet's existing deterministic tests only. No source, migration, test, configuration, dependency, or lockfile was changed. No provider, credential, account, network, service, deployment, GitHub, commit, or push operation was used.

## Overall disposition

`accepted_with_explicit_native_and_deployment_blockers`

The eight findings in `CR7Q_INDEPENDENT_REVIEW.md` are remediated in the reviewed local candidate. I found no remaining evidence-backed repository defect in those repairs or in their CR-7 boundary composition. The acceptance is limited to the effect-free repository implementation. It does not authorize native Hermes or Codex execution, MCP deployment, third-party adapter execution, a protected registry service, or any production effect.

## Remediation determinations

| Prior finding | Determination | Independent evidence |
|---|---|---|
| `CR7Q-IR-F01` — harness normalized rows and complete history were not integrity-bound | **Confirmed remediated** | Migration `0020` requires keyed authentication tags for runs and events. `src/harness/v1/store.ts:18-24` loads the complete ordered event history with every normalized event column; `:40-63` validates payload digests, keyed tags, every normalized run/event field, exact consecutive sequence, tenant/run binding, and `events.length === last_sequence`; `:84-85` and `:114-117` authenticate all writes. Recomputed JSON/SHA rows, normalized-column drift, insertion gaps, deletion, and `last_sequence` drift therefore fail without the external key. The focused regression at `tests/harness-run-store.test.ts:64-80` passed. |
| `CR7Q-IR-F02` — the Codex durable broker trusted tampered permit and limit state | **Confirmed remediated** | `src/harness/codex-v1/credential-broker-sqlite.ts:35-55` enforces exact limit keys and reparses each stored permit with exact issuer shape, digest, endpoint, scope, call budget, and lifetime rules. `:85-90` requires a 256-bit external integrity key; `:120-178` authenticates the entire durable grant/call/thread/clock state and validates every stored grant before recovery; `:406-452` checks and refreshes the keyed state tag inside every transaction. Claim, dispatch authorization, settlement, thread resolution, close, and evidence all consume authenticated state. The recomputed permit/limit widening regression passed. |
| `CR7Q-IR-F03` — SDK prototypes, descriptors, accessors, proxies, or async mutation could widen the adapter | **Confirmed remediated** | `src/harness/sdk-v1/conformance.ts:20-49` accepts only frozen plain objects with exact own string data descriptors and recursively frozen data; symbols, accessors, writable/configurable descriptors, foreign prototypes, and proxy-visible widening fail. `:51-56` creates a new exact frozen four-member adapter and deeply freezes returned decisions and normalized frames. `:74-94` snapshots exact adapter and compatibility shapes before use, while `:96-135` revalidates exact frozen normalized output, lineage, sequence, timestamp, source-event uniqueness, digest format, and secret safety. The hostile prototype/descriptor/accessor/symbol regression passed. This does not make arbitrary third-party adapter code safe to execute; that remains a deployment blocker. |
| `CR7Q-IR-F04` — an MCP replay could be released after grant expiry | **Confirmed remediated** | `src/mcp/v1/server.ts:212-214` rechecks the trusted monotonic clock immediately before replay release and validates the stored result for the exact current tool, tenant, project scope, arguments, and result schema. `:355-366` rejects rollback and expiry. The expiry-on-replay regression at `tests/mcp-server-contract.test.ts:218-224` passed. |
| `CR7Q-IR-F05` — an MCP proposal could be written after expiry during asynchronous authority resolution | **Confirmed remediated** | Proposal persistence is synchronous in `src/mcp/v1/types.ts:186-188`. After asynchronous parent-authority resolution and narrowing checks, `src/mcp/v1/server.ts:294-313` performs a final grant-current check immediately before the synchronous record operation. The expiry-after-resolve regression at `tests/mcp-server-contract.test.ts:225-230` passed and recorded no proposal. |
| `CR7Q-IR-F06` — recomputed MCP durable rows were not bound to request/tool/tenant/scope | **Confirmed remediated** | `src/mcp/v1/sqlite-state.ts:146-175` persists and verifies exact request digest, tool, tenant, project-scope digest, and grant-body digest before replay, then validates the canonical stored result. `:271-285` authenticates the complete replay/proposal state with the external integrity key. `src/mcp/v1/server.ts:316-353` validates replay output against the selected tool's exact receipt or read schema and tenant/project/job arguments before release. Proposal rows are likewise schema-, key-, tenant-, ID-, digest-, receipt-, decision-, and chronology-bound at `src/mcp/v1/sqlite-state.ts:87-101`. The recomputed secret-result and proposal-expansion regression passed. |
| `CR7Q-IR-F07` — registry mappings could overclaim verbs or drift from the manifest | **Confirmed remediated** | `src/package-registry/v1/compatibility.ts:16-22` requires the verified verb set to exactly equal the package declaration and requires every claimed verb to be supported by the manifest. `src/package-registry/v1/store.ts:143-161` stores the exact strict manifest and its digest inside the immutable authenticated mapping; `:242-249` revalidates both on read; `:288-295` reruns compatibility whenever a verified mapping is consumed. Missing and extra verb, manifest drift, and self-mapping regressions passed. |
| `CR7Q-IR-F08` — inserted recomputed registry rows could synthesize active history | **Confirmed remediated** | Migration `0021` requires keyed authentication tags on package, review, mapping, promotion, and channel rows while append-only triggers retain update/delete/truncate protection. `src/package-registry/v1/store.ts:225-269` compares every normalized row field with strict parsed payloads and validates ordinary digests plus keyed tags. `:298-319` reconstructs the entire consecutive promotion chain from revision 1, checks prior links, action semantics, chronology, package binding, independent accepted review, independent compatible manifest mapping, and exact latest channel pointer. `:205-222` uses that reconciliation for resolution and history and rejects orphan promotion channels. Recomputed mapping, inserted promotion, and pointer-rewind regressions passed. |

## Required explicit determinations

### Authority grant, spend, or widening

- No public SDK, MCP, registry, or harness-observation path grants or widens a canonical authority envelope, lease, reservation, owner approval, credential, dispatch, effect claim, or native eligibility.
- MCP access grants authorize only the listed scoped read/proposal protocol operations. Proposal receipts remain literal `grantsAuthority: false` and `dispatchCreated: false`; no canonical proposal materializer exists in the reviewed boundary.
- Registry resolution remains literal negative authority and policy evidence: `grantsAuthority`, `suppliesPolicy`, `canApprove`, `canDispatch`, and `canExecute` are all false.
- The Codex broker ledger can durably spend a separately provisioned provider-call allowance once when deliberately wired, but the replay and ambiguity paths do not redispatch and this repository review made no provider call. Native broker/executor deployment remains disabled.
- `HermesGatewayLifecycleClientV1` is an existing node-local effect-capable path when deliberately connected to a live transport. Only the already captured pinned, disposable, zero-callable-tool owner-attended evidence is accepted; effect-capable/native production use and approval response remain disabled.

### Durable replay and history

- Harness and registry PostgreSQL rows reject recomputed insert/update/substitution without their external integrity keys, and both read paths reconstruct complete consecutive history before returning trusted projections.
- Codex broker and MCP private SQLite state authenticate the complete durable security state with external keys and reject schema or row substitution before use. Exact terminal replay remains non-dispatching; uncertain Codex state remains ambiguous and its native handle is tombstoned.
- MCP replay is exact-request, tool, tenant, grant, and project-scope bound and is rechecked for grant expiry and output scope immediately before release.
- Complete database rollback is not claimed solved by an in-database tag. Codex trust pins still require the separate owner-controlled high-water checkpoint described below, and production integrity-key custody remains a deployment requirement.

### Adapter compatibility and observation lineage

- The accepted SDK conformance path cannot accept inherited, hidden, non-enumerable, accessor, symbol, writable, configurable, or non-plain top-level members. Compatibility decisions and normalized frames must be exact and deeply frozen.
- Registry mappings cannot claim undeclared or manifest-unsupported verbs, and the exact authenticated manifest is rechecked on every compatibility use.
- Harness event persistence binds payload, normalized scope, source identity digest, chronology, and complete sequence. No normalized observation substitutes for provider, OS, lease, approval, or effect evidence.
- Conformance is not a sandbox for arbitrary adapter implementation code. Third-party adapter execution requires a separately protected deployment boundary.

### Secret and private native identity boundaries

- I found no repository-produced raw credential, bearer token, prompt, response, transcript, filesystem locator, private host identity, raw Codex thread/turn ID, or raw Hermes session ID crossing the public SDK, MCP, registry, dashboard, or harness-store projections.
- Raw Hermes and Codex native handles remain inside explicit node-local lifecycle/broker modules. Public results expose only scoped digests.
- Secret scanning, exact safe projections, keyed durable-state authentication, and tool-specific replay validation prevent the previously described recomputed-row substitution from crossing tenant/project or private-identity boundaries.

## Cross-boundary composition

1. Registry selection supplies reviewed instructions or facts and authenticated compatibility evidence only.
2. The SDK normalizes bounded observations and produces no lifecycle or effect authority.
3. MCP reads scoped projections or records proposal-only intent. It does not materialize a canonical request or job.
4. Canonical materialization remains absent and deployment-disabled.
5. Scheduler eligibility, budget/resource reservation, signed lease authority, and complete authority envelopes remain separate CR-5/CR-6 gates.
6. Node-local ceiling/lease intersection, node/attempt/epoch binding, expiry, budget, target, and availability checks remain mandatory.
7. Approval-required effects still require a separately signed owner attestation plus a durable effect-scoped claim and pre-effect marker.
8. Hermes effect-capable operation and Codex native execution remain disabled outside their narrow historical owner-attended evidence. Shared IDs, digests, timestamps, replay keys, or optimistic revisions from CR-7 satisfy none of the omitted gates.

## Surface dispositions

| Surface | Repository disposition | Native or deployment disposition |
|---|---|---|
| Harness foundation | **Accepted** for authenticated, tenant-bound observation persistence | Cannot qualify native execution or supply lease/effect authority |
| Hermes | **Accepted only** for the exact pinned observation boundary and previously captured disposable zero-callable-tool lifecycle evidence | **Disabled** for effect-capable/native production use; approval response remains unqualified |
| Codex | **Accepted** for the effect-free repository contracts and durable broker remediation | **Disabled** for native execution pending every retained OS, credential, transport, cancellation, output-authority, and deployment proof |
| MCP | **Accepted** for the effect-free authenticated read/proposal repository boundary | **Disabled** for network, issuer, service, production database, and canonical materialization deployment |
| Public SDK | **Accepted** as an exact observation-only conformance boundary | Arbitrary adapter execution is not sandboxed or native-qualified |
| Registry | **Accepted** for authenticated immutable packages, mappings, and reconstructed history | **Disabled** for a protected mutation service/API, production key custody, and operational package selection |

## Native and deployment blockers retained

### Hermes

- The exact Hermes package/revision, disposable profile and workspace, ignored context files, `context_engine` zero-callable-tool selection, observed zero callable tools, and zero MCP servers remain mandatory for the previously accepted evidence.
- Approval response remains unqualified and observe-only.
- Live transport authentication, durable private session-reference storage, canonical node/attempt/lease integration, production service wiring, and all effect-capable toolsets remain unaccepted.

### Codex

- Saved authentication was readable across the historical read-only command boundary; no further native attempt is authorized by this report.
- Authenticated broker/executor IPC under actually distinct OS identities remains unproved.
- Actual child image, UID, signature, argv, cwd, environment, realpath, owner, mode, device, and inode evidence remains unproved.
- Executor-bound turn receipts, provider-side hard output-limit authority, fresh signed OS evidence, confirmed remote interruption, and independently observed zero descendants remain unproved.
- Credential-store and ledger unreadability, broker-private provisioning/settlement, broker-only provider egress, executor egress denial, and trusted service deployment remain unproved.
- An actual owner-controlled rollback-resistant high-water checkpoint store remains absent. Repository bundle verification continues to return `nativeQualificationAuthorized: false`, and topology evaluation always returns `eligibleForDisposableQualification: false`.
- Owner-attended identity, permission, service, Keychain, and network-policy operations require separate exact authorization.

### MCP

- No network listener or transport, OAuth or production issuer, TLS termination, revocation/rotation operation, production service identity, durable trusted-clock deployment, protected production database, or canonical proposal materializer is accepted.
- No production endpoint, external client, credential access, or consequential effect is authorized.

### SDK and registry

- In-process conformance cannot prove arbitrary third-party adapter code is effect-free; a protected code-loading/execution boundary is still required.
- No protected registry mutation API/service, authenticated producer/reviewer/verifier deployment, operational current-manifest source, production integrity-key custody, production database, or live external-reference ingestion is accepted.
- Package and compatibility evidence never replaces canonical scheduling, signed lease authority, node-local admission, approval attestation, or durable effect claims.

## Reviewer verification evidence

All commands used the existing prepared dependencies and the frozen owner-held local snapshot.

| Command | Independent result |
|---|---|
| `npm run check` | Exit 0; TypeScript check passed |
| `npm run lint` | Exit 0 |
| `npm run test:cr7q` | Exit 0; 120 tests, 120 passed, 0 failed, 0 skipped |
| `npm test` | Exit 0; pretest 44/44 passed; complete suite 416 total, 414 passed, 0 failed, 2 skipped, 0 todo |
| `npm run build` | Exit 0; production build completed with the existing browser `node:crypto` externalization warning and route-classification caveat |
| `node --test tests/rendered-html.test.mjs` | Exit 0; 2 tests, 2 passed, 0 failed, 0 skipped |
| `npm run db:verify` | The first sandboxed attempt exited 1 because the managed sandbox denied the temporary local `tsx` IPC pipe with `listen EPERM`. The exact command was rerun unchanged in the permitted effect-free host context and exited 0; migrations `0001` through `0021` applied and 73 PostgreSQL tables were verified |
| `git diff --check` | Exit 0 |

The two full-suite skips are the existing Windows-only DPAPI tests on this macOS reviewer host. No test, source, or configuration was changed to obtain these results.

## Final review requirement

No additional independent CR-7Q repository review round is required for this stable local candidate. CR-7Q must be reopened if any reviewed security code, migration, contract, test, integrity-key boundary, manifest, or deployment assumption changes. The native and deployment blockers above remain mandatory and are not waived by this acceptance.

# CR-7Q independent combined security review

**Overall disposition:** `remediation_required`

**Reviewed base:** `14de468999b1ebf4584c13026114d40a0f66cea7` plus the owner-held local CR-7A through CR-7Q working-tree snapshot

**Reviewed branch:** `integration/cr5d-synthetic-executor-1`

**Review mode:** Independent, read-only adversarial review

**Reviewer independence:** The reviewer did not author the CR-7 implementation or the architect's CR-7Q remediations.

**Effects:** No install, download, network or GitHub access, credential or native-provider access, service operation, commit, push, source repair, migration edit, test edit, configuration edit, or dependency edit occurred. The only review output is this report.

## Verdict

The snapshot is not acceptable as the combined CR-7 boundary. Eight high-severity findings remain. They affect harness persistence, the Codex durable broker ledger, public SDK shape enforcement, MCP expiry and durable replay/proposal integrity, and registry compatibility and append-only history. The required verification commands are green after one sandbox-only `tsx` IPC retry, but the existing tests do not exercise the confirmed attack sequences.

No finding demonstrates a direct route from an MCP proposal, SDK observation, or registry package into a canonical lease, approval, dispatch, credential, or effect. Those gates are absent or remain separate and fail closed. The repository does, however, contain the deliberately effect-capable Hermes lifecycle client, which can spend a provider/native call when supplied a live transport; that surface remains disabled outside the exact previously captured owner-attended zero-callable-tool evidence. The SDK finding also lets a purportedly observation-only adapter expose an inherited effect method even though conformance returns compatible.

## Finding matrix

| Finding | Severity | Surface | Disposition |
|---|---:|---|---|
| CR7Q-IR-F01 | High | Harness persistence | Remediation required: normalized rows and complete event history are not integrity-bound |
| CR7Q-IR-F02 | High | Codex durable broker | Remediation required: stored permit and limit tampering can widen future provider authority |
| CR7Q-IR-F03 | High | Public SDK | Remediation required: prototype, descriptor, and proxy-visible effect members bypass exact shape |
| CR7Q-IR-F04 | High | MCP replay release | Remediation required: a replayed protected result can be returned after grant expiry |
| CR7Q-IR-F05 | High | MCP proposal mutation | Remediation required: grant expiry can occur before a durable proposal write |
| CR7Q-IR-F06 | High | MCP durable state | Remediation required: recomputed safe-looking rows are not request, tool, tenant, or scope bound |
| CR7Q-IR-F07 | High | Registry compatibility | Remediation required: mappings can claim undeclared and manifest-unsupported verified verbs |
| CR7Q-IR-F08 | High | Registry history | Remediation required: recomputed inserted rows can synthesize reviewed-and-active history |

## Detailed findings

### CR7Q-IR-F01 — harness normalized rows and complete event history are not integrity-bound

- **Severity:** High.
- **Exact location:** `src/harness/v1/store.ts:7-20`, `src/harness/v1/store.ts:32-35`, `src/harness/v1/store.ts:51-62`, and `src/harness/v1/store.ts:76-90`; the normalized columns and event keys are declared at `db/migrations/0020_cr7_harness_runs.sql:3-47`.
- **Attack or failure sequence:**
  1. Alter a mutable run payload and recompute `run_digest`, while leaving one or more normalized tenant, project, job, attempt, node, adapter, harness, native-session, creation, or lineage columns contradictory.
  2. `verifiedRun` parses the payload but compares only its digest, state, two timestamps, and `last_sequence` against the maximum stored event sequence. A tenant-scoped lookup can therefore return a payload claiming another scope or lineage.
  3. Separately insert a strict, recomputed event row with a contradictory normalized tenant/run/sequence/source/time value. `verifiedEvent` compares only the payload digest.
  4. Insert sequences `1` and `3`, then set the run's `last_sequence` and recomputed payload to `3`. The maximum is also `3`, so `get` accepts the gap. `events` does not reconcile the run at all and returns the gapped history.
  5. The append-only event triggers prevent update, delete, and truncate, but they do not prevent a writer from inserting a forged later event. Run rows remain intentionally mutable.
- **Violated invariant and affected surface:** Harness runs and events are claimed to be exact tenant/project/job/attempt/node-bound canonical evidence with monotonic append-only history. Unkeyed payload digests plus a maximum-sequence comparison do not bind the normalized row or prove a complete sequence. This can forge observation scope and lineage. The observations still do not become leases, approvals, credentials, dispatches, or effect authority.
- **Existing test coverage:** `tests/harness-run-store.test.ts:52-59` changes a run payload without recomputing its digest and checks event update/delete triggers. It should also have covered recomputed payload digests, normalized-column disagreement, inserted gaps, direct inserted lineage, and `events()`/`watch()` reconciliation.
- **Smallest safe remediation:** Select and compare every normalized run and event column against the strict parsed payload on every read and replay. Verify event count, first sequence, last sequence, and consecutive ordering, and reconcile `events()` with its run. Add database constraints where expressible. If a writer able to recompute all ordinary SHA-256 values is in scope, authenticate the history with a keyed MAC/signature or a hash-chain checkpoint anchored outside the mutable database; column comparisons alone cannot detect a fully recomputed consistent forgery.
- **Evidence impact:** This invalidates the CR7Q harness-integrity remediation claim and the repository-level CR-7A persistence evidence. It does not retroactively turn prior sanitized owner-attended Hermes evidence into authority, and it does not authorize native use.

### CR7Q-IR-F02 — Codex durable broker trusts tampered permit and limit JSON on security decisions

- **Severity:** High.
- **Exact location:** Provisioning validates the original values at `src/harness/codex-v1/credential-broker-sqlite.ts:190-210`, but claim reparses without strict permit or limit validation at `src/harness/codex-v1/credential-broker-sqlite.ts:213-252`; dispatch authorization again trusts the stored permit at `src/harness/codex-v1/credential-broker-sqlite.ts:268-280`. The available strict permit validator is `src/harness/codex-v1/credential-boundary.ts:77-91`.
- **Attack or failure sequence:**
  1. Provision a legitimate short-lived permit and bounded input/output limits.
  2. Preserve the exact SQLite schema but alter `codex_broker_grants.permit_json` and `limits_json` at rest. Extend expiry, change run/model, increase `maximumProviderCalls`, or enlarge the input/output limits. The self-digest inside the permit can be left stale.
  3. `claim` checks only row state, the parsed expiry, the request against the parsed run/model, and the parsed numeric budgets. It does not call `assertCodexCredentialBoundaryPermitV1`, compare the embedded permit digest to the row key, recheck endpoint identity, or call `assertLimits`.
  4. The altered row can therefore mint additional call claims or a broader dispatch ticket. `authorizeClaimedDispatch` checks the stored expiry and ticket equality but does not restore the missing permit validation.
- **Violated invariant and affected surface:** The broker-private ledger is the at-most-once provider-call authority boundary. Persisted permits must remain exact, short-lived, run/model/endpoint-bound, and limited to the issued call budget. Exact SQLite DDL is not row integrity.
- **Existing test coverage:** `tests/codex-harness-contract.test.ts:255-287` covers hostile schema objects, and `tests/codex-harness-contract.test.ts:290-311` covers clock/dispatch expiry. The durable broker tests should have altered `permit_json` and `limits_json` under the accepted schema, reopened the ledger, and required denial before claim and dispatch.
- **Smallest safe remediation:** Strictly parse and validate every stored permit and limit object on ledger open and before every claim, resume resolution, and dispatch authorization. Bind the embedded digest to the row key and endpoint identity, validate exact limit shape and bounds, and validate all stored ticket/call relationships. If direct row writers are in scope, authenticate permit and grant rows with a signature or MAC whose key is not stored in the same database; an attacker can otherwise insert a fully recomputed forged grant.
- **Evidence impact:** This invalidates the durable-broker repository integrity evidence and requires Codex repository remediation. It does not invalidate the historical disposable negative native evidence. Native Codex was already disabled by stronger unresolved OS, credential, IPC, output-authority, cancellation, and deployment blockers.

### CR7Q-IR-F03 — SDK exact-shape enforcement ignores prototype and descriptor-visible effect members

- **Severity:** High.
- **Exact location:** `src/harness/sdk-v1/conformance.ts:12-16` and `src/harness/sdk-v1/conformance.ts:35-46`; the same helper is also used for normalized outputs at `src/harness/sdk-v1/conformance.ts:62-70`.
- **Attack or failure sequence:**
  1. Create an adapter with exactly the four expected enumerable own keys but place `execute`, `start`, `approve`, or another effect method on its prototype, or define it as a non-enumerable own property.
  2. `Object.keys` sees only the four expected enumerable keys, so `exactKeys` passes and conformance can return `compatible: true`.
  3. Consumers of the accepted object still observe and can invoke the inherited or non-enumerable effect member.
  4. Required fields can also be accessor properties. Reading `sdkVersion`, `manifest`, or the functions executes caller code during conformance. A proxy can synthesize the expected key set while altering subsequent reads.
- **Violated invariant and affected surface:** CR7Q claims the public SDK accepts exactly four observation-only public members and rejects hidden effect methods. The current check proves only four enumerable own string keys at one instant. It neither proves a plain immutable data shape nor prevents side effects while checking an untrusted adapter.
- **Existing test coverage:** `tests/harness-sdk-contract.test.ts:71-82` adds an enumerable own `execute` property with object spread. It should also cover an inherited method, a non-enumerable property, symbols, accessors, proxy traps, and mutation between key enumeration and property reads.
- **Smallest safe remediation:** Require an allowed plain prototype, inspect `Reflect.ownKeys` and `Object.getOwnPropertyDescriptors`, reject symbols and accessors, require exact own data descriptors, copy/freeze a validated snapshot, and use the snapshot for all later reads. A proxy or arbitrary adapter function cannot be proven effect-free in-process; if adapters are untrusted, load data-only manifests and execute conformance in an isolated no-effect process rather than treating object reflection as a sandbox.
- **Evidence impact:** This directly invalidates architect remediation CR7Q-F04 and the current SDK conformance evidence. It does not itself dispatch work, but it can falsely bless a widened public adapter boundary.

### CR7Q-IR-F04 — MCP returns a replayed protected result without a current-grant check

- **Severity:** High.
- **Exact location:** `src/mcp/v1/server.ts:203-218`, especially the replay return at line 211.
- **Attack or failure sequence:**
  1. Present a valid access grant and a request identity that already has a complete replay row.
  2. Let the grant expire while the replay ledger performs its claim/read, or cross the expiry boundary immediately before the claim returns.
  3. The `replay` branch returns the stored protected result immediately. It does not call `assertGrantCurrent` before release.
  4. The normal execution branch does recheck at lines 214 and 216, so only the replay path bypasses the architect's promised before-release check.
- **Violated invariant and affected surface:** Authentication and authorization must be current on every request and immediately before releasing protected state. Replay must not outlive the grant that authorized the original request.
- **Existing test coverage:** `tests/mcp-server-contract.test.ts:209-214` expires a grant during a fresh asynchronous read. It should also pre-populate a replay, advance the clock during replay claim, and assert that the stored result is not returned.
- **Smallest safe remediation:** Recheck the signed grant with a fresh trusted-clock read immediately before returning every replayed protected result. Keep replay result validation and scope validation inside that release path.
- **Evidence impact:** This invalidates architect remediation CR7Q-F06 and the current MCP expiry evidence. It exposes data but still cannot create canonical work, approval, dispatch, credentials, or effects.

### CR7Q-IR-F05 — MCP can persist a proposal after grant expiry

- **Severity:** High.
- **Exact location:** `src/mcp/v1/server.ts:203-220` and `src/mcp/v1/server.ts:284-308`, especially the asynchronous authority resolution at lines 294-295 and proposal write at line 307.
- **Attack or failure sequence:**
  1. Enter `callTool` with a valid delegation-proposal grant and pass the current check at line 214.
  2. Delay `authorities.resolve` until the grant expires.
  3. The server validates the returned parent and immediately calls `proposals.record` without another trusted-time check.
  4. The final check at line 216 occurs only after the durable proposal write. The caller receives `request_failed`, but the expired request remains recorded and may later appear in internal review state.
- **Violated invariant and affected surface:** The MCP contract requires a second expiry check immediately before durable mutation. A post-mutation check can protect response release but cannot undo an unauthorized durable write.
- **Existing test coverage:** `tests/mcp-server-contract.test.ts:196-202` expires the grant before tool execution begins and verifies zero records. It should instead hold `authorities.resolve` across expiry and prove the proposal store remains unchanged.
- **Smallest safe remediation:** Perform a fresh grant check after the last awaited dependency and immediately before proposal recording. To avoid a deployed asynchronous-store time-of-check/time-of-use gap, make the trusted expiry guard part of the serialized proposal transaction or require a synchronous guarded commit interface.
- **Evidence impact:** This invalidates the CR7C/CR7Q before-mutation expiry evidence. The durable proposal still has explicit negative authority and dispatch flags, so the defect does not itself dispatch or approve work.

### CR7Q-IR-F06 — MCP recomputed durable rows are not semantically bound to request, tool, tenant, or scope

- **Severity:** High.
- **Exact location:** Generic replay validation at `src/mcp/v1/sqlite-state.ts:94-103` and replay release at `src/mcp/v1/sqlite-state.ts:128-146`; proposal parsing at `src/mcp/v1/sqlite-state.ts:79-92`; proposal reads and decisions at `src/mcp/v1/sqlite-state.ts:167-215`; the server returns replay without tool-specific revalidation at `src/mcp/v1/server.ts:203-218`.
- **Attack or failure sequence:**
  1. Replace a complete replay's `result_json` with a valid, canonical, secret-scanner-clean result from a different tenant, project, or tool and recompute the ordinary SHA-256 `result_digest`.
  2. `assertStoredToolResult` verifies only the generic MCP content/structured-content correspondence and safe projection. The row stores no authenticated tool, tenant, project, or expected output schema binding.
  3. `claim` returns the substituted result, and the server replay branch releases it without rerunning the selected tool's schema or scope filter. Safe cross-tenant information, or a safe-looking raw native identifier under a generic key, can cross the boundary.
  4. For proposals, preserve a row's normalized `tenant_id`/`proposal_id` selectors while replacing `record_json`, `request_digest`, and `receipt_json` with a different strict proposal and recomputed values. `parseProposalRow` does not receive or compare `proposal_key`, `tenant_id`, `proposal_id`, normalized state, or decision columns. Tenant-scoped pending reads can therefore return a payload claiming another scope, and forged stored chronology can be made internally consistent.
- **Violated invariant and affected surface:** Durable replay must be exact for the authenticated request and tool; proposal rows must be exact tenant/project/kind/idempotency evidence. Ordinary recomputable digests plus generic shape checks do not establish semantic or adversarial row integrity.
- **Existing test coverage:** `tests/mcp-server-contract.test.ts:269-300` detects a stale digest, a secret-bearing recomputed replay, and a proposal with an added authority field. It should have used a schema-valid safe result from another tool/scope and a strict cross-scope proposal with every ordinary digest and receipt recomputed.
- **Smallest safe remediation:** Persist and validate the exact request, grant-body, tool, tenant, project-scope, and tool-specific result-schema binding for every replay. Compare every normalized proposal/decision column with the parsed record and exact idempotency key. Reapply tool-specific output parsing and scope filtering before release. If a database writer able to recompute SHA-256 is in scope, authenticate rows with a MAC/signature or externally anchored chain; generic recomputable digests cannot solve substitution.
- **Evidence impact:** This invalidates architect remediation CR7Q-F07 and current MCP durable-state evidence. It can disclose or misattribute protected state, but the proposal store still has no canonical materializer or dispatch path.

### CR7Q-IR-F07 — registry mappings can overclaim verified verbs and drift from the manifest

- **Severity:** High.
- **Exact location:** `src/package-registry/v1/compatibility.ts:4-25`, especially line 20; mapping persistence and replay at `src/package-registry/v1/store.ts:101-119`; mapping verification and active resolution at `src/package-registry/v1/store.ts:45-48` and `src/package-registry/v1/store.ts:169-190`.
- **Attack or failure sequence:**
  1. Define a package declaration that requires only a supported verb such as `start`.
  2. Submit a mapping whose `verifiedVerbs` also contains a verb that is absent from both that declaration and the adapter manifest, such as `steer` for the pinned Codex manifest.
  3. The compatibility check verifies only that every required declaration verb appears in both the mapping and manifest. It never checks every claimed mapping verb against either source, so the mapping is accepted as `instructionCompatible: true`.
  4. The manifest digest is stored beside, rather than inside, the mapping and is not verified by `verifiedMappingRow` or returned in the active projection. A directly inserted strict mapping row can therefore claim an arbitrary manifest digest and be replayed without rerunning compatibility.
- **Violated invariant and affected surface:** The registry contract says a mapping binds the exact package digest to an exact adapter, harness, platform, manifest, and verified lifecycle verb set. A verified mapping must not claim capabilities neither the package nor adapter declares.
- **Existing test coverage:** `tests/package-registry-contract.test.ts:91-102` is titled as an exact-verb test but checks only a missing required verb. It should also test extra undeclared verbs, manifest-unsupported verbs, and persisted manifest-binding substitution.
- **Smallest safe remediation:** Require the mapping's verified set to be the exact allowed set defined by the contract, and at minimum require every claimed verb to appear in both the selected package declaration and exact manifest. Include the manifest digest in the immutable mapping payload/public evidence, verify it on every read/replay, and require a current exact manifest when compatibility is consumed.
- **Evidence impact:** This invalidates the CR-7E exact-compatibility evidence. Compatibility remains non-authoritative, but it can falsely label an unsupported adapter/package route as reviewed and compatible.

### CR7Q-IR-F08 — inserted recomputed registry rows can synthesize reviewed-and-active history

- **Severity:** High.
- **Exact location:** Partial row verifiers at `src/package-registry/v1/store.ts:19-56`; activation reads at `src/package-registry/v1/store.ts:123-160`; active resolution at `src/package-registry/v1/store.ts:169-190`; history and channel checks at `src/package-registry/v1/store.ts:193-210`; append-only schema at `db/migrations/0021_cr7e_package_registry.sql:4-116`.
- **Attack or failure sequence:**
  1. Insert a schema-valid review, mapping, or promotion row using existing foreign keys and recompute every ordinary payload digest. The append-only triggers reject update/delete/truncate but do not reject insert.
  2. A promotion can reference a rejected review because `resolveActive` does not join or revalidate the review at all. It can reference a forged verified mapping, skip directly to a high channel revision, and carry arbitrary command digest or prior-package semantics.
  3. Update the mutable channel to the forged newest promotion. The resolver checks only `channel_revision === MAX(channel_revision)` and a subset of package/mapping/promotion payload fields.
  4. Because no code checks a consecutive chain from revision 1, exact prior-package linkage, normalized review/mapping/promotion columns, command digest, review independence/decision, mapping independence/manifest compatibility, or complete chronology, the resolver returns `trust: "reviewed_and_active"` for synthetic history.
  5. The simpler pointer rewind tested by the architect is rejected, but adding a forged newest event and then pointing to it passes the same maximum-revision test.
- **Violated invariant and affected surface:** Review, mapping, promotion, rollback, and channel history must be immutable, complete, producer-independent, chronologically monotonic, and exact. `reviewed_and_active` must prove an accepted review and compatible mapping, not merely the presence of rows with recomputable digests.
- **Existing test coverage:** `tests/package-registry-contract.test.ts:152-170` checks update/delete triggers and rewinding the pointer to an older already-valid promotion. It should also directly insert recomputed rows, a rejected-review promotion, a producer-self-mapping, a skipped revision, a false prior link, and a forged newest promotion.
- **Smallest safe remediation:** Compare every normalized package/review/mapping/promotion/channel column with strict parsed payloads and recompute command as well as payload digests. On activation and resolution, rejoin and revalidate accepted producer-independent review, verified producer-independent manifest compatibility, exact package bindings, monotonic timestamps, and the entire consecutive prior-linked promotion chain. Add enforceable database constraints and guarded insert APIs. If an insert-capable writer is adversarial, use externally anchored authenticated history rather than recomputable row digests alone.
- **Evidence impact:** This invalidates architect remediations CR7Q-F02/CR7Q-F03 and the CR-7E active-history acceptance evidence. The resolved projection still says authority, policy, approval, dispatch, and execution are false, so the defect forges trust/configuration evidence rather than canonical effect authority.

## Required explicit determinations

### Authority grant, spend, or widening

- No MCP, SDK, registry, or harness-observation path directly grants a canonical authority envelope, lease, reservation, owner approval, credential, dispatch, or effect claim.
- The public SDK can nevertheless accept an adapter object that exposes an inherited/non-enumerable effect method (CR7Q-IR-F03), so its claimed observation-only surface can be widened even though conformance does not itself invoke that method.
- The Codex durable-ledger finding can widen a future broker permit's provider-call budget, run/model scope, expiry, and I/O limits. Native dispatch remains disabled, so the current snapshot does not reach a provider through this path.
- `HermesGatewayLifecycleClientV1` is an existing node-local effect-capable path: `start`, `steer`, and `cancel` call an injected live transport. It can spend provider/native authority if deliberately wired. It is not accepted as an unguarded production path; only the exact pinned, disposable, owner-attended, zero-callable-tool evidence remains accepted, and effect-capable/native use stays disabled.

### Durable replay and history

- Harness history can accept normalized/payload disagreement and sequence gaps after recomputed insertion (CR7Q-IR-F01).
- The Codex broker can consume tampered persisted permit/limit state (CR7Q-IR-F02).
- MCP can release replay after grant expiry, persist a proposal after expiry, and accept semantically substituted recomputed replay/proposal rows (CR7Q-IR-F04 through CR7Q-IR-F06).
- Registry history rejects ordinary update/delete/truncate and simple pointer rewind, but an inserted recomputed newest promotion can skip revisions, bypass review/mapping semantics, and become active (CR7Q-IR-F08).
- The reviewed Codex replay guard and trust-pin/high-water implementations did not reveal another static replay or rewind defect, but they add no native eligibility. An actual owner-controlled external high-water checkpoint remains absent.

### Adapter compatibility and observation lineage

- Yes. The SDK can falsely accept a widened adapter shape through prototypes/descriptors/proxies (CR7Q-IR-F03).
- Yes. Registry compatibility can claim unsupported verified verbs (CR7Q-IR-F07).
- Yes. Harness durable rows can return forged normalized scope/lineage and incomplete event sequence after recomputed tampering (CR7Q-IR-F01).
- The normal Hermes and Codex normalization paths still digest raw native identifiers and bind ordinary generated events to the supplied tenant/run context. This does not cure the persistence and public-shape findings.

### Secret and private native identity boundaries

- No repository-produced raw credential, prompt, response, private host path, raw Codex thread ID, or raw Hermes session ID was found in the normal public SDK, MCP, registry, or dashboard projection paths.
- The normal SDK exposes only scoped native-session digests. Raw Hermes references remain inside the explicitly node-local lifecycle module and must not cross the public adapter boundary.
- CR7Q-IR-F06 means a database writer can substitute an otherwise safe-looking generic replay result that was never parsed as the selected tool's result. That can cross tenant/project information and can carry an unrecognized private identifier under a generic safe key. Therefore the public replay boundary is not proven secret/private-identity safe under the packet's recomputed-row substitution threat.

## Cross-boundary composition trace

1. **Package selection:** Registry resolution supplies instructions/facts and compatibility only. CR7Q-IR-F07 and CR7Q-IR-F08 can forge that evidence, but its output still has literal negative authority/policy/approval/dispatch/execution fields.
2. **Adapter compatibility and observation:** The SDK should normalize fixtures only. CR7Q-IR-F03 can bless a widened object, and CR7Q-IR-F01 can forge durable observation lineage. Neither creates a canonical job or lease.
3. **MCP proposal:** Authenticated tools read scoped projections or record proposals. CR7Q-IR-F04 through CR7Q-IR-F06 break expiry and durable-data integrity, but receipts still grant no authority and create no dispatch.
4. **Canonical materialization:** No reviewed component materializes MCP proposals into canonical requests/jobs. This gate is absent and deployment-disabled.
5. **Scheduling and lease:** Existing scheduler eligibility, resource/budget reservation, signed lease, and complete authority-envelope gates remain separate. Shared IDs, digests, replay keys, timestamps, or optimistic revisions from CR-7 do not satisfy them.
6. **Node admission:** CR-5C strict ceiling/lease intersection, node/attempt/epoch binding, time/budget/target checks, and local availability remain mandatory.
7. **Approval and effect admission:** Approval-required effects still require a separately signed owner attestation; the production CR-8 flow is absent. A durable effect-scoped claim and pre-effect marker remain mandatory before an executor crosses an external-effect boundary.
8. **Native executor:** Hermes effect-capable operation and Codex native execution remain disabled except for their narrow historical owner-attended evidence. No reviewed object bypasses the missing OS, credential, transport, cancellation, or deployment proofs.

## Surface dispositions

| Surface | Repository disposition | Native/deployment disposition |
|---|---|---|
| Harness foundation | **Remediation-required** under CR7Q-IR-F01 | Observations cannot qualify native execution |
| Hermes | **Accepted only** for the exact pinned observation boundary and previously captured disposable zero-callable-tool lifecycle evidence | **Disabled** for effect-capable/native production use; approval response remains unqualified |
| Codex | **Remediation-required** under CR7Q-IR-F02; the other reviewed CR-7B security contracts remain fail-closed | **Disabled**; native qualification remains false |
| MCP | **Remediation-required** under CR7Q-IR-F04 through CR7Q-IR-F06 | **Disabled** for network, issuer, service, and canonical materialization deployment |
| Public SDK | **Remediation-required** under CR7Q-IR-F03 | No native/execution qualification may rely on conformance |
| Registry | **Remediation-required** under CR7Q-IR-F07 and CR7Q-IR-F08 | **Disabled** for protected service/API deployment and operational package selection |

## Native and deployment blockers retained

### Hermes

- Effect-capable toolsets remain disabled. The exact pinned Hermes package/revision, valid `context_engine` zero-callable-tool selection, observed zero callable tools, and zero MCP servers are mandatory.
- Approval response remains unqualified and observe-only.
- Live transport/authentication, durable private native-session reference storage, canonical node/attempt/lease integration, and production service wiring are not accepted by this review.
- Any upstream pin, gateway method, tool count, MCP count, profile/workspace, or context-isolation drift returns the lifecycle to incompatible.

### Codex

- Saved authentication was readable across the tested read-only command boundary.
- Authenticated broker/executor IPC and actual distinct OS identities remain unproved.
- Actual child image, UID, argv, cwd, environment, signature, realpath, owner, mode, device, and inode evidence remain unproved.
- Executor-bound turn receipts, provider-side hard output-limit authority, and fresh signed OS evidence remain unproved.
- Remote interrupt acknowledgement and independently observed zero descendants remain unproved.
- Credential-store, credential-ledger, replay, and trust-state unreadability; broker-private provisioning/settlement; broker-only provider egress; and executor egress denial remain unproved.
- Trusted service deployment and an actual owner-controlled rollback-resistant high-water checkpoint remain absent.
- CR7Q-IR-F02 must be fixed and independently re-reviewed before any native preparation can rely on the durable broker.
- Owner-attended identity, permission, service, Keychain, and network-policy operations require separate exact authorization. The repository and synthetic qualification bundle always remain unauthorized for native execution.

### MCP

- CR7Q-IR-F04 through CR7Q-IR-F06 must be fixed and independently re-reviewed.
- No network listener/transport, OAuth or production issuer, TLS termination, revocation/rotation operation, production service identity, durable trusted-clock deployment, protected production database, or canonical proposal materializer is accepted.
- No production endpoint, external client, credential access, or consequential effect is authorized.

### SDK and registry

- CR7Q-IR-F03, CR7Q-IR-F07, and CR7Q-IR-F08 must be fixed and independently re-reviewed.
- Arbitrary third-party adapter code cannot be treated as effect-free merely because in-process reflection passes.
- No protected registry mutation API/service, authenticated producer/reviewer/verifier deployment, current-manifest consumption gate, production database, or live external-reference ingestion is accepted.
- Package selection and adapter compatibility remain configuration/evidence only and must never replace canonical scheduling, signed lease authority, node-local admission, approval attestation, or effect claims.

## Reviewer verification evidence

All commands were run from the repository root against the frozen owner-held snapshot and existing prepared dependencies.

| Command | Reviewer result |
|---|---|
| `npm run check` | Exit 0; TypeScript `tsc --noEmit` completed |
| `npm run lint` | Exit 0 |
| `npm run test:cr7q` | Exit 0; 114 tests, 114 passed, 0 failed, 0 skipped, 0 todo |
| `npm test` | Exit 0; automatic pretest 40/40 passed; main suite 414 total, 412 passed, 0 failed, 2 skipped, 0 todo |
| `npm run build` | Exit 0; production build completed. The builder reported its existing browser `node:crypto` externalization warning and route-classification caveat, not a build failure |
| `node --test tests/rendered-html.test.mjs` | Exit 0; 2 tests, 2 passed, 0 failed, 0 skipped |
| `npm run db:verify` | First attempt exited 1 because the managed sandbox denied the local temporary `tsx` IPC pipe with `listen EPERM`. The exact packet command was rerun in the permitted effect-free host context and exited 0; migrations `0001` through `0021` applied and 73 PostgreSQL tables verified |
| `git diff --check` | Exit 0; no whitespace errors |

The two main-suite skips are the Windows-only DPAPI tests at `tests/node-platform-key-stores.test.ts:205` and `tests/node-platform-qualification-harness.test.ts:176`; both skip because the reviewer host is not Windows. No test or source was changed to obtain these results.

## Final disposition and next review

`remediation_required`

All eight findings must be remediated with focused regressions and proportional full verification. Because this reviewer has now authored the findings, this reviewer is not eligible to accept the repairs. A different independent reviewer must repeat the complete combined CR-7Q packet against a newly frozen snapshot. Until that review accepts the result, CR-7Q remains open, CR-8 through CR-10 remain blocked on it, and every native or deployment blocker above remains in force.

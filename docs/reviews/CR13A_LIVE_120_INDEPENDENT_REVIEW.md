# CR13A-LIVE-120 Independent Zero-Repair Security Review

**Disposition: `rejected`**

## Review identity and independence

Reviewer: Codex independent reviewer `/root/cr13a_live120_independent_review`.

I did not produce commit `959b8cbf5a5ede689fe4b8b6b3a4fc7f289efd38`. I reviewed it report-only in a fresh disposable detached clone and made no product, test, documentation, commit, branch, PR, merge, push, or repair change.

- Product target: `959b8cbf5a5ede689fe4b8b6b3a4fc7f289efd38`
- Tree: `e04a3c3487a1802ce5f6f6a16745962cca16d470`
- Parent: `671bfecdf199d7910aae48914687722254262350`
- Packet SHA-256: `e42cde8b401117e8bb71971315fff0219a5e8f17827e7df7a480a42ca967c9b5` — exact match
- Initial and final detached-checkout tracked status: clean
- Reviewed change: exactly `package.json`, the physical-driver module, and its test
- Required model/effort: `gpt-5.6-sol`, `xhigh`

## Findings summary

| Severity | Count |
|---|---:|
| High | 4 |
| Medium | 5 |
| Low | 0 |

Any one finding rejects the target.

## Findings

| ID | Severity | Finding, evidence, impact, and required remediation |
|---|---|---|
| CR13A-LIVE-120-IR-H-001 | High | **The first arriving loopback socket is admitted without connection-bound tunnel-peer or host-key authentication.** `NativeBindCapabilityStateV1` reduces tunnel and host-key truth to booleans (`private-loopback-physical-native-driver.ts:640-660`), and factory validation accepts those booleans (`:671-680`). `handleSocket` admits the first socket solely from terminal/socket/count state and begins frame intake (`:757-783`). There is no per-connection, one-use admission capability bound to attempt, connection ordinal, tunnel peer, host key, and deadline. This contradicts the design at `CR13A_LIVE_120_PHYSICAL_NATIVE_DRIVER_DESIGN.md:127-140`, especially the rule that loopback is not peer authentication. A local process could win the first-connection race, consume admission, inject input, or deny the intended peer. **Remediation:** require and atomically consume exact connection-bound tunnel/host-key admission evidence before installing data handlers or decoding bytes. |
| CR13A-LIVE-120-IR-H-002 | High | **Frame validation dynamically dispatches through mutable decoder prototype methods.** The backend imports the decoder class but does not capture or verify `push`/`finish`; it invokes `decoder.push(...)` and `decoder.finish()` dynamically (`private-loopback-physical-native-driver.ts:715-724,771-792`). Both prototype properties are writable/configurable. An effect-free hostile probe replaced both methods: two replacements executed, the replacement received frame bytes, and a forged `finish` result was accepted by the call site. This can bypass chunk, framing, JSON, and integrity enforcement and expose protected frame material. **Remediation:** capture and validate the exact decoder constructor/prototype/method descriptors before construction, invoke captured receiver-bound methods, and freeze or privately brand the complete decoder surface. |
| CR13A-LIVE-120-IR-H-003 | High | **`closed_verified` and recovery are self-attested from volatile in-process variables rather than signed durable physical evidence.** Marker, owner-spend, signer, tunnel, host-key, and port proof are booleans (`:640-660`); disposition is one local variable (`:701-714`). A server-close callback plus `listeningObserved` is enough to assign `closed_verified` (`:853-887`), and `recover` merely returns that same in-memory value (`:889`). There is no signer invocation, append-only attempt ledger, independent high-water checkpoint, restart reconstruction, or current resource observation. This directly contradicts design requirements at `CR13A_LIVE_120_PHYSICAL_NATIVE_DRIVER_DESIGN.md:169-185,191-208`; a graceful callback alone must not prove cleanup. **Remediation:** separate the signer, durable marker/spend ledger, external high-water, and independent native-resource observer; derive terminal and recovery truth only from their exact authenticated evidence. |
| CR13A-LIVE-120-IR-H-004 | High | **Failure and ordinary close can retain protected frame bytes and capability/resource references while presenting terminal cleanup.** The decoder is constructed once and retained by the port closure (`:715-724`). `failAfterMarker` clears timers and requests server close but does not call `decoder.close()`, release the capability, clear decoder/callback references, or boundedly verify server closure (`:741-750`). Ordinary `close` also never closes/wipes the decoder (`:853-888`). The decoder retains partial header/frame bytes until `finish`, `close`, or failure wiping (`private-loopback-framing.ts:347-459`). Thus partial-frame, timeout, skipped-close, and close-during-input paths can retain protected material; a later callback-based `closed_verified` remains possible. **Remediation:** route every terminal path through one mandatory bounded cleanup routine that wipes/closes the decoder, clears callbacks, destroys sockets, verifies server closure, releases the capability, and records cleanup failure whenever any step is unproved. |
| CR13A-LIVE-120-IR-M-001 | Medium | **Backpressure resumes immediately without observing the low watermark.** `wireBytes` is cumulative and never decreases (`private-loopback-physical-native-driver.ts:710-711,773`). At the high watermark the socket pauses, but after synchronous decode it resumes whenever `backpressureLowWaterBytes >= 0` (`:775-788`), a condition guaranteed by validation (`:691-697`). The implementation never measures buffered occupancy at or below the low watermark. **Remediation:** track actual pending buffered bytes, decrement only after consumption, and resume solely after observed occupancy reaches the configured low watermark. |
| CR13A-LIVE-120-IR-M-002 | Medium | **All six exported callable surfaces remain extensible.** The exported error class and five exported functions are not frozen (`:158-165,241-328,401-449,608-632`). The hostile matrix confirmed all six are extensible; own `.call`, `.apply`, and `.bind` replacements executed 3/3 times. This violates the packet’s explicit function-decoration attack boundary and allows same-process post-import collaborators to divert standard invocation forms. **Remediation:** freeze each exported callable/class and relevant prototype or expose a frozen, exact-branded binder whose captured functions cannot be decorated. |
| CR13A-LIVE-120-IR-M-003 | Medium | **Status validation still dynamically resolves ambient `Number`; a hostile getter executes and its raw sentinel escapes.** Although `Number.isSafeInteger` is captured, validation passes dynamically resolved `Number` as the `Reflect.apply` receiver six times (`:428-435`). Replacing the global `Number` property with a throwing getter caused one execution and returned the exact raw sentinel rather than a safe driver error. Native timer calls similarly resolve `globalThis` dynamically (`:726-755,828-844,863-868`). **Remediation:** capture inert receivers at import or use `undefined` where receiver-independent, validate the ambient surface, and contain every failure as the fixed safe error vocabulary. |
| CR13A-LIVE-120-IR-M-004 | Medium | **The native factory does not enforce exact contract/implementation provenance.** `createUnwiredNodeNetPortV1` accepts contract and implementation arguments (`:664-666`) but never parses them through their exact-brand validators or checks the private contract-to-implementation relationship. It compares only public digests (`:671-680`). With a future valid capability, publicly equal copies or re-digested/cross-object combinations could enter this security boundary, contrary to the design’s exact-input rule at `CR13A_LIVE_120_PHYSICAL_NATIVE_DRIVER_DESIGN.md:65-82`. **Remediation:** privately brand the exact accepted contract/implementation pair and require identity-based provenance before reading capability state. |
| CR13A-LIVE-120-IR-M-005 | Medium | **The implementation does not provide separate drain and final shutdown deadlines.** Capability state provides start, admission, frame, and total deadlines (`private-loopback-physical-native-driver.ts:640-651`); connection/idle/shutdown values come from the older contract. Close uses one `shutdownGraceMs` timer (`:853-880`). There is no independently represented or evidenced drain deadline distinct from final shutdown/cleanup, despite the mandatory deadline set in `CR13A_LIVE_120_PHYSICAL_NATIVE_DRIVER_DESIGN.md:145-165` and packet attack group 8. **Remediation:** add separately bounded drain and final cleanup phases, with captured timers and independent evidence for both expirations. |

## Twelve attack groups

| Group | Result |
|---|---|
| 1. Exact provenance | Fake contract/driver/status branding passed; native contract-to-implementation provenance fails under M-004. |
| 2. Copies, accessors, Proxies, receivers, decoration, thenables | Producer fake rejects copies/accessors/symbols/Proxies and borrowed driver receivers. Exported callable decoration fails under M-002. |
| 3. Ambient, Node, timer, typed-array, digest, decoder replacement | Captured fake intrinsics partly hold. Decoder replacement produced H-002; ambient `Number` produced M-003. Native Node methods were inspected statically only. |
| 4. Duplicate, concurrent, reentrant, stale, out-of-order operations | Producer fake serialized 32 prepare, start, close, and recovery calls and rejected illegal order. No native operation was invoked. |
| 5. One-use start, failures, uncertainty, cleanup, recovery, retry | Fake one-use/no-retry behavior passed. Native skipped-close and failure cleanup fail under H-004; durable recovery fails under H-003. |
| 6. Loopback, port custody, capability/attempt/evidence binding | Literal `127.0.0.1`, exclusive bind, and private port use are present. Connection-bound tunnel/host-key admission fails H-001; proof/ledger custody fails H-003. |
| 7. Connection, queue, frame, bytes/chunks, allocation, backpressure | Count and framing code are bounded in the clean implementation. Authentication fails H-001, decoder integrity fails H-002, and low-water backpressure fails M-001. |
| 8. Deadlines and late callbacks | Start/admission/connection/idle/frame/total timers exist with terminal guards. Separate drain/final cleanup deadlines are absent under M-005, and terminal cleanup is incomplete under H-004. |
| 9. Ordered close and independent cleanup proof | Socket destruction and server-close timeout exist, but decoder/capability cleanup fails H-004 and independent signed proof/restart recovery fails H-003. |
| 10. Public/error sanitation | Ordinary fake records expose no locator or protected identity. Raw ambient sentinel escape is M-003; decoder replacement can capture protected bytes under H-002. No native diagnostic was generated. |
| 11. Relabeling and authority claims | Repository-fake status remains native-unaccepted and non-authorizing. Native evidence prerequisites are reducible to internal booleans under H-001/H-003. |
| 12. Static construction/wiring | Passed. The physical factory is not exported, `nativeBindCapabilitiesV1` has no insertion path, the barrel omits the module, and no `src` consumer imports it. Exactly one connection-registry module imports `node:net`; the two other source imports use only `isIP`. This is static unreachability, not platform qualification. |

## Command evidence

| Command/evidence | Result |
|---|---|
| `git status --short` / `git rev-parse HEAD` | Clean; exact target |
| `git diff --check 671bfec…959b8cb` | Pass |
| Initial stage zero in pristine clone | `setup_required` because the clone contained no dependencies |
| Existing dependency preparation | Copied the already-present 451 MiB dependency tree; no install or download |
| Required stage-zero rerun | `ready_for_runtime_check` |
| `tsc --noEmit` | Pass, exit 0 |
| Full ESLint | Pass, exit 0 |
| `npm run test:cr13a-physical-native-driver` | 32 passed, 0 failed, 0 skipped |
| `npm run test:cr13a` | 137 passed, 0 failed, 0 skipped |
| `npm test` | Pretest 769 passed; core 372 passed; 0 failed/skipped; exit 0 |
| Explicit `npm run posttest` | 372 passed, 0 failed, 0 skipped |
| `npm run test:build` | Exit 1 before build: managed pnpm attempted dependency reconciliation and refused a noninteractive module purge. I did not permit installation, removal, download, or repair. |
| Direct existing-binary build fallback | Vinext production build passed |
| `node --test tests/rendered-html.test.mjs` | 4 passed, 0 failed, 0 skipped |
| `node --import tsx scripts/verify-migrations.ts` | Migrations 0001–0036 applied; 119 PostgreSQL tables verified |
| Consolidated hostile matrix | 17/17 defect probes reproduced; 6 hostile replacement executions; 0 listener/network/effect counts |
| Total independent replacement executions | 9: 3 preliminary reproductions plus 6 consolidated |
| Static import/construction search | One server-authority module; zero source consumers; zero capability insertion paths |

The exact `test:build` wrapper failure is environmental preparation evidence, not a pass. The underlying build and all four render checks passed using existing binaries.

## Effect and cleanup accounting

- Native backend constructions: **0**
- Bind capabilities issued or synthesized: **0**
- `listen`/socket/port attempts: **0**
- Listener attempts: **0**
- Network I/O observations: **0**
- SSH/Hermes/provider/credential/Keychain contacts: **0**
- Production/database-host/deployment/DNS/hosting effects: **0**
- External effects: **0**
- Product repairs or repository edits: **0**
- Disposable roots created: **1**
- Disposable roots removed: **1**
- Exact removed path: `/private/tmp/cr13a-live120-review.b6pAbb`
- Final absence check: **`absent`**
- Shared authoritative checkout after cleanup: clean at `a9b7190d2e18fc82063f1eaae0baedca476ed8df`

## Final disposition

`rejected`

The target has four High and five Medium findings. Passing producer tests and static non-wiring do not override those defects. No native or external-effect authority was exercised or granted.

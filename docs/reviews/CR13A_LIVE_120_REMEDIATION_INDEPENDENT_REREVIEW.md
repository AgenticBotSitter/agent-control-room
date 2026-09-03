# CR13A-LIVE-120 Remediation Independent Zero-Repair Re-review

**Disposition: `accepted`**

## Review identity and independence

Reviewer: Codex independent reviewer `/root/cr13a_live120_remediation_rereview`.

I did not produce the rejected target, its remediation, or the prior negative review. I am different from reviewer `/root/cr13a_live120_independent_review`. The review was report-only and performed against a fresh disposable detached checkout. No product, test, documentation, branch, commit, PR, merge, push, or authoritative-checkout change was made.

Required review mode: `gpt-5.6-sol`, `xhigh`, zero repair.

## Immutable identities

| Item | Identity |
|---|---|
| Integration base | `1ee5409c0b66afbd802582459af864ec0d198f5c` |
| Rejected target | `959b8cbf5a5ede689fe4b8b6b3a4fc7f289efd38` |
| Rejected tree | `e04a3c3487a1802ce5f6f6a16745962cca16d470` |
| Rejected parent | `671bfecdf199d7910aae48914687722254262350` |
| Preserved negative-review commit | `c50ea2173210ae2d0326c3f67d6a90b747e3af76` |
| Remediation target | `5a579342b7a03bb013de21663c69a3a6118e11c6` |
| Remediation tree | `720682ab8ee8d4fe14f63601e72ac5776fa8183a` |
| Remediation parent | `c50ea2173210ae2d0326c3f67d6a90b747e3af76` |

The remediation commit changes exactly:

- `src/connection-registry/v1/private-loopback-physical-native-driver.ts`
- `tests/connection-enrollment-private-loopback-physical-native-driver.test.ts`

Initial and final tracked status of the detached checkout were clean.

## Evidence hashes

| Evidence | Expected | Observed | Result |
|---|---|---|---|
| Remediation re-review packet | `28e91c4cbbd948c2636e1e1aeae19b1c27b5a113909c50fdaa50708f8c3e8dca` | exact match | Pass |
| Preserved negative report | `baefddebe2af5bcf3f2132d2a8ef2b9bce9c84f02477fff8e95de9319b8b8e66` | exact match | Pass |
| Original implementation packet | `e42cde8b401117e8bb71971315fff0219a5e8f17827e7df7a480a42ca967c9b5` | exact match | Pass |

The preserved four-High/five-Medium negative result remains unchanged evidence.

## Findings summary

| Severity | New findings |
|---|---:|
| High | 0 |
| Medium | 0 |
| Low | 0 |

No original finding remains open.

## Reproduction and closure of the nine original findings

| ID | Original defect reproduced at `959b8cb…` | Remediation evidence at `5a57934…` | Result |
|---|---|---|---|
| H-001 | The original `handleSocket` assigned the first socket and installed data handlers without connection-bound admission. | The candidate is paused first, then must have an exact socket-keyed, unspent admission matching attempt, ordinal, deadline, tunnel-peer proof, and host-key proof before assignment or handler installation (`:907-978`). All related registries have zero insertion paths. | Closed |
| H-002 | Original calls dynamically selected `decoder.push()` and `decoder.finish()` (`959b8cb…:783,792`). | Constructor and `push`, `finish`, and `close` are captured at import, their functions and prototype are frozen, construction uses captured `Reflect.construct`, and calls use captured `Reflect.apply` with the exact decoder receiver (`:59-71,761-774,953-968,873-875`). | Closed |
| H-003 | Original server-close callback could assign `closed_verified`, and recovery returned the volatile local disposition (`959b8cb…:853-889`). | Native disposition has no assignment or conditional promotion to `closed_verified`. Every post-marker cleanup ends `cleanup_failed`; recovery merely waits for cleanup and returns that terminal result (`:760,853-900,1034-1037`). | Closed |
| H-004 | Original failure/close paths omitted decoder wipe, callback removal, bounded complete cleanup, and reliable capability release. | All post-marker exits converge on one idempotent cleanup promise. It clears timers, removes listeners, pauses/destroys the socket, invokes captured decoder close, separately bounds server drain and final release, drops decoder/socket references, and fixes disposition to `cleanup_failed` without independent proof (`:786-900`). | Closed |
| M-001 | Original cumulative `wireBytes` never decreased and resume tested only the always-true `lowWater >= 0`. | Pending bytes increase before decode, decrease only after successful synchronous consumption, pause at high water, fail over the hard ceiling, and resume only after observed pending bytes are at or below low water (`:943-961`). | Closed |
| M-002 | Original exported class/functions were extensible and accepted callable decoration. | All six exported callables, the error prototype, fake driver object/prototype, and its five methods are frozen and non-extensible. Independent decoration attempts executed zero hostile callbacks (`:621-625,1046-1056`). | Closed |
| M-003 | Original validation dynamically resolved ambient `Number`; timer calls dynamically resolved `globalThis`. | `Number`, `Number.isSafeInteger`, `globalThis`, and timer functions are captured at import and used through captured reflection (`:32-47,448-454,732-750,786-838`). A post-import throwing `Number` getter executed zero times and leaked no sentinel. | Closed |
| M-004 | Original native validation compared only public contract and implementation digests. | The factory parses exact branded objects, verifies the implementation’s private contract relation, and requires capability identity equality with both exact objects before capability state can be used (`:705-729`). Equal digests and copies cannot substitute. | Closed |
| M-005 | Original capability had no separate drain/final-shutdown deadlines and close used one grace timer. | Start, admission, connection, idle, frame, total, drain, and shutdown bounds are distinct. Drain and shutdown are separately timed and their sum cannot exceed the accepted shutdown grace (`:664-680,734-754,775-851`). | Closed |

## Hostile review coverage

| Attack group | Result |
|---|---|
| 1. Exact provenance | Exact contract-to-implementation, implementation-to-driver, driver-to-status, cross-driver, capability, socket, peer, and host-key identities fail closed on substitution. |
| 2. Copies, accessors, Proxies, receivers, decoration, thenables | Producer matrix passed; independent Proxy traps and callable decoration executed zero hostile behavior. Borrowed fake-driver receivers fail closed. |
| 3. Ambient, Node, timer, typed-array, digest, decoder replacement | Security-relevant reflection, timers, Node methods, typed-array construction, and decoder operations are captured. Decoder and exported-surface mutation is rejected. Native-only paths were reviewed statically as required. |
| 4. Duplicate, concurrent, reentrant, stale, out-of-order operations | The fake matrix serialized 32 prepare calls, one of 32 starts, 32 closes, and 32 recoveries; illegal sequencing and second starts fail closed. |
| 5. Failure, uncertainty, cleanup, recovery, retry | Pre-bind failure, ambiguity, cleanup failure, repeated close, recovery, and no-retry behavior passed. Native cleanup can never promote itself to verified closure. |
| 6. Loopback, capability, port and admission custody | Literal `127.0.0.1`, exclusive bind, backlog one, exact capability identity, and exact socket admission are fixed statically. Capability, admission, and proof registries have no issuer or insertion path. |
| 7. Connection, queue, frame, chunk, byte and backpressure bounds | One admitted connection, immediate rejection of extras, one-frame decoder, bounded bytes/chunks, pending-byte high/low/hard checks, decoder rejection, and terminal cleanup are present. |
| 8. Deadlines and late callbacks | Start, admission, connection, idle, frame, total, drain, and shutdown timers are distinct; terminal epoch checks prevent late promotion. |
| 9. Ordered cleanup and independent proof | Timer/callback clearing, decoder wipe, socket destruction, drain, capability release, and retained-server failure truth are explicit. Missing signer/ledger/high-water/resource observation always yields `cleanup_failed`. |
| 10. Public and error sanitation | Fake status exposed no injected locator, port, protected identity, credential, frame, command, provider value, native diagnostic, or stack. No raw hostile sentinel escaped. |
| 11. Relabeling and authority claims | Fake evidence remains `repository_fake`, runtime unwired, native and qualification unaccepted, activation ineligible, and grants no approval/network/command/lease/execution authority. |
| 12. Static construction and wiring | Exactly one source module has server authority. The factory is unexported, the barrel omits it, all capability/proof registries are issuer-free, and no app, API, browser, worker, scheduler, Hermes, service, startup, deployment, DNS, hosting, or production source consumes it. |

Final independent out-of-tree hostile probe: **3 passed, 0 failed, 0 skipped**. It observed:

- Hostile replacement executions: **0**
- Proxy/accessor executions: **0**
- Protected-byte exposures: **0**
- Native backend constructions: **0**
- Bind capabilities: **0**
- Connection admissions: **0**
- Physical listener/socket/port attempts: **0**
- Network observations: **0**
- External effects: **0**

Two preliminary reviewer-authored assertions in that temporary probe were corrected out-of-tree: one searched the first declaration rather than the `handleSocket` body, and one sanitation regex matched the legitimate field name `grantsCommandAuthority`. No target file was changed.

## Deterministic command evidence

The pristine checkout initially returned `setup_required` with `tsx` and `zod` absent. I copied the already-prepared local 451 MiB dependency tree without installation or download. Stage zero then returned `ready_for_runtime_check`.

| Command or equivalent script body | Result |
|---|---|
| Exact HEAD, tree, parent and tracked status | Exact and clean |
| macOS stage zero, initial | `setup_required` |
| Copy already-prepared local dependencies | Complete; no install/download |
| macOS stage zero, rerun | `ready_for_runtime_check` |
| `pnpm run check` | Managed launcher aborted before script because it attempted a forbidden `node_modules` purge/reconciliation |
| Existing-binary `tsc --noEmit` | Pass, exit 0 |
| `pnpm run lint` | Same managed-launcher limitation |
| Existing-binary full ESLint | Pass, exit 0 |
| `test:cr13a-physical-native-driver` script | 34 passed, 0 failed, 0 skipped |
| `test:cr13a-connections` script | 123 passed, 0 failed, 0 skipped |
| `test:cr13a` script | 139 passed, 0 failed, 0 skipped |
| Full lifecycle pretest | 769 passed, 0 failed, 0 skipped |
| Full lifecycle core | 421 tests: 419 passed, 0 failed, 2 explicit Windows-only skips |
| Full lifecycle posttest | 374 passed, 0 failed, 0 skipped |
| Explicit `posttest` | 374 passed, 0 failed, 0 skipped |
| Production build | Pass |
| Rendered routes | 4 passed, 0 failed, 0 skipped |
| `db:verify` through `tsx` CLI | Sandbox denied temporary local IPC with `EPERM` before migration work |
| `node --import tsx scripts/verify-migrations.ts` | Migrations `0001`–`0036`; 119 PostgreSQL tables verified |
| `git diff --check 959b8cb…5a57934` | Pass |
| Independent hostile probe | 3 passed, 0 failed, 0 skipped |

All nine requested `pnpm` script forms were attempted. The managed launcher tried to reconcile dependencies and aborted with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` before entering the scripts. I did not permit installation, removal, download, or repair. The identical script bodies were then run through the already-present npm/direct-binary path and passed.

The packet’s `372/372` core expectation did not reproduce literally on the permitted Node `v22.22.3` runtime. The current runner reported 419 passes and two tests explicitly skipped because they require Windows DPAPI. There were no failures, and both skips predate LIVE-120; this is runner/count drift, not a target defect.

The migration wrapper made one sandbox-denied local Unix-pipe listen syscall and created no IPC endpoint. The fallback was listener-free. The physical native driver made zero constructions or listener/socket/port attempts.

## Mandatory questions

1. **Does exact private admission precede handlers and decoding?** Yes.
2. **Can first-arrival, copied, equal-digest, stale, cross-attempt, wrong-ordinal/deadline/peer/key, reused, accessor, Proxy, or decorated admission pass?** No.
3. **Are decoder calls captured, receiver-bound, immutable, and post-import-replacement safe?** Yes.
4. **Does every terminal native path converge on mandatory cleanup and wipe/release protected state?** Yes; any incomplete proof remains `cleanup_failed`.
5. **Can volatile state, a graceful callback, or recovery claim native `closed_verified`?** No.
6. **Is backpressure tied to tracked pending bytes and the low/high/hard limits?** Yes.
7. **Are exported callables and relevant prototypes frozen and non-extensible?** Yes.
8. **Can ambient `Number` or timer replacement execute or leak a raw sentinel?** No.
9. **Does exact provenance bind contract, implementation, capability, attempt, socket admission, peer, and host key?** Yes.
10. **Are drain and shutdown separate and unable to widen total grace?** Yes.
11. **Is the implementation unexported, unwired, issuer-free, runtime-disabled, and effect-free?** Yes.
12. **Do the original and new tests reproduce without target repair, and does any finding remain?** Yes, subject to the disclosed launcher/count/tooling limitations; no High, Medium, or Low finding remains.

## Effect accounting

| Effect | Count |
|---|---:|
| Native backend constructions | 0 |
| Bind capabilities obtained, issued, or synthesized | 0 |
| Connection admissions obtained, issued, synthesized, or consumed | 0 |
| Physical driver `listen` calls | 0 |
| Physical listener/socket/port attempts | 0 |
| Successful auxiliary IPC listeners | 0 |
| Network I/O observations | 0 |
| SSH operations | 0 |
| Credential or Keychain contacts | 0 |
| Hermes contacts | 0 |
| Provider contacts | 0 |
| Production/database-host contacts | 0 |
| Deployment effects | 0 |
| DNS/hosting effects | 0 |
| Repository changes or repairs | 0 |
| External effects | 0 |

## Cleanup

- Disposable checkout created: **1**
- Exact path: `/private/tmp/cr13a-live120-rereview.yaVaat`
- Disposable checkout removed: **1**
- Final absence check: **`absent`**
- Temporary hostile probe removed: **`absent`**
- Shared authoritative checkout after cleanup: clean at `8034a6ce6bd76b27499cc1cf1557cb6281dd1f83`

## Final disposition

`accepted`

All four original High and five original Medium findings are closed. No new High, Medium, or Low finding remains.

This acceptance permits only ordinary owner-controlled integration consideration. It does not authorize native construction, capability/admission issuance, a physical listener or socket attempt, runtime wiring, qualification, SSH, credentials, Hermes/provider contact, production use, deployment, DNS, or hosting.

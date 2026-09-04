# CR13A-LIVE-310 independent review packet

**Review type:** different independent, report-only, zero-repair
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Product:** `3dd9969db7344e07f503dc8769d44a0d2bd5b43e`
**Product tree:** `4a6c27a3c2ad07f7817f4c043da1b69943499b5e`
**Design parent:** `3cc72d778606a199552a55adf84f66f1f7d92256`
**Accepted LIVE-300 product:** `aca7b98405fd12163b74fbc949a6a671d69fe310`
**Accepted LIVE-300 review SHA-256:**
`86721e47c4c3c743aee97d5c577a1701242f799fdf6063c3dfbcfd3997d1758e`

## Authority and stop boundary

This review is local, repository-only, and effect-free. It authorizes no install, download, product repair, shared
repository edit, validator lookup/invocation, descriptor inspection, process/host/environment/path read, observer
import/composition/invocation, attestation, signer, nonce, replay checkpoint, candidate, owner window, native listener,
provider, network, persistence, deployment, DNS, hosting, or production action.

Do not generate review code. Do not alter the product, packet, dependencies, or test selection. Run every fixed command
exactly once and in order. Any failure, mismatch, executable ambient dependency, nonzero effect, false authority,
forbidden consumer/import, or incomplete cleanup rejects. Do not retry, repair, substitute, or broaden. Return prose
only; make no shared-repository edit.

## Required independent inspection

Inspect LIVE-310 architecture, ADR-182, exact product range, private validator module, package scripts, and tests.
Verify:

1. Exact parent/tree/product and exactly three changed paths: `package.json`, the private validator module, and its test.
2. Exact accepted LIVE-300 product and independent-review digest binding.
3. Exactly one static `node:process` namespace import and exact ordered property scope: `version`, `execPath`, `pid`,
   and `ppid`. There is no ambient `globalThis.process`, direct global `process.*`, caller binding, or dynamic import.
4. Exactly one frozen no-input validator is created and stored once in its private WeakMap; the map has zero lookup
   operations and the validator has no export, getter, bridge, callback, token, capability, or consumer path.
5. All descriptor inspection and native property names occur only inside the unreachable validator body. Module
   initialization, parsing, public records, and tests execute no descriptor or process read.
6. The future body uses captured `Object.getOwnPropertyDescriptor`, the captured Object receiver, captured
   `Array.prototype.some`, and captured `Reflect.apply`; it does not consult replaceable ambient versions.
7. The validator accepts no input and rejects missing/accessor/wrong-shape/wrong-type descriptors before returning only
   a private fixed `{ valid: true }` result. It returns no descriptor, property value, namespace, process object, or raw
   observation.
8. The module imports neither LIVE-290 nor any OS/network/filesystem/child-process/DNS/HTTP/crypto-signer/database/
   timer/SSH/credential/provider/deployment module. No production source imports it and the safe barrel omits it.
9. Public truth reports one static namespace captured but unread, a stored unreachable/uninvoked validator, no observer
   composition, exactly 24 zero actual totals, eight false grants, and false blocker/qualification/runtime/candidate/
   activation/effect facts.
10. Exact records, property array, callables, errors, and error prototype are frozen. Copies, Symbols, accessors,
    Proxies, hostile extras, and ambient parser-intrinsic replacements execute zero hostile behavior.
11. Public records and errors contain no observed/transformed version, path, PID, host value, command, provider content,
    native diagnostic, or stack.
12. Cleanup removes the exact disposable root and verifies absence with no dependency/build/review residue.

## Fixed 14-command sequence

Use a fresh local-only disposable clone detached at the exact product and copy prepared dependencies without install or
download. Record the disposable root. Run exactly once and in order:

1. `git status --short`
2. `git rev-parse HEAD`
3. `git rev-parse HEAD^{tree}`
4. `git diff --check 3cc72d778606a199552a55adf84f66f1f7d92256 3dd9969db7344e07f503dc8769d44a0d2bd5b43e`
5. `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos`
6. `npm run check`
7. `npm run lint`
8. `npm run test:cr13a-native-target-runtime-binding-validator`
9. `npm run test:cr13a`
10. `npm run build`
11. `node --test tests/rendered-html.test.mjs`
12. `npm run db:verify` using sandbox escalation only for the disposable verifier's local `tsx` IPC socket
13. `git status --short`
14. `git diff --check 3cc72d778606a199552a55adf84f66f1f7d92256 3dd9969db7344e07f503dc8769d44a0d2bd5b43e`

After command 14, remove only the recorded disposable root and verify that exact path is absent. Command 12 permits
only local temporary IPC; it does not permit a real PostgreSQL service, network, or production contact.

## Required disposition

Report High, Medium, and Low findings separately. Acceptance requires all twelve groups and fourteen commands to pass
once, exact identities, 0 High/Medium/Low, zero descriptor/process/observer/native/external effects, clean status and
diffs, and verified cleanup.

Acceptance permits ordinary integration of this exact unreachable validator source only. It grants no validator
lookup/invocation, descriptor/process/host read, observer composition/invocation, attestation, signer, nonce, replay
checkpoint, candidate, owner authorization, native listener, physical qualification, runtime, provider, deployment,
blocker-clearance, or production authority.

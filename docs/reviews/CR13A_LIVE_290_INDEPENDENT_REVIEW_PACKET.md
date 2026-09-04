# CR13A-LIVE-290 independent review packet

**Review type:** different independent, report-only, zero-repair
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Product:** `3d09b2b9287b1174a3e7ebe931bc2860a5ce2bba`
**Product tree:** `5d0e48abc4ee2489d13e9478e8e87f7cde532c1e`
**Design parent:** `3dbd68ac40e8cd4fa508d70cedd3d7f472bfacc2`
**Accepted LIVE-280 product:** `c1743b7f7b5c8362cec3d33b149e3f51c5e5fda6`
**Accepted LIVE-280 rereview SHA-256:**
`bd8281cf4e0336eba7f55de2b8cde9e39e9305860a2a8287e3dcf74af52d7853`

## Authority and stop boundary

This review is local, repository-only, and effect-free. It authorizes no install, download, product repair, shared
repository edit, private observer lookup or invocation, host/process/environment/path read, attestation, signer, clock,
nonce, checkpoint, candidate, owner window, native listener, locator, resource, persistence, provider, network,
deployment, DNS, hosting, or production action.

Do not generate review code. Do not alter the product, packet, dependencies, or test selection. Run every fixed command
exactly once and in order. A command failure, identity mismatch, unexpected native call or consumer, hostile execution,
nonzero effect, false blocker clearance, or incomplete cleanup rejects the product. Do not retry, repair, substitute,
or broaden. Return prose only; make no shared-repository edit.

## Required independent inspection

Inspect the architecture, ADR-180, exact product range, new native module, package scripts, and dedicated tests. Verify:

1. Exact parent/tree/product and exactly three changed paths: `package.json`, the new native observer module, and its
   dedicated test.
2. Exact accepted LIVE-280 product and rereview binding.
3. The captured operation set has exact frozen membership/order: `node:os.platform`, `node:os.arch`,
   `node:os.release`, `node:os.uptime`, `process.version`, `process.execPath`, `process.pid`, and `process.ppid`.
4. The module creates exactly one frozen no-input private observer and stores it once in the private observer WeakMap.
   The map has zero lookup operations; the observer has no export, getter, bridge, callback, token, capability, or
   invocation path.
5. Native OS calls and process-field reads occur only inside the unreachable observer body. Module initialization,
   public parsing, and tests execute none of them.
6. Raw observation is not returned across the module boundary, serialized, logged, persisted, digested, signed, or
   exposed. No hardware UUID, serial, host/device/user/home/working-directory identity, environment, arguments,
   interface/address/port, SSH, credential, Keychain, or provider material is read or named as an executable source.
7. The module imports only `node:os` and established security helpers. It imports no network, filesystem,
   child-process, DNS, HTTP, crypto signer, database, timer, SSH, credential, provider, native listener/issuer, or
   deployment module and performs no dynamic import or command execution.
8. No production source imports this module; the safe connection-registry barrel does not export it.
9. Public records truthfully report private stored source and zero reachability/invocation/observation. All 22 actual
   totals are zero, all eight authority grants are false, and target-runtime blocker clearance, qualification,
   candidate eligibility, runtime wiring, and activation eligibility are false.
10. Exact records, captured-operation array, callables, errors, and error prototype are frozen. Copies, Symbols,
    accessors, Proxies, hostile extras, and ambient intrinsic replacement execute zero hostile behavior.
11. Public records and errors contain no raw/transformed host value, path, PID, observed version, command, provider
    content, native diagnostic, or stack.
12. Cleanup removes the exact disposable root and verifies absence with no dependency/build/review residue.

## Fixed 14-command sequence

Use a fresh local-only disposable clone detached at the exact product and copy prepared dependencies without install or
download. Record the disposable root. Run exactly once and in order:

1. `git status --short`
2. `git rev-parse HEAD`
3. `git rev-parse HEAD^{tree}`
4. `git diff --check 3dbd68ac40e8cd4fa508d70cedd3d7f472bfacc2 3d09b2b9287b1174a3e7ebe931bc2860a5ce2bba`
5. `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos`
6. `npm run check`
7. `npm run lint`
8. `npm run test:cr13a-native-target-runtime-observer`
9. `npm run test:cr13a`
10. `npm run build`
11. `node --test tests/rendered-html.test.mjs`
12. `npm run db:verify` using sandbox escalation only for the disposable verifier's local tsx IPC socket
13. `git status --short`
14. `git diff --check 3dbd68ac40e8cd4fa508d70cedd3d7f472bfacc2 3d09b2b9287b1174a3e7ebe931bc2860a5ce2bba`

After command 14, remove only the recorded disposable root and verify that exact path is absent. The command-12
escalation permits only local temporary IPC; it does not permit a real PostgreSQL service, network, or production
contact.

## Required disposition

Report High, Medium, and Low findings separately. Acceptance requires all twelve inspection groups and fourteen
commands to pass once, exact identities, 0 High/Medium/Low, zero native observations, zero hostile behavior, zero
external effects, clean status/diffs, and verified cleanup.

Acceptance permits ordinary integration of unreachable observer source only. It grants no observer invocation, host
read, attestation, signer, candidate, owner-authorization, native listener, physical-qualification, runtime, provider,
deployment, blocker-clearance, or production authority.

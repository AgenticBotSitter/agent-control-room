# CR13A-LIVE-300 independent review packet

**Review type:** different independent, report-only, zero-repair
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Product:** `aca7b98405fd12163b74fbc949a6a671d69fe310`
**Product tree:** `f115f4a7e34d37179f244beccf00f80e3c641100`
**Design parent:** `2b5b11d1ce6a1b0f397a741e053560c8dbd74df9`
**Accepted LIVE-290 product:** `3d09b2b9287b1174a3e7ebe931bc2860a5ce2bba`
**Accepted LIVE-290 review SHA-256:**
`df2f3fb2fd414d595f020395dfc69fde2857c413e82d8d206383e66c6555c9b6`

## Authority and stop boundary

This review is local, repository-only, and effect-free. It authorizes no install, download, product repair, shared
repository edit, observer import/lookup/invocation, host/process/environment/path/clock read, trusted native binding,
descriptor inspection, attestation, signer, nonce, replay checkpoint, candidate, owner window, native listener,
provider, network, persistence, deployment, DNS, hosting, or production action.

Do not generate review code. Do not alter the product, packet, dependencies, or test selection. Run every fixed command
exactly once and in order. A command failure, identity mismatch, missing rule/stage/blocker, behavioral input execution,
nonzero effect, false authority, forbidden import or consumer, or incomplete cleanup rejects the product. Do not retry,
repair, substitute, or broaden. Return prose only; make no shared-repository edit.

## Required independent inspection

Inspect the LIVE-300 architecture, ADR-181, exact product range, safe contract module, barrel export, package scripts,
and dedicated tests. Verify:

1. Exact parent/tree/product and exactly four changed paths: `package.json`, the safe connection-registry barrel, the
   new trust-contract module, and its dedicated test.
2. Exact accepted LIVE-290 product and independent-review digest binding.
3. The contract freezes exactly 11 anti-forgery/privacy/uncertainty rules, 12 non-collapsible stages, and 16 blockers,
   with exact unique membership and order.
4. Ambient `globalThis.process`, caller native bindings, accessors, proxies, input-selected dynamic imports, mutable
   callbacks, copied records, caller readiness, and repository fakes cannot provide trusted runtime evidence.
5. Trusted-binding capture, descriptor validation, observer retrieval, raw observation, attestation, replay checkpoint,
   candidate assembly, owner authorization, and physical attempt remain unimplemented and separate.
6. Exact parsers accept only the module-owned frozen identities and reject copies, Symbols, accessors, Proxies, and
   hostile extras without executing behavior. Validation continues to use captured intrinsics after ambient mutation.
7. The module imports only established security helpers. It imports neither LIVE-290 nor any native, process, network,
   filesystem, child-process, DNS, HTTP, crypto-signer, database, timer, SSH, credential, provider, or deployment module.
8. The safe barrel is the sole production consumer. There is no observer/native input, lookup, invocation, callback,
   capability, signer, nonce, clock, candidate, resource, locator, or effect surface.
9. Public status reports contract-only trust, an unreachable/uninvoked observer, absent observation/attestation/
   candidate/runtime, exactly 32 zero actual totals, eight false grants, and false candidacy/activation/effect facts.
10. Exact records, arrays, callables, errors, and error prototype are frozen. The contract cannot self-accept or clear a
    blocker.
11. Public records and errors contain no raw/transformed host value, path, PID, observed version/release/uptime,
    command, provider content, native diagnostic, or stack.
12. Cleanup removes the exact disposable root and verifies absence with no dependency/build/review residue.

## Fixed 14-command sequence

Use a fresh local-only disposable clone detached at the exact product and copy prepared dependencies without install or
download. Record the disposable root. Run exactly once and in order:

1. `git status --short`
2. `git rev-parse HEAD`
3. `git rev-parse HEAD^{tree}`
4. `git diff --check 2b5b11d1ce6a1b0f397a741e053560c8dbd74df9 aca7b98405fd12163b74fbc949a6a671d69fe310`
5. `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos`
6. `npm run check`
7. `npm run lint`
8. `npm run test:cr13a-target-runtime-observation-trust-contract`
9. `npm run test:cr13a`
10. `npm run build`
11. `node --test tests/rendered-html.test.mjs`
12. `npm run db:verify` using sandbox escalation only for the disposable verifier's local `tsx` IPC socket
13. `git status --short`
14. `git diff --check 2b5b11d1ce6a1b0f397a741e053560c8dbd74df9 aca7b98405fd12163b74fbc949a6a671d69fe310`

After command 14, remove only the recorded disposable root and verify that exact path is absent. The command-12
escalation permits only local temporary IPC; it does not permit a real PostgreSQL service, network, or production
contact.

## Required disposition

Report High, Medium, and Low findings separately. Acceptance requires all twelve inspection groups and fourteen
commands to pass once, exact identities, 0 High/Medium/Low, zero hostile behavior, zero observation/native/external
effects, clean status/diffs, and verified cleanup.

Acceptance permits ordinary integration of the exact inert trust contract only. It grants no observer retrieval or
invocation, host/process/path read, trusted native binding, descriptor inspection, attestation, signer, nonce, replay
checkpoint, candidate, owner authorization, native listener, physical qualification, runtime, provider, deployment,
blocker-clearance, or production authority.

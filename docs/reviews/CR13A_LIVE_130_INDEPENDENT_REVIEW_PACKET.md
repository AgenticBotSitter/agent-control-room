# CR13A-LIVE-130 independent implementation review packet

**Review mode:** different independent report-only zero-repair review
**Immutable product target:** `339c2e8a61e7c2ac0a40fc6f51711a512badbf6c`
**Product tree:** `06b57cdcec6f139a407d1475e3171ce3798ad64d`
**Design parent:** `aa5284ba1bba34d1d24ece90cedfd1160c45b0b7`
**Integrated LIVE-120 base:** `19a87163c9210730140ec0d769c2effa6bbb5e1b`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Native or external effects permitted:** none

## Reviewer role

Review exact commit `339c2e8a61e7c2ac0a40fc6f51711a512badbf6c` in a fresh detached checkout. Do not
review a moving branch. Be independent of the producer and do not modify, repair, rebase, amend, merge, push, or run a
native path. Preserve every finding, including a negative result. Any High, Medium, or Low finding rejects the target.

The review is repository-only. Do not assemble a qualification candidate, issue or synthesize a locator capability,
bind admission, proof, signer output, owner authorization, or production-shaped fake. Do not import or construct the
physical driver, open a listener/socket/port, contact a network, use SSH, read credentials, contact Hermes/provider or
production systems, deploy, change DNS, or perform a physical qualification. No install, download, repair, retry, or
target mutation is permitted.

## Exact change

The product commit contains exactly:

- `src/connection-registry/v1/private-loopback-physical-qualification-readiness.ts`;
- its safe export in `src/connection-registry/v1/index.ts`;
- `tests/connection-enrollment-private-loopback-physical-qualification-readiness.test.ts`; and
- registered test-script changes in `package.json`.

The target must import no physical-driver module or effectful subsystem. The only permitted source consumer is the
safe connection-registry barrel. Tests may inspect source and exercise the readiness singleton and parser, but may not
run the LIVE-120 physical driver or any native fake that makes an external call.

## Required attacks

Review and, where effect-free, run temporary out-of-tree hostile probes for all of the following without changing the
target:

1. exact binding to the LIVE-120 integration, accepted remediation, remediation tree, rejected target, negative
   review hash, and accepted remediation-review hash;
2. exact private singleton and digest provenance against copies, aliases, re-digested objects, alternate prototypes,
   accessors, symbols, Proxies, thenables, and borrowed values;
3. fixed ordering and immutability of all twelve blocker codes and all eight non-collapsible stages;
4. post-import replacement of `Object.freeze`, `Object.isFrozen`, `Reflect.apply`, string slicing, WeakSet/WeakMap
   methods, and any other security-relevant ambient intrinsic;
5. exported class/function decoration, replacement, `call`/`apply`/`bind` shadowing, prototype mutation, subclassing,
   and malicious constructor input;
6. every missing prerequisite truth, candidate/qualification/activation truth, native/effect count, retry flag, and
   approval/network/command/lease/execution grant;
7. attempts to relabel future one-attempt ceilings as present capabilities, owner authorization, physical proof, or
   activation eligibility;
8. public output and error sanitation for address, port, path, PID, host/user identity, locator, owner, tunnel peer,
   host key, credential, command, protected frame, provider/native error, stack, or private capability identifier;
9. module imports and initialization for hidden clock, timer, callback, store, filesystem, child process, database,
   HTTP, SSH, credential, environment, networking, or native-driver behavior;
10. every browser, API, UI, worker, scheduler, service, startup, Idea Lab, Hermes, deployment, and build route for an
    accidental consumer or readiness-to-activation promotion;
11. source searches for any provider, proof, capability, admission, candidate, owner-spend, physical-evidence, or
    activation issuer added by this target; and
12. exact zero observations for native backend constructions, issued bind capabilities, issued admissions, listener
    attempts, socket attempts, network I/O, hostile replacement executions, protected-byte exposures, and external
    effects.

Treat the repository readiness record as a truthful blocker display only. It is not platform qualification, a
qualification candidate, an owner window, physical evidence, or runtime activation authority.

## Reproduction commands

From a fresh detached checkout at the exact target, using already prepared dependencies only:

```text
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
git diff --check aa5284ba1bba34d1d24ece90cedfd1160c45b0b7..339c2e8a61e7c2ac0a40fc6f51711a512badbf6c
node scripts/qualification/platform-key-store-stage-zero.mjs --platform <reviewer-platform>
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next
npm run test:cr13a-physical-qualification-readiness
npm run test:cr13a-connections
npm run test:cr13a
npm test
npm run test:build
node --import tsx scripts/verify-migrations.ts
```

If stage zero is not ready or prepared dependencies are unavailable, stop and report the blocker. Do not install,
download, repair, or substitute a weaker check. The migration command is listener-free application verification; do
not use a wrapper that needs an IPC server when the platform sandbox forbids it.

## Required report

Return one immutable Markdown report containing:

- reviewer identity and explicit independence statement;
- exact target commit, tree, detached state, and clean checkout status;
- commands and exact pass/fail/skip counts;
- a table of High, Medium, and Low findings with stable IDs, evidence, impact, and required remediation;
- explicit coverage of all twelve attack groups;
- exact counts for hostile replacement executions, protected-byte exposures, native constructions, issued
  capabilities/admissions, listener/socket/port attempts, network I/O observations, and external effects;
- confirmation that no target repair, install, download, native path, or external effect ran; and
- one final disposition: `accepted` only with 0 High, 0 Medium, and 0 Low findings, otherwise `rejected`.

A pass is evidence for ordinary owner-controlled integration review only. It does not clear any blocker, assemble a
candidate, create an owner window, authorize a physical attempt, wire a runtime, or grant network, SSH, credential,
provider, production, deployment, DNS, or hosting authority.

# CR13A-LIVE-140 independent implementation review packet

**Review mode:** different independent report-only zero-repair review
**Immutable product target:** `6e716bd77c26ad7f70343ddd687dff990f5db12f`
**Product tree:** `4010bdaa5fd90f486d7ccad6185a2116dd9345af`
**Design parent:** `154231858828603d167c12371863bc0562f2e795`
**Stacked LIVE-130 base:** `e620b7bc24760a8f8f0034db6cda3d60e74763a8`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Host, native, listener, IPC-listener, or external effects permitted:** none

## Reviewer role

Review exact commit `6e716bd77c26ad7f70343ddd687dff990f5db12f` in a fresh disposable detached local
clone. Be independent of the producer. Do not modify, repair, rebase, amend, merge, push, or write into the
authoritative checkout. Any High, Medium, or Low finding rejects the target.

Do not observe the host, invoke a platform/system profiler, inspect process/environment/path/machine identity, import
the physical native driver, assemble a candidate, issue or synthesize a nonce, signer result, proof, capability,
admission, owner authorization, or production-shaped fake. Do not open a listener/socket/port or IPC server, contact a
network, use SSH, read credentials, contact Hermes/provider/production systems, deploy, change DNS, or perform a
physical qualification.

## Exact change

The product commit contains exactly:

- `src/connection-registry/v1/private-loopback-target-runtime-attestation.ts`;
- its safe export in `src/connection-registry/v1/index.ts`;
- `tests/connection-enrollment-private-loopback-target-runtime-attestation.test.ts`; and
- registered producer test-script changes in `package.json`.

The module must import no physical driver or host/effect subsystem. Its only permitted source consumer is the safe
connection-registry barrel.

## Command boundary

Do not invoke a `tsx` executable or any package-manager version/probe command. Do not run `pnpm`, `npx`, `tsx`, or an
install/download command. Do not run any broader test script that includes the predecessor physical-driver test,
including `test:cr13a-connections`, `test:cr13a`, `test`, `pretest`, or `posttest`.

After local-only clone and copying already-prepared dependencies, run only these commands, in order:

```text
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
git diff --check 154231858828603d167c12371863bc0562f2e795..6e716bd77c26ad7f70343ddd687dff990f5db12f
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
npm run check
npm run lint
node --import tsx --test tests/connection-enrollment-private-loopback-target-runtime-attestation.test.ts
npm run build
node --test tests/rendered-html.test.mjs
node --import tsx scripts/verify-migrations.ts
```

The two `node --import tsx` forms use Node's import hook and must not invoke the `tsx` CLI. Before each dynamic command,
confirm from its fixed script/file list that it does not import the physical driver. If any exact command is unavailable,
unexpectedly attempts a listener, or crosses the boundary, stop, preserve, clean up, and reject. No retry,
substitution, repair, or exploratory command is permitted.

## Required attacks

Run readiness-only temporary out-of-tree probes and static review for all twelve groups:

1. exact LIVE-130 product/tree and accepted LIVE-120 driver identity binding;
2. exact private contract/result provenance against copies, re-digested objects, alternate prototypes, accessors,
   symbols, Proxies, thenables, and borrowed values;
3. exact supported-architecture and fourteen-private-claim order, immutability, duplicate/removal/relabeling attacks;
4. post-import replacement of every security-relevant ambient intrinsic used by the module;
5. callable/class/prototype decoration, `call`/`apply`/`bind`, subclass, receiver, and malicious constructor attacks;
6. every host observation, private binding, signer/clock/nonce/checkpoint, verification, acceptance, blocker, activation,
   authority, runtime-wiring, protected-value, native, listener/IPC/socket/port/network, and effect truth/count;
7. attempts to relabel supported policy, public digests, fake reference, or future lifetime as observed target evidence,
   production proof, blocker clearance, or authority;
8. public/error sanitation for machine/hardware/user/path/process/environment/network/tunnel/key/credential/owner/native
   values and reversible or guessable stable transforms;
9. imports and initialization for `node:os`, process, filesystem, child process, networking, crypto signer, timer, clock,
   database, HTTP, SSH, credential, platform query, or physical-driver behavior;
10. every application, API, UI, worker, scheduler, service, startup, Idea Lab, Hermes, deployment, and build route for
    accidental consumption or fake-to-real promotion;
11. source searches for observer, nonce, signer, verifier, checkpoint, proof, capability, admission, candidate,
    owner-spend, blocker-clearance, physical-evidence, or activation issuers; and
12. exact zero observations for hostile executions, protected-value exposures, host observations, physical-driver
    imports, native constructions, capabilities/admissions/candidates/owner spends, physical and IPC listener attempts,
    socket/port attempts, network I/O, and external effects.

Temporary probes may import only the new attestation module directly and the safe barrel solely to verify its export.
Remove the disposable root and every probe and confirm absence.

## Required report

Return one immutable Markdown report containing:

- reviewer identity and independence statement;
- exact target, tree, packet hash, detached state, and clean initial/final status;
- each exact command, exit code, and pass/fail/skip count;
- a High/Medium/Low finding table with stable IDs, evidence, impact, and remediation;
- explicit coverage of all twelve attack groups;
- exact counts for hostile attempts/executions, exposures, host observations, physical-driver imports, native/effect
  authority objects, physical/IPC listener attempts, network I/O, and external effects;
- confirmation of no repair, install, download, retry, substitution, or exploratory command;
- disposable cleanup path and successful absence check; and
- `accepted` only with 0 High, 0 Medium, 0 Low, complete coverage, and every forbidden-effect count zero; otherwise
  `rejected`.

Acceptance permits ordinary owner-controlled integration only. It does not perform or accept a real target-runtime
attestation, clear the blocker, or grant candidate, owner, native, network, SSH, credential, provider, production,
deployment, DNS, or hosting authority.

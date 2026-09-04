# CR13A-LIVE-130 review-protocol remediation packet

**Review mode:** second different independent report-only zero-repair review
**Immutable product target:** `339c2e8a61e7c2ac0a40fc6f51711a512badbf6c`
**Product tree:** `06b57cdcec6f139a407d1475e3171ce3798ad64d`
**Design parent:** `aa5284ba1bba34d1d24ece90cedfd1160c45b0b7`
**Original packet SHA-256:** `ab8a46c8b34fb4a3ca6cb1908fc5d8d8ac93fcc0016b417a1a944853e1324b0e`
**Preserved rejected report SHA-256:** `3cb87af1ad725c86ad09a3deb1f0ea98dadb3caffaf381f917d768b7cbf2e15d`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Native, listener, IPC-listener, or external effects permitted:** none

## Why this packet exists

The first review is permanently rejected/invalid. Its reviewer made one `tsx --version` call that attempted a local
Unix-domain IPC listener; the sandbox denied it before bind. The same review also found that the original packet's
test list contradicted its no-physical-driver-import boundary. Preserve the exact report at
`docs/reviews/CR13A_LIVE_130_INDEPENDENT_REVIEW.md`. Do not reinterpret its partial inspection as product acceptance.

This remediation changes the review procedure only. It does not change or excuse the exact product target. The second
reviewer must be different from both the producer and first reviewer and must begin in a new disposable detached
checkout.

## Non-negotiable command boundary

The reviewer must not invoke a `tsx` executable or any package-manager version/probe command. In particular, do not
run `tsx`, `tsx --version`, `pnpm`, `pnpm --version`, `npx`, or a package install. The only permitted TypeScript runtime
loader form is the fixed, already-reviewed listener-free `node --import tsx` form in the exact commands below.

Do not run any package script that includes
`tests/connection-enrollment-private-loopback-physical-native-driver.test.ts`. Therefore do not run:

- `test:cr13a-physical-qualification-readiness`;
- `test:cr13a-connections`;
- `test:cr13a`;
- `test`, `pretest`, or `posttest`; or
- any broader dynamically assembled test list.

Those suites remain valid producer and ordinary CI regression evidence, but they transitively import the predecessor
physical native-driver module and are intentionally outside this narrower review. The second review runs only the
new readiness test file directly.

No exploratory command is permitted. If an exact command is unavailable or unexpectedly attempts a listener, stop,
preserve the observation, clean up, and reject the run. Do not retry, substitute, repair, or add a command.

## Repository and effect boundary

Review the exact target without modification. Do not import, construct, or execute the LIVE-120 physical native driver.
Do not assemble a qualification candidate, issue or synthesize a locator capability, admission, proof, signer output,
owner authorization, or production-shaped fake. Do not open a listener/socket/port, create an IPC server, contact a
network, use SSH, read credentials, contact Hermes/provider/production systems, deploy, change DNS, or perform a
physical qualification.

A local-only Git clone, copy of the already-prepared dependency tree, read-only source inspection, compiler/linter,
the single readiness test, non-listening production build, rendered-file checks, listener-free migration verifier,
and temporary out-of-tree readiness-only hostile probes are permitted. Remove the disposable root and probes at the
end and confirm absence.

## Exact commands

Run only these commands, in order, from a fresh detached clone at the exact target:

```text
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
git diff --check aa5284ba1bba34d1d24ece90cedfd1160c45b0b7..339c2e8a61e7c2ac0a40fc6f51711a512badbf6c
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
npm run check
npm run lint
node --import tsx --test tests/connection-enrollment-private-loopback-physical-qualification-readiness.test.ts
npm run build
node --test tests/rendered-html.test.mjs
node --import tsx scripts/verify-migrations.ts
```

The stage-zero command must use the exact `macos` enum. The two `node --import tsx` commands use Node's import hook;
they do not invoke the `tsx` CLI. Before each dynamic command, confirm from its exact file list or script body that it
does not import the physical native-driver module. If that confirmation fails, stop without running the command.

The product target is expected to yield nine dedicated readiness tests. The wider producer evidence remains 24/24
for the registered combined gate, 131/131 connections, 148/148 CR13A, complete lifecycle exit 0, 4/4 rendered routes,
and migrations 0001-0036/119 tables, but the reviewer must not rerun the wider dynamic suites.

## Required attacks

Perform all twelve attack groups from the original packet against the readiness module only. Temporary probes must be
outside the checkout and may import only:

- `src/connection-registry/v1/private-loopback-physical-qualification-readiness.ts` directly; and
- the safe connection-registry barrel solely to verify its readiness export.

They must not import the physical native-driver module or execute arbitrary generated test lists. Record exact counts
for hostile replacements/accessors/Proxy traps, protected-byte exposure, physical-driver imports, native constructions,
capability/admission/candidate/owner spends, listener/socket/port attempts, IPC-listener attempts, network I/O, and
external effects.

Static inspection must independently confirm exact LIVE-120 identity binding, singleton/digest provenance, blocker and
stage order, frozen callable surfaces, sanitized errors/output, false authority/effect truth, descriptive-only future
ceilings, absent effectful imports, only the allowed barrel consumer, and no provider/proof/candidate/activation issuer.

## Required report

Return one immutable Markdown report containing:

- reviewer identity and explicit independence from the producer and first reviewer;
- exact target, tree, packet/report hashes, detached state, and clean initial/final checkout status;
- every exact command, exit code, and test pass/fail/skip count;
- a table of High, Medium, and Low findings with stable IDs, evidence, impact, and required remediation;
- explicit disposition of original packet finding `CR13A-LIVE-130-PACKET-M-001`;
- explicit coverage of all twelve hostile groups;
- exact zero-effect and replacement counts, including a separate IPC-listener-attempt count;
- confirmation that no repair, install, download, retry, exploratory command, physical-driver import, or external effect
  occurred;
- disposable cleanup path and successful absence check; and
- one final disposition: `accepted` only with 0 High, 0 Medium, 0 Low, zero listener/IPC attempts, and complete required
  coverage; otherwise `rejected`.

Acceptance permits ordinary owner-controlled integration review only. It clears none of the twelve blockers and grants
no candidate, owner window, physical attempt, runtime activation, network, SSH, credential, provider, production,
deployment, DNS, or hosting authority.

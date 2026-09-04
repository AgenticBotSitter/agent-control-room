# CR13A-LIVE-140 second review-protocol remediation packet

**Review mode:** third different independent report-only zero-repair review
**Immutable product target:** `6e716bd77c26ad7f70343ddd687dff990f5db12f`
**Product tree:** `4010bdaa5fd90f486d7ccad6185a2116dd9345af`
**Design parent:** `154231858828603d167c12371863bc0562f2e795`
**Original packet SHA-256:** `755db2dec6ad8dfd57455129c25dd4d4b113aa603fd797d33891a82f614cc99f`
**First incomplete report SHA-256:** `6eb5f26004c17a10e7545da8f321e704c5e5c01da0c924fd706ca4bd64803688`
**First remediation packet SHA-256:** `2ea70e21a84c915f0ec49b8471abcd5104a8477bad077c0066abfffaa1c74360`
**Second incomplete report SHA-256:** `223b445ed7246acbad0f721ffd49985be813b06879f2b5f57bc4ddec9a766437`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Host, native, listener, IPC-listener, or external effects permitted:** none

## Why this packet exists

The first review passed all eleven fixed gates but its out-of-tree probe could not resolve bare `tsx`. The second
review stopped before the gates because the reviewer guessed nonexistent path `src/security.ts` during discretionary
static inspection. Neither run found a product defect or imported/executed the physical driver. Preserve both reports.

This packet leaves product `6e716bd77c26ad7f70343ddd687dff990f5db12f` unchanged. It removes discretionary
filesystem/path discovery and makes all review execution commands finite and exact. A third reviewer must be different
from the producer and both prior reviewers and use a fresh disposable detached clone.

## Exact source manifest

The only source paths that may be read to prepare the hostile matrix are:

```text
src/connection-registry/v1/private-loopback-target-runtime-attestation.ts
src/connection-registry/v1/index.ts
src/security/index.ts
src/security/digest.ts
src/security/redaction.ts
src/security/host-value.ts
tests/connection-enrollment-private-loopback-target-runtime-attestation.test.ts
```

All seven paths are architect-confirmed present at the immutable product target. Do not guess, discover, or substitute
another path. Do not use `git show`, `rg`, `grep`, `find`, `sed`, `ls`, glob expansion, or a dynamically assembled file
list during the disposable review. Static import, consumer, issuer, and sanitation checks required for hostile groups
8 through 11 must be implemented inside the one prewritten hostile matrix using only the literal manifest above.

## Disposable preparation

Create one new disposable local-only clone at the exact target, detach it, and copy the already-prepared `node_modules`
without installation or download. Create exactly one hostile matrix outside the clone under the disposable root. The
matrix may import only the LIVE-140 module directly and the safe connection-registry barrel, and may read only the
seven literal manifest paths above. Prewrite the complete matrix before running any numbered command.

Setup, copying dependencies, matrix creation, cleanup, and the final absence check are protocol operations rather than
numbered evidence commands. Any failure still rejects the run; do not retry or substitute.

## Exact evidence commands

From the detached checkout working directory, run these commands exactly once and in this order. Run no other shell
command between them.

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
node -e 'const p=require("./node_modules/tsx/package.json");if(p.exports["."]!=="./dist/loader.mjs")process.exit(1)'
node --import ./node_modules/tsx/dist/loader.mjs <literal-absolute-disposable-root>/hostile-matrix.ts
git status --short
```

Replace the hostile-matrix placeholder in the final prewritten protocol plan with its literal absolute path before
the sequence starts. Do not use an environment variable, command substitution, bare out-of-tree `--import tsx`,
`tsx` executable, `pnpm`, `npx`, version probe, alternate loader, retry, fallback, broader connection/CR13A/test/
pretest/posttest script, or dynamic test list.

An empty first and final `git status --short`, exact target/tree, all successful commands, and one successful hostile
matrix invocation are mandatory. A nonzero exit, unexpected tracked status, listener/IPC/native/network attempt, or
boundary crossing requires immediate cleanup and rejection without retry.

## Hostile matrix requirements

The single matrix must emit one frozen JSON summary only after all assertions pass. It must cover all twelve original
groups, including:

1. exact LIVE-130 product/tree and accepted LIVE-120 driver identity;
2. copy, re-digest, alternate-prototype, accessor, symbol, Proxy, thenable, and borrowed-value substitution;
3. exact/frozen two-architecture and fourteen-claim policy plus removal, duplication, reorder, mutation, and relabel;
4. post-import replacement of captured validation/reflection intrinsics with exact attempt/execution counts;
5. callable decoration, receiver, prototype, constructor, malicious-new-target, and subclass substitution;
6. exhaustive false/zero observation, proof, blocker, authority, and effect truth;
7. fake-to-real, digest, lifetime, blocker, and authority relabeling;
8. hostile host/path/process/network/credential/native text sanitation;
9. literal-manifest imports and effectful-initialization exclusion;
10. safe-barrel-only source consumption and no app/API/UI/worker/service/startup/deployment consumer;
11. no provider, signer, nonce, proof, capability, admission, candidate, owner-spend, acceptance, or activation issuer;
12. exact hostile attempt/execution and forbidden-effect totals.

The matrix must not import the physical-driver module, observe host/runtime identity, access credentials, construct a
native backend, create a listener/socket/timer/port capability, or contact any external system. Hostile behavior and
ambient replacement executions must be zero. Physical-listener and IPC-listener attempt counts must be separately zero.

## Required report

Record exact immutable identities and all four packet/report hashes; command exits and test totals; the literal probe
path and explicit-loader command; all twelve group dispositions; High/Medium/Low findings with stable IDs; exact
hostile-attempt and replacement-execution counts; every forbidden-effect count; closure or non-closure of P-001 and
P-002; initial/final clean status; and cleanup plus absence evidence.

Acceptance requires 0 High, 0 Medium, 0 Low, complete twelve-group coverage, and every forbidden-effect count zero.
It permits ordinary owner-controlled integration only. It does not perform or accept a real target-runtime attestation,
clear `target_runtime_attestation_missing`, or grant candidate, owner, native, network, SSH, credential, provider,
production, deployment, DNS, or hosting authority.

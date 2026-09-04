# CR13A-LIVE-140 third review-protocol remediation packet

**Review mode:** fourth different independent report-only zero-repair review
**Immutable product target:** `6e716bd77c26ad7f70343ddd687dff990f5db12f`
**Product tree:** `4010bdaa5fd90f486d7ccad6185a2116dd9345af`
**Design parent:** `154231858828603d167c12371863bc0562f2e795`
**Original packet SHA-256:** `755db2dec6ad8dfd57455129c25dd4d4b113aa603fd797d33891a82f614cc99f`
**First incomplete report SHA-256:** `6eb5f26004c17a10e7545da8f321e704c5e5c01da0c924fd706ca4bd64803688`
**First remediation packet SHA-256:** `2ea70e21a84c915f0ec49b8471abcd5104a8477bad077c0066abfffaa1c74360`
**Second incomplete report SHA-256:** `223b445ed7246acbad0f721ffd49985be813b06879f2b5f57bc4ddec9a766437`
**Second remediation packet SHA-256:** `1e21eda4f54534d79f5201019ae5a7eace67678fe8f4db50e3186c020ac15243`
**Third incomplete report SHA-256:** `76b40b30c5b5ada79d4374a2eb2a8c3a65886700f1e255a5b0291824b034d5ad`
**Required model/effort:** `gpt-5.6-sol`, `xhigh`
**Permitted effects:** none

## Frozen correction

The first run could not resolve bare `tsx`; the second guessed a nonexistent path; the third proved the explicit loader
resolves and passed its first twelve commands, but an out-of-tree `.ts` entry with top-level await was transformed as
CommonJS. None found a product defect or produced a product/native/network effect. Preserve all three reports.

This packet changes only the hostile-matrix filename from `hostile-matrix.ts` to `hostile-matrix.mts`. The architect
prevalidated this exact module-format form from the prepared checkout working directory:

```text
node --import ./node_modules/tsx/dist/loader.mjs /private/tmp/cr13a-live140-module-format-probe.mts
```

The probe contained only `await Promise.resolve(42)` and a fixed arithmetic assertion. It exited `0`, imported no
product, performed no listener/IPC/native/network action, was removed, and its exact absence check exited `0`.

Product `6e716bd77c26ad7f70343ddd687dff990f5db12f` remains unchanged. The reviewer must be different from the producer and
all three earlier reviewers, use a fresh disposable detached clone, and make no repair.

## Exact manifest and preparation

Only these literal paths may be read by the matrix:

```text
src/connection-registry/v1/private-loopback-target-runtime-attestation.ts
src/connection-registry/v1/index.ts
src/security/index.ts
src/security/digest.ts
src/security/redaction.ts
src/security/host-value.ts
tests/connection-enrollment-private-loopback-target-runtime-attestation.test.ts
```

Do not guess or discover paths. Do not use `git show`, `rg`, `grep`, `find`, `sed`, `ls`, globs, or a dynamic file list
inside the disposable review. Create one complete `hostile-matrix.mts` outside the fresh detached clone before the
numbered sequence. It may import only the LIVE-140 module and safe connection-registry barrel, and may read only the
seven literal paths above. Copy existing prepared `node_modules`; do not install or download.

## Exact evidence commands

From the detached checkout, run exactly once and in order, with no other command between them:

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
node --import ./node_modules/tsx/dist/loader.mjs <literal-absolute-disposable-root>/hostile-matrix.mts
git status --short
```

Replace the placeholder with the prewritten literal absolute `.mts` path before starting. Do not use a variable,
substitution, bare out-of-tree `--import tsx`, `tsx` executable, `pnpm`, `npx`, version probe, alternate loader, retry,
fallback, broader test script, or dynamic test list. Any nonzero exit, dirty status, prohibited effect, or boundary
crossing requires cleanup and rejection without retry.

## Required hostile coverage

The single matrix must emit one frozen JSON summary only after all assertions pass and cover the original twelve
groups: exact predecessor identities; provenance substitution attacks; exact/frozen architecture and claim policy;
captured-intrinsic replacement; callable/prototype/subclass/new-target/receiver attacks; exhaustive false/zero truth;
fake-to-real/digest/lifetime/blocker/authority relabeling; expanded sanitation; literal-manifest import and
initialization exclusions; safe-barrel-only consumption; no issuer surface; and exact hostile/effect totals.

Hostile behavior and replacement executions must be zero. Physical-listener and IPC-listener attempts must be
separately zero. The matrix must not import the physical driver, observe a host/runtime, access credentials, construct
a backend, create a listener/socket/timer/port capability, or contact an external system.

## Required report and disposition

Record all immutable identities and six predecessor packet/report hashes plus this packet hash; exact command exits and
test totals; literal `.mts` path and command; twelve group dispositions; stable findings; exact hostile, replacement,
and forbidden-effect counts; P-001/P-002/P-003 closure; initial/final status; cleanup and absence evidence.

Acceptance requires 0 High, 0 Medium, 0 Low, complete twelve-group coverage, and every forbidden-effect count zero.
It permits ordinary owner-controlled integration only. It performs no real target-runtime attestation and grants no
candidate, owner, native, network, SSH, credential, provider, production, deployment, DNS, or hosting authority.

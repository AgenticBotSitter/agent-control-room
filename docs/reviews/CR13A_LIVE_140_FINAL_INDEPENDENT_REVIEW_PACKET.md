# CR13A-LIVE-140 final independent review packet

**Review mode:** fifth different independent report-only zero-repair review
**Immutable review target:** `c845494d8e4ba497436259f0dee62db6314fcd6c`
**Review tree:** `cf7503cad94e06c2d754647a6091167ef9d5fc59`
**Immutable product commit:** `6e716bd77c26ad7f70343ddd687dff990f5db12f`
**Product tree:** `4010bdaa5fd90f486d7ccad6185a2116dd9345af`
**Design parent:** `154231858828603d167c12371863bc0562f2e795`
**Vetted hostile harness:** `docs/reviews/helpers/CR13A_LIVE_140_HOSTILE_MATRIX.mts`
**Vetted hostile harness SHA-256:** `ded101e5d21d78efe5aeceb0ea647bb22469b3430ffb45a06126bd5c1556d60b`
**Required model/effort:** `gpt-5.6-sol`, `xhigh`
**Permitted native/listener/IPC/network/external effects:** none

## Purpose and immutable evidence chain

Four earlier independent runs found no product defect but stopped on review-harness defects: bare out-of-tree loader
resolution, one guessed nonexistent source path, `.ts` CommonJS/top-level-await transformation, and one redundant
case-insensitive issuer-name false positive. Their reports and controlling packets remain immutable evidence.

This final packet removes reviewer-authored executable content. The exact helper above reconstructs the successful
fourth matrix, deletes only the proven redundant false-positive predicate, and retains the exact export allowlist plus
actual exported function/class issuer check. The architect ran this helper only to qualify the review harness. It
passed TypeScript, lint, all twelve groups, 63 hostile attempts with zero behavior executions, eight ambient
replacement attempts with zero executions, seven literal source reads, and every forbidden-effect count at zero.

The fifth reviewer must independently reproduce those results from a fresh local-only detached clone at exact target
`c845494d8e4ba497436259f0dee62db6314fcd6c`. The product source remains the immutable four-path product commit; the
later target adds only design, acceptance, review evidence/packets, and the hash-bound review helper.

Predecessor hashes to verify from the target:

- original packet: `755db2dec6ad8dfd57455129c25dd4d4b113aa603fd797d33891a82f614cc99f`;
- first incomplete report: `6eb5f26004c17a10e7545da8f321e704c5e5c01da0c924fd706ca4bd64803688`;
- first remediation packet: `2ea70e21a84c915f0ec49b8471abcd5104a8477bad077c0066abfffaa1c74360`;
- second incomplete report: `223b445ed7246acbad0f721ffd49985be813b06879f2b5f57bc4ddec9a766437`;
- second remediation packet: `1e21eda4f54534d79f5201019ae5a7eace67678fe8f4db50e3186c020ac15243`;
- third incomplete report: `76b40b30c5b5ada79d4374a2eb2a8c3a65886700f1e255a5b0291824b034d5ad`;
- third remediation packet: `000c418f5eb0ec5fee3162ba300ead91af40295be68198786f1f6ded3f7c9537`;
- fourth incomplete report: `b5dc003a0a4b4c3d6ca7095dae680143a85ef196ca71b8c1dfd735237642fff3`.

## Preparation

Use one new disposable root and a fresh `--no-hardlinks --no-checkout` local clone, then detach the exact review target.
Copy the existing prepared `node_modules`; do not install or download. Do not create, copy, edit, or generate any
review program. Do not use an out-of-tree entrypoint. Do not run exploratory/discovery commands in the disposable
review and do not guess a path.

Reading the governing repository docs and confirming the packet/predecessor hashes before disposable execution is
required. After preparation, run only the numbered commands below. Setup, cleanup, and exact absence check are protocol
operations. Any failure requires cleanup and rejection without retry, substitution, or repair.

## Exact evidence commands

Run these exact commands once, in order, from the detached checkout, with no command between them:

```text
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
git diff --check e620b7bc24760a8f8f0034db6cda3d60e74763a8..c845494d8e4ba497436259f0dee62db6314fcd6c
git diff --exit-code 6e716bd77c26ad7f70343ddd687dff990f5db12f..c845494d8e4ba497436259f0dee62db6314fcd6c -- package.json src/connection-registry/v1/index.ts src/connection-registry/v1/private-loopback-target-runtime-attestation.ts tests/connection-enrollment-private-loopback-target-runtime-attestation.test.ts
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
npm run check
npm run lint
node --import tsx --test tests/connection-enrollment-private-loopback-target-runtime-attestation.test.ts
npm run build
node --test tests/rendered-html.test.mjs
node --import tsx scripts/verify-migrations.ts
shasum -a 256 docs/reviews/helpers/CR13A_LIVE_140_HOSTILE_MATRIX.mts
node -e 'const p=require("./node_modules/tsx/package.json");if(p.exports["."]!=="./dist/loader.mjs")process.exit(1)'
node --import ./node_modules/tsx/dist/loader.mjs docs/reviews/helpers/CR13A_LIVE_140_HOSTILE_MATRIX.mts
git status --short
```

The hash command must output the exact vetted helper hash above. The helper must output exactly one JSON summary with
`disposition: "pass"`, all twelve named groups passing, 63/0 hostile attempts/executions, 8/0 ambient replacement
attempts/executions, seven literal reads, and zero protected exposure, host observation, physical-driver import,
native construction, capability, admission, candidate, owner spend, physical-listener, IPC-listener, socket, port,
network, and external-effect counts.

Do not run broader connection/CR13A/test/pretest/posttest scripts, a dynamic test list, `tsx` executable, `pnpm`, `npx`,
version probe, alternate loader, retry, fallback, repair, or any other executable review content.

## Required review and report

Review the exact target diff and fixed helper source. Confirm the product imports only safe security helpers, remains
consumed only by the safe barrel, exports only its exact allowlist, creates no provider/issuer/runtime consumer, and
grants no authority. Record command exits/test totals; all target/product/tree/packet/report/helper hashes; twelve group
dispositions; High/Medium/Low findings with stable IDs; exact hostile/replacement/effect counts; P-001 through P-004
closure or non-closure; initial/final clean status; cleanup and exact absence evidence.

Acceptance requires 0 High, 0 Medium, 0 Low, all commands passing once, complete twelve-group coverage, and every
forbidden-effect count zero. It permits ordinary owner-controlled integration only. It does not perform or accept a
real target-runtime attestation, clear `target_runtime_attestation_missing`, or grant candidate, owner, native,
network, SSH, credential, provider, production, deployment, DNS, or hosting authority.

# CR13A-LIVE-140 review-protocol remediation packet

**Review mode:** second different independent report-only zero-repair review
**Immutable product target:** `6e716bd77c26ad7f70343ddd687dff990f5db12f`
**Product tree:** `4010bdaa5fd90f486d7ccad6185a2116dd9345af`
**Design parent:** `154231858828603d167c12371863bc0562f2e795`
**Original packet SHA-256:** `755db2dec6ad8dfd57455129c25dd4d4b113aa603fd797d33891a82f614cc99f`
**Preserved incomplete report SHA-256:** `6eb5f26004c17a10e7545da8f321e704c5e5c01da0c924fd706ca4bd64803688`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Host, native, listener, IPC-listener, or external effects permitted:** none

## Why this packet exists

The first review passed all eleven fixed commands but is permanently rejected because its one out-of-tree hostile
probe could not resolve bare package import `tsx` from the disposable parent directory. It stopped before importing
the product, did not retry, and observed zero forbidden effects. Preserve the exact report at
`docs/reviews/CR13A_LIVE_140_INDEPENDENT_REVIEW.md`.

This packet changes only the hostile-probe launcher. Exact product `6e716bd77c26ad7f70343ddd687dff990f5db12f`
remains unchanged. A second reviewer must be different from both producer and first reviewer and start in a new
disposable detached clone.

## Prevalidated loader boundary

The architect prevalidated this listener-free import-hook form from a prepared checkout working directory:

```text
node --import ./node_modules/tsx/dist/loader.mjs /private/tmp/cr-live140-loader-probe.ts
```

It exited 0 with a one-line arithmetic-only TypeScript file, invoked no `tsx` executable, imported no product, opened
no listener/IPC/network path, and the probe was removed with an absence check. The loader path is the exact installed
package export target recorded in `node_modules/tsx/package.json`; it does not use the CLI module.

The reviewer must place one fully prewritten hostile matrix at an explicit path under its disposable root and invoke
it exactly once from the detached checkout working directory using:

```text
node --import ./node_modules/tsx/dist/loader.mjs <explicit-disposable-root>/hostile-matrix.ts
```

Replace the placeholder with the already-created literal absolute probe path before invocation. Do not use an
environment variable, command substitution, bare `--import tsx`, `tsx` executable, `pnpm`, `npx`, version probe,
alternate loader, retry, or fallback. Read-only inspection of `node_modules/tsx/package.json` to confirm that `.` still
exports `./dist/loader.mjs` is permitted before the one invocation. If it does not match exactly, stop and reject.

## Fixed repository commands

After local-only clone and copying already-prepared dependencies, run the original eleven fixed commands exactly once,
in order:

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

Do not run broader connection/CR13A/test/pretest/posttest scripts or any dynamic test list. The fixed repository test
resolves `tsx` from the checkout and is already demonstrated listener-free. The separate out-of-tree probe must use
the explicit loader path above.

## Review and effect boundary

All exact change, host/privacy, no-physical-driver, no-observer, no-issuer, no-authority, no-effect, twelve hostile
groups, reporting, and cleanup requirements from the original packet remain controlling. The hostile matrix may
import only the new attestation module directly and the safe barrel solely to verify its export.

No exploratory dynamic command is permitted. If a fixed command or the single prevalidated probe invocation fails,
attempts a listener, or crosses the boundary, stop, preserve, clean up, and reject. No retry, substitution, repair, or
second probe invocation is allowed.

## Required report additions

In addition to the original report requirements, record:

- exact hashes for this packet, original packet, and preserved incomplete report;
- explicit closure or non-closure of `CR13A-LIVE-140-REVIEW-P-001`;
- the literal probe path and exact explicit-loader command;
- confirmation that the installed `tsx` package export matched `./dist/loader.mjs` by read-only inspection;
- exact hostile test counts and all twelve group dispositions;
- separate physical-listener and IPC-listener attempt counts; and
- zero retries, substitutions, alternate loaders, version probes, installs, downloads, and product mutations.

Acceptance still requires 0 High, 0 Medium, 0 Low, complete coverage, and every forbidden-effect count zero. It permits
ordinary owner-controlled integration only and does not perform or accept a real target-runtime attestation, clear the
blocker, or grant any candidate, owner, native, network, SSH, credential, provider, production, deployment, DNS, or
hosting authority.

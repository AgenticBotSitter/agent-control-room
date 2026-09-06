# E38 — deterministic pnpm workspace configuration

2026-09-06. Local configuration fix, no installation or downloads.

Read-only inspection of pnpm 11.19.0's dependency checker and saved workspace state
identified two differences: CI installation recorded enableGlobalVirtualStore=false,
while normal invocation selected another default; workspace discovery was not explicitly
limited to the root application. The installed state recorded exactly that root.

pnpm-workspace.yaml now explicitly selects packages ["."] and
enableGlobalVirtualStore=false. This preserves the existing single application install
and leaves the five public-package candidates outside it. No package directories are
deleted, no dependency version changes, no force/purge and no disabled verification.

The stage-zero exact pinned-policy comparison and public-release descriptor regression
expectation now include those explicit settings. The strict exact comparison still
requires esbuild/sharp/workerd build permission to be false. The first stage-zero run
rejected the changed file before this expectation update; it was not counted as a pass.
This was ordinary preparation maintenance, not repair during a native qualification.

Verified:
- CI and normal error-only pnpm dependency prechecks pass without installation.
- `pnpm --config.verify-deps-before-run=error run test:queue-integration` passes all 66 tests.
- Stage-zero preparation passes with the unchanged E37 lockfile digest/build denials.
- All 14 public-release tooling tests pass; targeted lint and whitespace checks pass.

This resolves the E37 package-manager precheck issue. No native service, browser session,
credentials, provider call, GitHub write or deployment. Browser interaction still needs
owner unlock; other completion work is not blocked by that single gate.

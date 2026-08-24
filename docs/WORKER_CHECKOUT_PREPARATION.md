# Deterministic worker-checkout preparation

Status: architect-owned prerequisite for platform validation and future worker onboarding.

## Stage zero

From the repository root, run the stock-Node probe before any `tsx`, package script, or native-provider command:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform <windows|macos|linux>
```

The probe is read-only and dependency-free. It verifies the repository identity, Node 22.13+, the pinned pnpm version declaration, lockfile, explicit build-script policy, and resolution of `tsx` plus `zod`. It emits one safe JSON outcome:

- `ready_for_runtime_check`: dependencies resolve; continue to the TypeScript runtime-readiness command.
- `setup_required`: dependencies are absent; stop platform validation and enter a separately authorized setup step.
- a fixed error category: repository, platform, cwd, Node, or build policy is unsuitable; stop.

## Setup step

Setup changes the checkout. The repository policy explicitly denies the three known package lifecycle scripts, so preparation does not execute them. Setup is not a readiness correction and must be authorized as its own standard setup action.

Prefer cache-only preparation first:

```powershell
$env:CI='true'
pnpm install --frozen-lockfile --offline
```

```sh
CI=true pnpm install --frozen-lockfile --offline
```

This may create/update `node_modules` and read the pnpm content-addressed store. `CI=true` makes pnpm noninteractive and disables its global virtual-store layout so package imports resolve from the checkout. `pnpm-workspace.yaml` explicitly denies lifecycle scripts for the known `esbuild`, `sharp`, and `workerd` packages; worker preparation therefore has no package build-script effects. Do not run `pnpm approve-builds`, alter that policy, link packages from another installation, or substitute another repository's dependency tree.

If offline preparation reports a cache miss, stop. A networked `pnpm install --frozen-lockfile` with `CI=true` is a separate, explicit download authorization. There is no automatic fallback from offline to network.

After setup, rerun stage zero. Continue only when it reports `ready_for_runtime_check`, then run:

```text
node --import tsx scripts/qualification/platform-key-store-readiness.ts --platform <windows|macos|linux>
```

Setup success is not platform qualification. The native attempt remains a later, separately bounded phase.

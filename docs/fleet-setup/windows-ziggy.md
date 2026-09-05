# Ziggy — Windows PC checkout preparation

This page prepares a Windows checkout for repository work only. It does not inspect or modify DPAPI-protected material,
create a Hermes or Codex profile, enroll a node, install a scheduled task or service, start a connector, or make a
provider call.

Read the [common fleet handoff](README.md) first.

## Keep Windows user context explicit

Ziggy's future protected-store design uses Windows DPAPI `CurrentUser`, not machine-wide credential scope. That makes the
Windows user profile part of the future native evidence boundary. An administrator shell, another user's session,
pre-logon execution, or a service with an unloaded profile must not be treated as equivalent.

Hermes and Codex remain separate harness routes even if both later run on Ziggy. They require separate profiles,
credentials, registrations, state directories, capacity, and evidence. Do not share a checkout between concurrently
active agents or copy Marvin's or Johnny Five's state onto the PC.

## Prepare and identify the checkout

Use the common GitHub clone procedure in a normal PowerShell session, with a new Windows- and harness-specific directory.
Then, from the repository root, record only sanitized results from:

```powershell
git status --short
git rev-parse HEAD
node --version
pnpm --version
node scripts/qualification/platform-key-store-stage-zero.mjs --platform windows
```

The stage-zero command must report `platform: "windows"`. If it reports `setup_required`, stop and follow only the
separately authorized PowerShell setup path in
[`WORKER_CHECKOUT_PREPARATION.md`](../WORKER_CHECKOUT_PREPARATION.md). Do not install tools, copy `node_modules`, change
execution policy, or use a network package fetch under this guide.

## Windows runtime-prerequisite check — not enrollment readiness

Only after stage zero reports `ready_for_runtime_check`, run:

```powershell
node --import tsx scripts/qualification/platform-key-store-readiness.ts --platform windows
```

The actual script checks the repository and Node runtime, imports the repository policy contract, verifies that the
qualification harness exists, confirms that the operating system temporary directory is a suitable scratch parent, and
checks the fixed Windows PowerShell executable at
`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`.

It does **not** invoke PowerShell, call DPAPI, read or create an opaque blob, access entropy, create qualification scratch
material, enroll a node, or contact a provider. The safe success boundary is JSON with schema
`control-room.platform-key-store-readiness/v1`, `platform: "windows"`, and `ready: true`. Here, `ready` means only that
this checkout can support a later separately authorized qualification command. It is not Windows fleet readiness, DPAPI
qualification, enrollment, service-wrapper readiness, or permission to install.

## Windows-specific future gates

Actual DPAPI qualification is a different owner-approved native operation. It must run in the exact enrolled user's
loaded profile and prove bounded protect/unprotect/sign behavior with sanitized evidence. It is not authorized by
runtime readiness, and a failure receives no automatic retry or unattended repair.

The future service posture is a user-context task or service wrapper with profile loading and Job Object ownership of
the connector process tree. Pre-logon or unloaded-profile execution must fail closed; machine-wide credential scope is
unsupported. Installation, first start, restart, profile loading, process-tree termination, sleep/reboot behavior,
rollback, and cleanup all require a later attached owner rehearsal. The repository currently provides contracts and
qualification tooling, not an authorized production Windows installer or live connector configuration.

Before Ziggy can accept live native work, a later owner-approved sequence must establish separate current evidence for
each Hermes or Codex route: installed runtime identity, profile isolation, node enrollment, DPAPI signer, local policy
ceiling, trust pins, outbound HTTPS destination, supervisor state, persistent journals, and a real bounded task.

## Ziggy return checklist

Report the common fields plus:

```text
Windows runtime-prerequisite JSON: <passed|fixed error category|not run>
checkout shared with another harness: no
DPAPI/protected-blob operations: 0
native qualification attempts: 0
scheduled-task/service operations: 0
Hermes/Codex profile operations: 0
```

Do not include the Windows user name, profile path, machine name, drive layout, protected blob/entropy, private endpoint,
or raw PowerShell/native errors in a GitHub issue, commit, pull request, or general handoff.

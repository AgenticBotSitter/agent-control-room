# Johnny Five — Linux VPS checkout preparation

This page prepares a Linux checkout for repository work only. It does not provision the VPS application, PostgreSQL,
Hermes, a node connector, a service account, a supervisor, credentials, or network access.

Read the [common fleet handoff](README.md) first.

## Keep the VPS roles separate

The supported initial database design places PostgreSQL 17 and the private web application on the VPS, with the
application connecting through literal TCP loopback. That is a design and tested startup contract, not evidence that
PostgreSQL, roles, migrations, backups, the app, or a listener exist on Johnny Five.

A Linux worker checkout is also not the database or deployment checkout. Use distinct non-administrative runtime
identities, directories, state roots, and authority. Never run a worker as `root`, make its local SQLite journal a global
queue, or give it PostgreSQL owner/migrator credentials. Do not publish a database, connector, Hermes, or worker port.

## Prepare and identify the checkout

Use the common GitHub clone procedure with a new directory dedicated to this host and one harness purpose. Then, from
the repository root, record only sanitized results from:

```sh
git status --short
git rev-parse HEAD
node --version
pnpm --version
node scripts/qualification/platform-key-store-stage-zero.mjs --platform linux
```

The stage-zero command must report `platform: "linux"`. If it reports `setup_required`, stop and follow only the
separately authorized setup path in [`WORKER_CHECKOUT_PREPARATION.md`](../WORKER_CHECKOUT_PREPARATION.md). Do not use
`sudo`, install missing tools, or fall back to a networked package fetch under this guide.

## Linux runtime-prerequisite check — not enrollment readiness

Only after stage zero reports `ready_for_runtime_check`, run:

```sh
node --import tsx scripts/qualification/platform-key-store-readiness.ts --platform linux
```

The actual script checks the repository and Node runtime, imports the repository policy contract, verifies that the
qualification harness exists, and confirms that the operating system temporary directory is a suitable scratch parent.
Linux readiness requires no external native tool. It does not run the protected-store qualification harness, create an
encrypted key file, start a child qualification process, touch credentials, enroll a node, or contact a provider.

The safe success boundary is JSON with schema `control-room.platform-key-store-readiness/v1`, `platform: "linux"`, and
`ready: true`. Here, `ready` means only that this checkout can support a later separately authorized qualification
command. It is not Linux fleet readiness, protected-store qualification, enrollment, service readiness, or permission to
install. Anything else is a blocker report, not a prompt to repair or install.

## Linux-specific future gates

The repository's service contract permits a future systemd package only on a host that actually has systemd. A prior
repository record says the then-inspected VPS container had no systemd; that observation must not be projected onto a
different or changed target. The future operator packet must first establish the real supervisor context. A
systemd-less target must report `supervisor_unavailable` and use a separately designed container posture; it must not
pretend a unit was installed.

Before Johnny Five can accept live native work, a later owner-approved sequence must provide and verify all of the
following:

- exact Linux host and non-root runtime-principal scope;
- separate harness enrollment, node identity, policy ceiling, current trust, and protected-store design;
- an installed, pinned, qualified Hermes or Codex runtime and profile for this route;
- outbound HTTPS destination and certificate identity without a public inbound worker endpoint;
- private durable state, bounded artifact paths, supervisor behavior, and restart/recovery evidence; and
- one authorized native qualification and later one authorized real task rehearsal.

No exact production installer, credential-delivery command, supervisor command, or native-attempt command is currently
approved by these guides. Preserve that absence in the handoff report.

## Johnny Five return checklist

Report the common fields plus:

```text
Linux runtime-prerequisite JSON: <passed|fixed error category|not run>
VPS database/app operations: 0
supervisor observed: <not inspected>
supervisor/service operations: 0
native protected-store qualification: 0
```

Do not report a process manager, database, port, host address, runtime profile, or credential as present unless a later
owner packet explicitly authorizes and captures that exact evidence.

# Marvin — macOS checkout preparation

This page prepares a macOS checkout for repository work only. It does not inspect or modify Keychain, create a Hermes or
Codex profile, enroll a node, install a LaunchAgent, start a connector, or make a provider call.

Read the [common fleet handoff](README.md) first.

The September 8 [one-task package](../../packages/control-room-node-service/README.md)
and [owner-review command](../PRIVATE_OWNER_REVIEW_COMMAND.md) now exist in source.
Neither supplies Marvin's private operator configuration or changes the owner-
attended Keychain/signing boundary below. No LaunchAgent should wrap these commands
in an automatic retry loop.

## Separate Mac checkouts and harness identities

Marvin may eventually host Hermes and Codex, but they remain distinct harness routes with separate profiles, credentials,
state directories, capacity, and evidence. A Codex workspace must not reuse Marvin's Hermes worker checkout. Create a
new directory for each concurrently active harness or agent, and let only one task own a branch at a time.

The Mac's ChatGPT/Codex login, GitHub login, Hermes authentication, Keychain contents, local approvals, and process state
do not transfer through GitHub and do not authorize one another.

## Prepare and identify the checkout

Use the common GitHub clone procedure with a new Mac- and harness-specific directory. Then, from the repository root,
record only sanitized results from:

```sh
git status --short
git rev-parse HEAD
node --version
pnpm --version
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
```

The stage-zero command must report `platform: "macos"`. If it reports `setup_required`, stop and follow only the
separately authorized setup path in [`WORKER_CHECKOUT_PREPARATION.md`](../WORKER_CHECKOUT_PREPARATION.md). Do not copy
dependencies from Ziggy, Johnny Five, another Mac checkout, or a Hermes installation.

## macOS runtime-prerequisite check — not enrollment readiness

Only after stage zero reports `ready_for_runtime_check`, run:

```sh
node --import tsx scripts/qualification/platform-key-store-readiness.ts --platform macos
```

The actual script checks the repository and Node runtime, imports the repository policy contract, verifies the
qualification harness and macOS helper source, checks that `/usr/bin/swiftc` and `/usr/bin/security` are regular readable
files, and confirms that the operating system temporary directory is a suitable scratch parent. It hashes the helper
source for the report.

This readiness command does **not** compile the helper, invoke `security`, open Keychain, add or delete an item, request a
prompt, create scratch qualification material, enroll a node, or contact a provider. The safe success boundary is JSON
with schema `control-room.platform-key-store-readiness/v1`, `platform: "macos"`, and `ready: true`. Here, `ready` means
only that this checkout can support a later separately authorized qualification command. It is not Mac fleet readiness,
Keychain qualification, enrollment, LaunchAgent readiness, or permission to install.

## macOS-specific future gates

Actual Keychain qualification is a different operation. It must be run by the owner from an attached Terminal in the
enrolled user's Aqua login session under a fresh packet naming the exact disposable service/account, cleanup, attempt
count, and evidence handling. An agent cannot type the owner phrase, approve a Keychain prompt, claim owner presence, or
repeat a failed attempt. SSH, a background automation, a pre-login session, or a LaunchDaemon is not an equivalent
context.

The future service posture, if accepted, is a LaunchAgent in that enrolled user's Aqua login domain. Installation,
first start, restart, login/sleep/reboot behavior, Keychain unlock, rollback, and cleanup remain owner-attended native
evidence. The repository currently provides contracts and qualification tooling, not an authorized production
LaunchAgent installer or a live connector configuration.

Before Marvin can accept live native work, a later owner-approved sequence must establish separate, current evidence for
each Hermes or Codex route: installed runtime identity, profile isolation, node enrollment, protected signer, local
policy ceiling, trust pins, outbound HTTPS destination, supervisor state, persistent journals, and a real bounded task.
Personal-profile availability or an accepted source pin is not that evidence.

## Marvin return checklist

Report the common fields plus:

```text
macOS runtime-prerequisite JSON: <passed|fixed error category|not run>
checkout shared with another harness: no
Keychain commands/prompts/items: 0
native attended qualification: 0
LaunchAgent operations: 0
Hermes/Codex profile operations: 0
```

Do not include the local account, home path, Keychain labels, profile names, code-signing identity, private endpoint, or
raw tool errors in a GitHub issue, commit, pull request, or general handoff.

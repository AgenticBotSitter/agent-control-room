# Fleet build-checkout handoff

This guide prepares three separate Control Room source checkouts for later work:

- **Johnny Five** — Linux VPS;
- **Marvin** — macOS; and
- **Ziggy** — Windows PC.

Preparation means that the correct private GitHub repository is present, the required tools already exist, and the
repository's effect-free dependency and runtime-prerequisite checks pass. These are checkout checks, not fleet or
enrollment readiness. Preparation does **not** enroll a node, install or start a connector, configure a credential,
contact Hermes or Codex, expose an API, provision PostgreSQL, deploy the private application, or authorize a task. Those
operations need later, explicitly scoped owner packets and retained native evidence.

Use the platform page for the host in front of you:

- [Johnny Five — Linux VPS](linux-johnny-five.md)
- [Marvin — macOS](macos-marvin.md)
- [Ziggy — Windows PC](windows-ziggy.md)

## What is available today

The repository has tested, effect-free building blocks for a private web application, native job delivery, approval
checking, a Hermes run adapter, durable local run state, progress, results, and review. They are not proof of an installed
fleet. Current tests use disposable stores, synthetic keys, and fake or injected transports. Production composition,
credential custody, persistent supervision, and a first real task are still incomplete.

The required future topology remains:

1. One private PostgreSQL primary is the sole global write authority. Its initial supported placement is on the VPS,
   reachable only by that VPS through literal loopback or another separately reviewed private path. There is no public
   PostgreSQL endpoint.
2. Every worker connector makes an outbound authenticated HTTPS connection and has its own revocable node identity.
3. Hermes and Codex are separate harness registrations. Even when both run on one host, they do not share provider
   credentials, profiles, state directories, capacity, or live worktrees.
4. GitHub remains the bootstrap claim authority for GitHub jobber work until an explicit, per-job-class cutover is
   accepted. A private application task assignment currently records a reservation; it does not start an agent.

## Common prerequisites

Before opening a terminal, the operator must know which host and harness the checkout belongs to. Do not use one checkout
for two concurrently active agents. Do not copy another machine's `.git` directory, `node_modules`, credentials, Codex
state, Hermes profile, local database, journal, or temporary files.

The following must already be available:

- access to the private `MarvinAi5/control-room` GitHub repository through the operator's normal GitHub authentication;
- Git and either GitHub CLI (`gh`) or an equivalent owner-approved Git transport;
- Node.js `22.13.0` or newer;
- pnpm exactly `11.19.0`; and
- enough local space for an independent clone and its dependencies.

Missing software is a blocker. This guide supplies no operating-system, Node, pnpm, Hermes, Codex, database, or service
installer. An install or download needs separate scoped approval.

Before taking a job, read the checkout's root [`AGENTS.md`](../../AGENTS.md), current
[`BUILD_STATUS.md`](../BUILD_STATUS.md), [`CONTROL_ROOM_COMPLETION_PROGRAM.md`](../CONTROL_ROOM_COMPLETION_PROGRAM.md),
and [`CR14A_INTEGRATION_DIRECTION.md`](../CR14A_INTEGRATION_DIRECTION.md). The build-status file controls the active
block and model/effort choice; do not preserve a stale recommendation in a host-local note.

## Prepare a clean GitHub checkout

Use a new, host-specific directory. These commands contact GitHub and write a clone, so run them only as the intended
operator under the authorization for this checkout preparation:

```text
gh auth status
gh repo clone MarvinAi5/control-room <new-host-specific-directory>
cd <new-host-specific-directory>
git switch main
git pull --ff-only
git status --short
git rev-parse HEAD
```

`git status --short` should print nothing. Record the commit printed by `git rev-parse HEAD`; do not describe the checkout
as current without it. If the destination already exists, stop and inspect it. Do not overwrite, delete, or repurpose an
unknown checkout.

## Select the architect-issued product version

The `main` checkout above is a **bootstrap checkout only**: it proves repository access and gives the operator a clean
place from which to inspect current instructions. It is not the current CR14 product candidate. At this handoff, the
CR14 dependency stack represented by PRs #280 through #324 has not been fully merged into `main`, so checks run on
`main` alone do not qualify that stack or contain the complete build described by current CR14 acceptance records.

Before build work or candidate verification, obtain from the architect both:

- the exact full candidate commit; and
- its reviewed, dependency-ordered PR chain or integration reference and explicit checkout instructions.

Verify that the selected checkout resolves to the exact issued commit and record the full hash. Do not substitute the
tip of `main`, the newest-looking GitHub branch, an individual stacked PR head, a locally assembled merge, or a branch
tip that moved after review. Do not invent a release tag, integration branch, or candidate ref. If the architect has not
issued an exact full candidate, leave the bootstrap checkout on `main`, report `candidate_version_not_issued`, and stop
candidate preparation.

A V2 GitHub jobber is the separate case described below: after `CLAIM ACCEPTED`, its controller-issued integration target
and producer branch govern that capsule. They do not establish a fleet release candidate.

For an existing dedicated clone, first confirm that no agent owns the branch and that the worktree is clean. Fetching or
fast-forwarding is a network/write action and should follow the same preparation authorization. Never use a destructive
reset to make the checkout look clean.

## Run the repository checkout gates

From the repository root, use the platform token from the relevant page. Run stage zero before any `tsx`, package script,
or native-provider command:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform <windows|macos|linux>
```

The script verifies the real operating system, repository root, Node baseline, `pnpm@11.19.0` declaration, lockfile,
denied package build-script policy, and whether `tsx` and `zod` resolve. It prints one safe JSON result.

Stage zero says only whether this exact checkout can proceed to its TypeScript runtime-prerequisite check. Neither
`ready_for_runtime_check` nor the later `ready: true` result says that a fleet host, harness, credential store, enrollment,
connector, supervisor, network route, or provider is ready.

- `ready_for_runtime_check`: continue to the readiness command on the platform page.
- `setup_required`: stop readiness work. If separately authorized, first try the exact offline frozen-lockfile command in
  [Deterministic worker-checkout preparation](../WORKER_CHECKOUT_PREPARATION.md). A cache miss is not permission to use
  the network.
- Any fixed error category: stop and report it. Do not repair the machine, alter the lockfile or
  `pnpm-workspace.yaml`, or borrow another checkout's dependencies.

After an authorized dependency preparation, rerun stage zero. Dependency installation succeeding is not runtime
readiness, native qualification, or fleet enrollment.

## GitHub jobber work remains claim-gated

A prepared checkout does not permit an agent to start arbitrary repository work. For a V2 GitHub jobber, read
[`skills/agent-build-worker/SKILL.md`](../../skills/agent-build-worker/SKILL.md) and the committed capsule. Confirm the
platform, eligible route, integration target, base commit, allowed paths, acceptance commands, effects, and required
tools before claiming.

The queue controller must answer `CLAIM ACCEPTED` to the exact one-line `/claim <route-id>` issue comment before work or a
producer branch begins. The accepted reply supplies the branch and integration target. Do not infer those values from
this guide, start from `main`, or run both GitHub and PostgreSQL claim authorities for the same job class.

## Safe preparation return report

Return a small, sanitized report to the owner or architect. It may contain:

```text
host label: <Johnny Five|Marvin|Ziggy>
platform: <linux|macos|windows>
harness checkout purpose: <Hermes|Codex|repository-only>
repository commit: <full commit hash>
working tree: <clean|not clean>
selected product version: <exact architect-issued commit|candidate_version_not_issued|jobber-issued target>
stage zero checkout gate: <ready_for_runtime_check|setup_required|fixed error category>
runtime-prerequisite checkout gate: <passed|not run|fixed error category>
dependencies changed: <no|yes, authorized offline preparation>
network actions performed: <GitHub clone/fetch only|none>
native attempts: 0
credential operations: 0
service operations: 0
provider calls: 0
blocker: <safe category or none>
```

Do not include usernames, home directories, IP addresses, DNS names, private URLs, environment variables, tokens,
credential locations, key identifiers, raw native diagnostics, repository contents from private tasks, or command output
that may disclose them.

## Exact gates around real installation

The following prerequisites are deliberately absent today. They must exist before an owner can issue a real
enrollment/service-installation packet:

- an exact architect-issued full candidate/release artifact with its reviewed dependency chain;
- an accepted installed Hermes or Codex runtime/profile for each host/harness route;
- a per-host packet naming the exact non-administrative principal, harness route, installation target, permitted effects,
  attempt count, evidence, rollback, and cleanup;
- approved node-identity and credential creation, custody, delivery, rotation, recovery, trust-pin, and local-ceiling
  procedures;
- a reviewed production connector composition with durable private stores and real transport configuration;
- an accepted per-platform service package and static configuration for the exact supervisor context; and
- the separately authorized control-plane prerequisites for that operation, including authenticated intake and any
  required private application/database/network preparation.

Only after an authorized installation attempt can the owner collect installation evidence: exact files and principal,
first start, protected-store access, authenticated enrollment, outbound transport, supervisor/process-tree behavior,
bounded stop/restart, rollback, cleanup, and negative outcomes. Those are outputs of the native attempt, not assumptions
or prerequisites that this checkout guide can claim.

Later qualification and daily-use gates remain separate again. They include sleep/reboot and reconnect reconciliation,
one accepted real task-to-result-to-review-and-revision journey, multi-host concurrency, monitoring and recovery,
backup/restore, rolling update/rollback evidence, and an explicit per-job-class GitHub-to-PostgreSQL claim-authority
cutover. A first real task is not required before initial installation; it is evidence gathered only after the installed
route and its authority boundaries are accepted for that rehearsal.

Until those gates are closed, labels such as `ready_for_runtime_check`, `ready_for_owner_start`, an accepted component,
or a visible connection record must not be restated as “installed,” “online,” “enrolled,” or “ready for live work.”

## Corrections to older or tempting instructions

- Do not run `pnpm install` merely because a clone is new. Stage zero decides whether setup is required; networked setup
  is never the automatic fallback.
- Do not copy `node_modules`, a live worktree, a Hermes profile, Codex state, or credentials between hosts or harnesses.
- Do not treat the historical custom loopback listener, provider-disabled snapshots, source candidate pins, or mock HTTPS
  tests as an enabled endpoint or installed runtime.
- Do not use assignment, approval storage, delivery, or handoff records as proof that native execution started.
- Do not install a LaunchAgent, Windows task/service wrapper, systemd unit, container supervisor, database, tunnel, or
  firewall rule from generic commands. The repository contracts describe future behavior but do not provide an
  authorized production installer.
- Do not expose PostgreSQL, Hermes, Codex, or a node connector publicly. Network reachability, SSH, or Tailscale membership
  is not application authority.

## Repository contracts behind this guide

- [`WORKER_CHECKOUT_PREPARATION.md`](../WORKER_CHECKOUT_PREPARATION.md) defines stage zero and the separately authorized
  dependency-preparation path.
- [`CR14C_NATIVE_RUN_ADAPTER_ACCEPTANCE.md`](../CR14C_NATIVE_RUN_ADAPTER_ACCEPTANCE.md) records what the tested Hermes
  adapter does and, importantly, what remains unwired.
- [`CR14C_NATIVE_EXECUTION_HANDOFF_CONTRACT.md`](../CR14C_NATIVE_EXECUTION_HANDOFF_CONTRACT.md) keeps stored native input,
  policy/profile evidence, transport, and runtime activation separate.
- [`CR6A_NATIVE_SERVICE_PACKAGING_CONTRACT.md`](../CR6A_NATIVE_SERVICE_PACKAGING_CONTRACT.md) defines future supervisor
  behavior and the owner-only native acceptance boundary; it is not an installer.
- [`SECURITY_AND_AUTHORITY.md`](../SECURITY_AND_AUTHORITY.md) fixes private PostgreSQL, outbound worker transport,
  individual credentials, and redaction invariants.

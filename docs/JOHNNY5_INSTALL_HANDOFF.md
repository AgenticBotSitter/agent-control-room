# Johnny5 — Linux installation preparation and acceptance

Updated 2026-09-07. Private source transfer, not a production-ready release.

## Start here

For the latest ordered deployment work and supplied operator assets, first read
`docs/JOHNNY5_DEPLOYMENT_NEXT_STEPS.md`. This older installation checklist retains
the memory-fix evidence; it is not authority to start production.

The next source update adds the restricted initial website configuration in
`deploy/operator-config.mjs` and `deploy/README.md`. It removes the need to invent
task-planning settings for an initial website. Follow that runbook's remaining
private-input and production-execution gates; source availability does not certify
backup/restore or authorize changing a shared supervisor/database blindly.

The owner requested a private GitHub transfer so Johnny5 can help install Control
Room. This document provides the preparation sequence and identifies what still
needs an architect-reviewed production configuration. It does not authorize
inventing credentials, applying migrations, changing access rules, starting agents,
or modifying an existing service. Codex retains security and final integration.

Repository: `MarvinAi5/control-room` (private).
Transfer branch: `codex/idea-abs-workflows`.
Immutable implementation base: `8a59a65c8a82dabaec89b59571e56dcc7051f363`.
The subsequent handoff commit changes documentation only. Obtain its exact SHA
from the owner's transfer message and pin that revision before preparation.
Do not use the old server directory or assume `main` contains this work.

This is a handoff document, not a claimed V2 jobber. For external worker execution,
follow `skills/agent-build-worker/SKILL.md`: the serialized controller must record
`CLAIM ACCEPTED` for a separately scoped capsule before work starts. An exhausted
Actions allowance does not authorize bypassing that requirement. While dispatch
is unavailable, the owner/operator and Codex must resolve the execution route;
merely reading this document grants no additional authority.

## 1. Confirm the installation target and resources

Report only sanitized findings: Linux/runtime versions, free storage, whether an
existing PostgreSQL primary and supervisor are present, and whether the candidate
can be isolated from other sites. Do not print environment variables, connection
strings, container inspection dumps, authentication files, or private addresses.

Use the existing private PostgreSQL primary if its ownership, persistence, version,
capacity and backup/restore evidence make it suitable. Do not create a competing
primary or use PGlite in production. Determine which applications already depend
on the primary before proposing schema/role changes. A running database is not
proof that Control Room's database and roles exist. Container loopback is not host
loopback: verify which network namespace holds both the tunnel and application.
Do not move or restart the shared agent container to simplify installation.

Before any download, record free space. Keep a local download manifest with source,
pinned revision/version, destination, size and whether still needed. Never clean
up existing files or Docker images automatically. Agree on a space budget first.

## 2. Obtain a clean, pinned checkout

After checkout/download authority and a worker claim are in place, use a new empty
operator-approved release directory, not another worker's checkout. Use existing
GitHub authentication; never include a token in the URL. In that directory:

```sh
git init
git remote add origin https://github.com/MarvinAi5/control-room.git
git fetch --depth=1 origin codex/idea-abs-workflows
git checkout --detach FETCH_HEAD
git rev-parse HEAD
git status --short
```

Compare HEAD with the exact transfer SHA supplied by Codex; stop on a mismatch.
Do not follow a moving branch into installation. Record the SHA and empty status.
No force checkout, reset, copying Mac dependencies, or automatic pulls on startup.

## 3. Prepare and verify on Linux

Read `docs/WORKER_CHECKOUT_PREPARATION.md`. Required Node is >=22.13.0;
package manager is exactly pnpm 11.19.0. Verify installed versions first.

```sh
node scripts/qualification/platform-key-store-stage-zero.mjs --platform linux
```

If setup is required and separately authorized, attempt cache-only preparation:

```sh
CI=true pnpm install --frozen-lockfile --offline
```

A cache miss requires explicit network-download scope before using:

```sh
CI=true pnpm install --frozen-lockfile
```

Never upgrade dependencies, enable denied lifecycle scripts, or repair security
contracts to pass setup. Rerun stage zero after setup. Then, in the isolated
checkout, run the local checks and record exit codes:

```sh
pnpm check
pnpm lint
pnpm test:build:vps
pnpm test:idea-abs:delivery
node scripts/run-private-vps.mjs --help
```

Run these sequentially on a shared small VPS. These checks compile and exercise
disposable/injected resources; they do not establish real PostgreSQL, real agent,
live authentication, or daily-use acceptance. Do not run database commands with
production credentials during these tests. One report-only correction is allowed;
source repairs return to Codex, not an improvised server patch.

## 4. Production configuration review — required before starting

Read `docs/VPS_COMPILED_HANDOFF.md` and
`docs/research/REUSE_E80_PRIVATE_VPS_LAUNCHER.md`. The compiled files are not a
complete installation. Codex must provide/review the executable operator module,
database/role preparation and rollback procedure before an operator executes them.
Never copy fixture secrets, grants or injected databases into that module.

Initial scope is **website-only** using one private origin. Omit `secondaryAccess`,
native queue/worker, native machine HTTP and native TLS configuration. Keep the
public informational website separate. Browser authentication uses the existing
Cloudflare Access application, exact issuer/audience and owner mapping, with
application-side verification; trusting a forwarded email header is insufficient.
Exact values and secrets travel through the approved private operator channel,
not this file, GitHub comments, logs, screenshots, or browser assets.

The launcher requires a canonical, owner-controlled regular configuration file
with mode 0600. Use the existing launcher and supervisor; do not substitute
`vinext start`, a development server, or a second database/queue framework.

Only after configuration, database preparation, backup and startup authorization:

```sh
node scripts/run-private-vps.mjs --configuration /ABSOLUTE/APPROVED/operator-config.mjs
```

The path above is a placeholder, not an executable recipe. Binding the actual
listener and installing persistent supervision are explicit production effects.
The service must remain private/loopback in the intended network namespace.
Connect the existing tunnel only after local health and application-side access
verification pass. Preserve all unrelated routes. DNS/access changes require their
own exact approval; do not expose an origin port to the Internet.

## 5. Acceptance and return

Return one consolidated sanitized report, not a series of tiny PRs:

- Exact source SHA, clean checkout, platform/runtime versions and each test exit code.
- Download manifest summary and remaining storage; no destructive cleanup performed.
- Status of private DB ownership, role isolation, backup/restore and configuration review.
- What was prepared versus actually started; every failed or uncertain action.
- When authorized: private-origin reachability, anonymous denial, owner login/MFA,
  deep links/assets, project persistence across restart, and rollback evidence.
- Existing public sites still work; no new public origin listener or private link.

Owner performs MFA; never request an authenticator secret or recovery code. Codex
reviews the report and the owner completes desktop/phone login acceptance.
Website-only success is not agent orchestration success: real Hermes/Codex tasks,
native transport, queue recovery, Idea Lab runs and news-to-research execution
remain separately scoped end-to-end acceptance.

On failure or uncertainty, stop the affected step, report it, and preserve evidence.
Do not retry a consequential effect blindly, weaken checks, drop a database,
restart unrelated services, or declare a simulated test a live pass.

## GitHub and Actions budget

### Memory-safe validation update

The former `web-idea-start.test.ts` integration scenarios now occupy 14 separate
test files using one shared helper. All 14 original top-level test bodies are
unchanged, including the four nested subtests (18 reported tests total). Both
Idea/ABS package commands now use `--test-concurrency=1`: Node isolates files into
sequential child processes, allowing the OS to reclaim each process's memory.
Do not validate just the original filename, which now contains only one scenario.

After fetching and verifying the exact updated revision supplied by Codex, first
run the full split group, with optional per-process peak RSS reporting:

```sh
node --import ./scripts/test-memory-report.mjs --import tsx --test --test-concurrency=1 tests/web-idea-start.test.ts tests/web-idea-start-case-*.test.ts
```

Then use the unchanged user-facing `pnpm test:idea-abs:delivery` command for the
complete sequential suite. A killed process or nonzero exit remains a failure,
even if its assertions printed success. No test retry, swap change, website stop,
or production startup is part of this correction. The preload prints peak RSS
for each normally exiting process; SIGKILL may prevent its final report, so retain
the runner failure and existing cgroup OOM evidence as well. Peak per-process RSS
does not include the parent, other processes, or the entire cgroup.

Local macOS ARM64 / Node 22.22.3 measurement of the split group: all 18 tests and
all 14 child exits passed; maximum child peak RSS was 1,206.4 MiB, with other
children between 568.0 and 783.6 MiB. This is not Linux acceptance or production
memory sizing, nor a same-host comparison with the earlier VPS failure. Verify
Linux memory and clean exits before marking the VPS blocker resolved.

This transfer uses one feature-branch push, no PR, merge, release upload or workflow
dispatch. Repository workflows currently run push CI only on `main`; the handoff
commit also uses `[skip ci]`. Skipping CI is not a passing check or merge approval.
Run verification locally and batch reports. Push/pull operations are distinct from
Actions runner minutes; do not disable security checks globally to save quota.

Two local browser-setup notes remain outside this transfer following an earlier
commit-review rejection. Historical setup paragraphs in BUILD_STATUS may therefore
lag actual account state. Verify live settings through the approved operator path;
do not reconstruct production settings from those historical notes.

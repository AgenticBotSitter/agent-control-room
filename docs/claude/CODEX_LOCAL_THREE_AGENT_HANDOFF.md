# Single-Mac Control Room: exact handoff to Claude

**Purpose:** give a fresh lead enough accurate information to finish the
single-Mac product without reconstructing its state from chat history.

**Scope:** one Mac runs the website, controller, queue worker, and the local
Hermes Agent, Claude Code, and Codex command-line workers. The already-created
VPS PostgreSQL `control_room` database remains the one and only authoritative
database. Do not start several-computer work before the local journey works.

## Plain-English status

Control Room is **not operational yet**. No persistent Control Room service is
running, no live local web host is running, and no real task has been sent to
Hermes, Claude, or Codex through Control Room.

Two narrow source foundations are complete and tested:

1. The launcher recognizes a `mac-local` option and refuses components that
   belong only to a remote/Cloudflare-hosted installation.
2. A protected local-worker record can pin one to three local command-line
   programs (Codex, Hermes, and/or Claude) by path and version, and refuses a
   missing or changed program.

Those foundations do **not** load protected configuration, connect to the
database, create a website, launch a queue worker, or start an agent. They are
not a working installation.

## Current source and ownership

- Execution plan: `docs/MAC_LOCAL_CRITICAL_PATH.md`.
- More detailed package checklist: `docs/CODEX_MAC_BUILD_EXECUTION.md`.
- Progress record: `docs/MAC_LOCAL_PROGRESS.md`.
- Current integration base: `claude/mac-local-integration` at its current
  remote head. Codex's local foundation commits are on a short-lived work
  branch and have not been integrated into that branch yet.
- Do not merge to `main` while this is being built. Preserve unrelated work.

## What is known about the three agents

| Agent | What is actually known | What is still missing |
| --- | --- | --- |
| Hermes / Marvin | The local Hermes command can complete a harmless text-only qualification through the selected local model provider. | A real Control Room worker adapter, delivery from the canonical queue, result return, restart/recovery, and a live readiness record. |
| Claude Code | Claude Code is installed and the owner has signed in. Existing source has a strict text-only stream decoder and local delivery composition. | A verified local worker record, a real Control Room delivery adapter, result return, and a live readiness record. |
| Codex | Codex Desktop's command-line interface is present. A separate, unreviewed branch contains a first text-only `codex exec --json` prototype. | Review/fix the prototype, connect it at the shared delivery point, produce results/recovery behavior, and a live readiness record. |

No agent may be described as connected, available, or working for Control Room
until it receives a real queued task and produces a result in the real owner
review flow.

## Existing code that should be reused

Do not add a second scheduler, database, task lifecycle, review system, or
generic broker. The existing pieces are the intended starting point:

- Shared host/startup: `src/web/v1/private-task-host.ts`,
  `src/web/v1/private-task-startup.ts`, and
  `src/web/v1/task-coordinator-lifecycle.ts`.
- Queue and recovery: `src/web/v1/installed-native-queue.ts`,
  `src/web/v1/native-queue-worker-startup.ts`, and existing pg-boss setup.
- Hermes delivery composition:
  `src/harness/hermes-021-v1/local-delivery-composition.ts`.
- Claude delivery composition and strict output decoder:
  `src/harness/claude-code-v1/local-delivery-composition.ts` and
  `src/harness/claude-code-v1/stream-json-decode.ts`.
- Existing task/result/review/correction pages and services under `src/web/v1`.
- Local worker record:
  `src/harness/v1/owner-trusted-local-enablements.ts`.
- Mode guard: `scripts/run-private-vps.mjs`.

The old local-pilot interface is explicitly a repository fake. It may inform
small cookie/session mechanics, but it cannot be presented as a live Control
Room path or reused as the local database/runtime.

## Ordered remaining build work

### 1. Database read check and protected configuration (P1/W1)

Build an idempotent Mac-side check of the existing restricted database roles,
using the existing provisioning/migration tools. It must read protected
configuration only, never print a password, and report plain success/failure
per role. The one authoritative database stays on the VPS.

**Current reality:** database creation/provisioning may already have happened
on the VPS, but the Mac-side restricted-role check has not been proven.

### 2. Local owner sign-in and local website profile (P2/W2)

Build a genuine loopback-only sign-in profile alongside—not instead of—the
Cloudflare Access verifier. It must accept only `127.0.0.1`, generate a
one-time owner code whose readable copy exists only in protected local
configuration, store only its hash in normal program state, set an expiring
HTTP-only SameSite-Strict cookie, reject non-local Origin/Host values, and
rate-limit bad code attempts. It must map to the existing owner identity and
reach the real project/task routes.

Do not weaken the existing remote Cloudflare verification. Prefer a separate
Mac-local bootstrap/adapter over conditionals that bypass remote startup
checks.

### 3. Mac-local startup bootstrap (P2/W3)

Add a dedicated Mac-local bootstrap. It should verify the protected
owner-trusted worker record, then compose the existing database, queue,
planning, approvals, quality, result, review, and correction services.

It must not modify `validatePrivateTaskStartupConfiguration` to make remote
admission requirements optional. That existing validator protects the remote
installation path. A focused Claude review previously agreed that the local
bootstrap should be separate.

The new path starts correctly with zero workers; it becomes worker-ready only
after an enablement record is present and each recorded program/version checks
out.

### 4. One shared local command-line delivery path and three adapters (P3/W4)

Create one final-authority delivery seam that reuses the existing local
delivery compositions. Required behavior:

- save a delivery receipt before launch;
- recheck authority immediately before launch;
- never launch twice after a retry or restart;
- use an empty task working directory, small environment allowlist, bounded
  output, deadline, process-group termination, and no automatic retry/resume;
- publish one completed result through the existing pending-review path.

Then add thin adapters only:

- Codex: `codex exec --json` in read-only, ephemeral mode.
- Claude: existing strict stream-JSON parsing with tools disabled.
- Hermes: existing local stream host with tools disabled.

The Codex adapter prototype on the separate W4 branch requires a security
review before adoption. Known questions include cancellation timing, proving
that child processes are reaped, duplicate/malformed terminal output, and
output-limit behavior.

### 5. Real local website journey (P4/P5/W5)

Complete the installed—not preview/fake—website route for: create a project,
create a task, select an available worker, approve, see pending/running/failed/
review/correction status, read the result, accept or request a correction, and
cancel. The worker panel must show genuine readiness/recent-work state.

### 6. Service and real proof (P6/W6/W7)

Add one idempotent local `up` command and a matching `down` command. The local
service must survive login/restart without touching data. Then prove harmless
text-only tasks for each agent, an acceptance, a correction, cancellation,
unavailability, host restart without duplicate execution, and a backup/restore
of the authoritative database. Record only sanitized evidence.

## Current blockers versus owner work

There is **no owner action needed to write and test the source packages above**.
The build can and should continue now.

Owner-attended work will be required later only to run the real service and
use protected local credentials/configuration. Keep those as one or two
bundled, copy-paste steps in `docs/OWNER_ACTIONS.md`; do not request a series
of small confirmations.

## Minimum acceptance definition

The single-Mac build is complete only when the owner can open the real local
website, sign in, create one project and three harmless text-only tasks, assign
one each to Hermes, Claude, and Codex, see three saved results, accept one,
request and receive one correction, cancel one running task, and restart the
host without duplicate/lost work. The database remains the VPS PostgreSQL
database throughout.

## Immediate recommended next package

Implement the local owner sign-in profile and its focused tests first, with a
small separate Mac-local authentication seam. It is a prerequisite to the
real website and can be built without starting any service, contacting an
agent, or requiring the owner.

# Single-machine Control Room completion plan: Claude included

**Status:** proposed execution plan for independent Claude review, September 22,
2026. It refines the local phases of
[`LOCAL_TO_MULTI_SYSTEM_EXECUTION_PLAN.md`](LOCAL_TO_MULTI_SYSTEM_EXECUTION_PLAN.md).
The latter remains the product-wide authority.

## Plain-English outcome

On one Mac, an owner will be able to use the same private Control Room website
to give a small, safe task to either Hermes Agent or Claude Code, watch the
saved status, read the result, and accept it or request a correction. The two
workers share one task system, one database, one queue, one result store and
one review process. They do **not** each get their own scheduler, database,
task list, or approval system.

This is not a plan to use Claude as an administrator or as a replacement for
the owner. Claude is a local task worker. It can receive only a task Control
Room has prepared, assigned, approved and queued for its exact worker route.

## Product rules that cannot change

1. One installation has one authoritative PostgreSQL database and one pg-boss
   scheduler. Local and later remote workers use the same saved task lifecycle.
2. A worker receives a signed, bounded delivery packet; it never decides on its
   own what to start, retry, approve, or complete.
3. Hermes and Claude begin with `text_review`: supplied text in, bounded review
   text out, no project-file editing, tools, network, or account actions.
4. The private website is the normal owner interface. The setup page, workboard,
   project pages, task pages, review pages and attention page must say plainly
   whether an item is real, unavailable, simulated, pending, or uncertain.
5. No source task creates a database, reads credentials, stages a native helper,
   starts a persistent service, or starts either agent. Those remain separately
   owner-approved effects.
6. A later move to several computers changes delivery placement only. It cannot
   fork, synchronize, or replace the local database, queue, review trail or
   result store.

## What already exists and is retained

| Capability | Existing Control Room source to retain | Current truth |
| --- | --- | --- |
| Owner web workflow | private project, task, assignment, approval, submission, result, review, correction, worker, setup and workboard pages | UI source exists; it is not a live installed service yet. |
| Hermes local worker | Hermes 0.21 planning, queue delivery, controlled runner, staging, result publication and review path | Source composition exists; first real task needs owner setup and approval. |
| Claude local worker | Claude connector profile, task planning, dispatch, owned process session, strict stream decoder, terminal-result publisher, private process host, installation binding and post-install admission | Source composition exists; exact installed CLI qualification and first real task remain owner gates. |
| Shared lifecycle | canonical projects/tasks/attempts/results/reviews/corrections, PostgreSQL, pg-boss, protected result staging and durable publication | Retain; do not add a Claude-specific lifecycle. |
| Single-to-several transition | installation topology and transition records, shared packet/receipt contracts and remote-worker foundations | Retain; local Claude is an additive local route, not a separate product. |

## Work sequence

### C0 — Freeze the shared local-worker contract

**Purpose:** prove Hermes and Claude are two routes through the same lifecycle.

- Map the existing task plan, assignment, approval, submission, delivery,
  terminal result, review and correction records for both adapters.
- Add only cross-adapter conformance tests that are missing: identical task
  state progression, cancellation result, uncertain delivery handling,
  restart read, pending review, correction and capacity release.
- Keep adapter differences limited to executable/process qualification and
  terminal framing.

**Done when:** the same test table proves both routes use the same canonical
states and no adapter can bypass review or claim task authority.

### C1 — Complete the Claude private installed-process seam

**Purpose:** turn existing source composition into a safely qualified local
Claude route without changing Claude Code itself.

- Retain `src/harness/claude-code-v1/private-installed-process-host.ts`,
  `owned-process-session.ts`, `stream-json-decode.ts`, result publication, and
  `src/installer/v1/local-claude-installation-binding.ts`.
- Build only the missing private, owner-held port that verifies the selected
  Claude executable/version, fixed arguments, working directory, authentication
  custody, bounded input, process-group cleanup and exact output format.
- The port must be single-purpose: no executable discovery, arbitrary command
  construction, inherited broad environment, plugin control, resume, or generic
  terminal access.
- Use owner-attended qualification only after all source tests pass. Preserve a
  failed qualification as evidence; never turn it into a retry.

**Owner action needed later:** approve one text-only Claude qualification and
one harmless first Claude task. The source package itself must not perform them.

### C2 — Integrate Hermes and Claude into one installed operator path

**Purpose:** use one protected installation configuration and one operator,
not two launchers.

- Extend the accepted installed operator composition only through reviewed
  adapter slots. The existing local Hermes loader is the pattern, not a generic
  plugin framework.
- Capture each adapter's selected route, profile fingerprint, qualification
  receipt and workspace binding before startup. Revalidate them immediately
  before exposing queue delivery.
- Start the existing shared queue worker once. Register each enabled local
  route with its own fixed capacity and capability, but keep the canonical
  scheduler and result publisher shared.
- Prove a disabled, stale, incompatible, revoked, or unavailable Claude route
  is visibly unavailable and cannot reserve, receive or start a task.

**Done when:** an installation can contain Hermes-only, Claude-only, or both
routes without duplicate scheduler, authority, service, or result storage.

### C3 — Finish the website as the owner’s local control surface

**Purpose:** make ordinary local use possible without terminal choreography.

- Retain existing project/task/assignment/approval/submission/review screens
  and the read-only workboard. Do not replace them with a donor dashboard.
- Add the smallest missing cross-worker presentation: for each task, show the
  recommended available route, route-specific limitation, current saved
  delivery state, result/review state and exact next owner action.
- Add an installation status panel that reports Hermes and Claude separately as
  **not configured**, **qualification required**, **ready**, **unavailable**,
  **running**, or **needs owner attention**. A stale observation is unavailable,
  not ready.
- Ensure create-project → create-task → prepare → assign → approve → queue →
  result → review/correction is reachable with direct links, keyboard use,
  narrow screens, refresh/lost-request/lost-reply handling, and clear recovery
  messages.

**Done when:** the owner can understand what both workers can and cannot do
from the site, without any fake live indicator.

### C4 — Local two-worker proof

**Purpose:** prove the real product slice, first with disposable data and then
only with owner-approved live actions.

1. Disposable proof: two independently constructed local routes receive
   different bounded text-review tasks, publish results, wait for review and
   survive a simulated lost reply/restart without duplicate work.
2. Owner-attended proof: qualify the exact Hermes and Claude installations
   separately; create two harmless supplied-text tasks; approve and queue them;
   confirm one saved terminal result per task; review one and request one
   correction.
3. Failure proof: cancel one task, make one worker unavailable, restart the
   controller, and confirm no automatic resend or false completion.

**Done when:** one local installation runs one Hermes task and one Claude task
through the same visible, reviewable lifecycle.

### C5 — Preserve the path to several computers

Before every local package lands, verify it preserves these later needs:

- worker identity/route, compatibility and revocation remain explicit records;
- local delivery uses the same packet and receipt form as remote delivery;
- configuration/import/export moves one authority database deliberately, never
  by sync; and
- browser screens describe workers by capability and evidence, not a hardcoded
  machine name or harness-specific hidden behavior.

## Reuse and implementation policy

Reuse existing Control Room code first. The only external material allowed for
this work is already recorded in `REUSE_CANDIDATE_REGISTER.md`: Anthropic's
SDK supplies framing/cancellation test ideas, Hermes UI projects supply small
presentation ideas, and T3 supplies presentation and release-order concepts.
No external worker runtime, scheduler, credentials store, session database,
agent loop, or generic broker may be imported.

Before material outside this list is copied or substantially adapted, record
its exact revision, license, files, fit test, notice requirement and rejected
alternatives in `REUSE_DECISION_GATE.md` and `THIRD_PARTY.md` as appropriate.

## Model and review allocation

| Package | Primary | Independent review |
| --- | --- | --- |
| C0 shared contract gaps | Sol high | Astra high |
| C1 private Claude process custody | Sol high | Astra xhigh, optional Claude Opus review |
| C2 shared installed composition | Sol high | Astra high |
| C3 website presentation | Terra medium | Sol medium |
| C4 source proof and live-proof preparation | Sol high | Astra high; live effects require owner |
| C5 transition compatibility | Sol high | Astra high |

Qwen may map code, draft tests, and perform first-pass review. It does not own
security, credential, native-process, migration, final acceptance, or live
qualification decisions.

## Claude Opus review request

Read this plan plus the linked authoritative local-to-multi plan and existing
Claude source documents. Use **Claude Opus 5.5**. Return a short written
verdict, not code changes:

1. Does this plan make Claude a genuine first-class local worker while keeping
   one authority and lifecycle?
2. Identify any missing prerequisite that would prevent C4, or any step that
   improperly turns a source proof into a live claim.
3. Identify any unnecessary duplicate system or security risk.
4. Recommend the smallest changes needed before implementation.

Do not request secrets, execute a CLI, change the repository, start a service,
contact a provider, or conduct a live qualification.

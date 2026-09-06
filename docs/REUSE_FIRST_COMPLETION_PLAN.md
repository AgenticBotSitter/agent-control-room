# Reuse-first replacement and completion plan

Date: 2026-09-06. Local source baseline: `7dc025d8b65324c5a3e3be651bb5b279fed00d87`.

## Status and scope

**Current implementation override (E52):** [Current completion handoff](CURRENT_COMPLETION_HANDOFF.md)
reconciles the baseline inventory below with E01–E51. pg-boss is now installed and
protected synthetic task delivery is implemented; references below to undecided queue
adoption or disconnected dispatch describe the earlier baseline. Live owner signing,
executable host configuration and real-agent acceptance remain critical-path work.

Owner approved preparing this plan after the read-only repository assessment, then approved local reuse integrations and continuing until sensible reusable pieces are integrated. Public GitHub research and needed logged downloads are allowed; pushes, PRs, merges and Actions remain paused. This document does not authorize native/provider attempts, credentials, standing services or deployment. Previous narrowly scoped live qualifications are not reusable permission.

This is the current assessment sequence, not an accepted replacement architecture. Preserve prior acceptance evidence. Candidates below began as source research; E01 has since tested an isolated pg-boss package against PGlite, without adoption. Current-branch sources were readable unevenly; immutable revisions and complete dependency licenses must be captured before import. Three bounded independent research reviews informed this plan; their findings do not constitute live acceptance or final security approval.

Goal: assemble maintained components into the owner's project-neutral product, building only necessary product rules and integration. Prefer a package/API, then a small attributed module, then a justified fork. Never equate stars, README claims or upstream tests with compatibility here.

## Complete owner-outcome inventory

Status describes evidence at the baseline, not a percentage or a claim that every file is unimplemented. Earlier completion-program baseline rows are historical and must not generate duplicate work orders.

| ID | Desired outcome | What we retain | Remaining work and acceptance |
|---|---|---|---|
| R01 | Arbitrary projects, separate pages/tabs | Private catalog/create/detail and SQL project services | Activate real database/application; browser creates two projects and isolates their tasks. Finish promised sections beyond currently mounted overview/tasks/settings. |
| R02 | Archive/reopen with history | Ordinary-project lifecycle services/UI | Exercise real persistence; archive is distinct from cancellation and closing a tab. Decide and implement Idea-project lifecycle through the same ordinary workflow. |
| R03 | Convenient secure login | Access verification, session revocation/logout | Configure actual IdP/MFA and session policy; verify login, expiry, logout, origin isolation and consequential-action approval. No custom password/TOTP implementation. |
| R04 | Public information page, separate private application | Accepted separation design | Deploy separate surfaces only when authorized; private name is discoverable, so enforce authentication/private ingress rather than secrecy. |
| R05 | Home/phone and permitted work access | Origin policy design | Real browser/mobile checks. Work alias needs employer-approved access; optional and not a reason to block home use. |
| R06 | Website task -> real agent -> result -> review/revision | Task preparation, assignment, signed-file intake, result/review/revision services and connector components | Finish protected dispatch, usable approval/signing integration, resource/config bootstrap and live wiring. Run one authorized real task and a revision with genuine artifacts. Current task service reports dispatch not connected. |
| R07 | Mac/PC/VPS Hermes and Codex | Native Hermes adapter, separate partial Codex adapter, enrollment/connection records | Runnable packaged entrypoints, distinct identities, supported versions and actual per-host evidence. Current connector directly uses Hermes; don't claim Codex or Windows support from it. |
| R08 | Parallel jobs, continuous pickup, submit then continue | Canonical capacity/result ownership and revisions | Choose queue substrate; implement continuous eligible pickup, concurrency, failures/triage and batch review. Current node composition is bounded to selected work, not a live fleet scheduler. |
| R09 | Several bots discuss an idea -> ordinary project | Fake Idea flow and private read-only shared catalog | Protected real conversation, participants/history, bounded orchestration, owner synthesis/promotion and proposed initial tasks. Private Idea Lab is not mounted as a live panel. |
| R10 | ABS current articles -> research/setup/draft jobs | ABS action/materialization and deterministic digest components | Approved feeds, provenance/freshness, private page and real article-to-task/result flow. Publishing is a later separate permission. |
| R11 | Recurrence, visible skills/models/capabilities/budgets | Schedule/capability/package contracts | Actual scheduler, pre-claim eligibility, bounded policy and usage where observable. Distinguish measured usage from estimates and hard limits from advisory limits. |
| R12 | Reconnect and safe updates | Journal/wire/HTTPS/runtime recovery components and tests | Real service lifecycle, version overlap, canary/drain/rollback and interrupted-network tests. Browser refresh never starts another job. Single-VPS brief outage is possible. |
| R13 | Private PostgreSQL, recoverable data, artifact storage | SQL roles/schema and rehearsal code | Authorized real PG rehearsal/deployment, backups and actual restore, retention and artifact integration. PGlite is not production concurrency evidence; no AWS RDS. |
| R14 | One attention inbox, evidence and safe approvals | Per-task reviews/results, projection components | Private global Needs Me/Inbox, cross-project discovery, blocked/review states and bounded commands. No fake empty/healthy state on source failure. |
| R15 | Content Blooms and Wayfarer | Existing consumer contracts/packs | Separate real consumer acceptance after core daily use; neither changes core architecture. |
| R16 | Possible future open-source sharing | Existing release preparation | Exact provenance, notices, dependency/license inventory, clean examples and supported setup instructions. No current public-release commitment. |

## Candidate and replacement register

Effort bands are comparative integration estimates, not completion promises. A recommendation is not an adoption decision.

| Area | Preferred candidate / alternative | Concrete reuse and expected effort | Selection conditions |
|---|---|---|---|
| Queues/timers | [pg-boss](https://github.com/timgit/pg-boss), MIT | Adopt package: pickup, schedules, deferral/backoff and dead letters. Lower expected disruption than replaying the whole application. [Implemented timekeeper](https://github.com/timgit/pg-boss/blob/master/src/timekeeper.ts). | Same-transaction canonical enqueue, role/schema compatibility, shutdown/recovery and no duplicate native starts. Keep DB private; laptop agents don't get DB credentials. |
| Broader workflow recovery | [DBOS TypeScript](https://github.com/dbos-inc/dbos-transact-ts), MIT SDK | Alternative if workflow/step replay removes more custom recovery than it introduces; medium/high migration effort. | Compare durable waits, child/review flows, upgrade compatibility and migration surface. [Conductor/Console production licensing is separate](https://docs.dbos.dev/production/hosting-conductor); distributed recovery needs explicit coordination. |
| Full worker platform | [Hatchet](https://github.com/hatchet-dev/hatchet), MIT root/TS SDK | Alternative with engine/API/dashboard and worker routing; larger operational change. | Demonstrate why supplied platform is worth additional lifecycle/auth/schema management on KVM2. No requirement for Kubernetes; don't reject using exaggerated footprint claims. |
| Hermes runtime | [Official run handlers](https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/api_server_runs.py), MIT | Use supported API rather than copy/fork Python runtime. Keep thin exact-profile/evidence adapter. | Verify pinned installed capabilities. Durable idempotency can fall back to memory; SSE is not cursor replay, interrupted execution is not transparent resume. Inspect [room grants](https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/api_server_room_grants.py) before inventing Hermes-specific permission plumbing. |
| Codex runtime | Existing adapter plus supported upstream interface review | Retain domain normalization; refresh exact interface/version/platform research before selecting replacement. | Unresolved candidate review, not assumed reuse or compatibility. Official SDK/app-server/CLI comparison required before implementation. |
| ABS selection | [Control Center industry-curation](https://github.com/mreflow/control-center/blob/main/lib/industry-curation.ts), MIT | Adopt small pure normalization/scoring/grouping/diversity functions; low/medium. | Compare existing digest behavior; adapt only missing functionality, don't create two ranking pipelines. Preserve attribution and deterministic equivalence fixtures. Freshness module body was not refreshed successfully. |
| Conversations/project UX | [Hermes WebUI workspace](https://github.com/nesquena/hermes-webui/blob/master/static/workspace.js), [journal](https://github.com/nesquena/hermes-webui/blob/master/api/run_journal.py), MIT | Adapt implemented grouping/archive/reconnect interaction cases into existing React app; medium. | Python/large vanilla-JS modules are not drop-in React components. Its session SSE RFC remains proposed; use actual run-journal behavior, not proposed endpoint promises. |
| Progress/session presentation | [Hermes Desktop Sessions](https://github.com/fathah/hermes-desktop/blob/main/src/renderer/src/screens/Sessions/Sessions.tsx), MIT | Adapt selected React UI and event display helpers, low/medium. | Exclude Electron IPC/credentials/updater. SSE parser retains last data line: not a general framing/replay implementation. |
| Idea-room product | [Hermes Studio](https://github.com/EKKOLearnAI/hermes-studio) | Implemented room workflow is comparison evidence; no source adoption currently selected. | [BSL grant](https://github.com/EKKOLearnAI/hermes-studio/blob/main/LICENSE) is non-commercial, future Apache conversion is not current permission. Private/no-sale does not settle business-use scope. Separate license needed if chosen. |
| Coding-agent teamwork | [AI Maestro](https://github.com/23blocks-OS/ai-maestro), MIT; [Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator), Apache-2.0 | Further focused module selection for messaging/workspaces/review routing; not wholesale adoption. | No second job authority or shared live checkout. Assess extraction cost before deciding custom is cheaper. Current source differs from older Composio/MIT search summaries. |
| Login | Retain accepted Access + existing IdP integration; [Authelia](https://github.com/authelia/authelia), Apache-2.0, if self-hosted identity is actually needed | Configure existing identity system; don't author auth server. | Do not switch a reviewed approach without a concrete gap. Test actual owner MFA/session experience; no configuration acceptance yet. |
| Monitoring | [Uptime Kuma](https://github.com/louislam/uptime-kuma) / [Beszel](https://github.com/henrygd/beszel), MIT | Adopt services for uptime/notifications and host metrics rather than copy their engines. | Start only what is needed; protect APIs/tokens. Metrics inform health, not canonical capacity/permission. Current Kuma major version differs from archived deployment notes. |
| Backup/restore | [pgBackRest](https://github.com/pgbackrest/pgbackrest), MIT | Adopt maintained PostgreSQL backup/restore tooling. | Prove restore and selected object-store compatibility; don't infer R2 behavior from generic S3 support. No database provisioning now. |
| Service supervision/update | Existing OS service managers and immutable releases; specific packaging comparison still open | Configure supervisors rather than author a new daemon manager. | Real executable entrypoint required; existing templates alone aren't an installer. Adapter protocol/schema compatibility and canary policy remain product integration. |

## Evaluation method and stopping rule

**E06 addition — real cross-machine files:** [Hermes transfer assessment](research/REUSE_E06_HERMES_TRANSFER.md)
maps this gap to R06/R07/R13 and the Idea Lab/ABS handoffs. Evaluate native RoomLink
attachments and bot-generated file publication before inventing another file protocol.
Cross-gateway chats are merged; file PRs #98072/#99159 were still open at inspection.
Owner clarification identified merged #103600 as the quoted feature: retrieve output
from a remote execution sandbox into the gateway's cache. Evaluate that smaller merged
path first for ordinary task results; keep RoomLink for independent bot handoff.
[E07](research/REUSE_E07_HERMES_REMOTE_FETCH.md) subsequently passed 11 offline tests of
the original transport. Run completion still lacks a canonical file handoff; inspect
the existing authenticated media API rather than silently widening the text-result path.
[E08](research/REUSE_E08_HERMES_FILE_API.md) found the dashboard read/download endpoints
but no Control Room project/run binding. Nine path-policy tests preserve that limitation.
Do not activate a broad dashboard file browser as our artifact service, or import the
credential/skill filesystem sync. A narrow verified producer-to-project bridge remains;
this does not block other selected reuse integrations or erase the rich-file outcome.
Keep project/attempt authorization and a Codex-compatible artifact path in Control Room.
Pinned offline tests precede adoption; no installed-fleet capability or live transfer is
claimed. Prepare during B/C, use in D, and do not delay B's text-only task for rich files.

1. Map each candidate to the inventory above. Search broadly once, shortlist at most three per infrastructure responsibility; add another only for a named gap. No endless repository census.
2. Record exact source revision, package release, license/notice files, dependency boundaries, maintenance/release/security signals, implemented source and relevant upstream tests. Record inaccessible evidence explicitly. Upstream tests inspected is different from tests executed here.
3. Apply pass/fail gates: permitted intended use and later redistribution plan; supported environment; no mandatory public DB/provider credentials in browser; compatible authorization boundaries; viable maintained deployment.
4. Score survivors 0-5 on requirement coverage (30%), code/operations eliminated (25%), integration/migration cost (20%), maintenance/upgrade evidence (15%), operating footprint/cost (10%). Record rationale and unknowns rather than invented precision. Scores rank investigation, not override failing gates.
5. Test the smallest representative integration against a pinned package, using disposable data. Retain observations, failures and estimated deletion/replacement surface. Installation and real PG/runtime effects need a scoped packet before execution.
6. Architect records adopt/adapt/retain/defer, rejected alternatives and reasons. Do not preselect pg-boss on README alone. Choose one engine per job class; don't install all three by default.

## Common finalist test card

Use the same canonical task/attempt/result IDs and fake native effect ledger for each queue candidate. Later repeat selected essential cases with authorized real PostgreSQL and one native agent.

| Scenario | Required observation |
|---|---|
| Enqueue with project/task transaction | Rollback yields neither task dispatch nor orphan queue item; commit preserves one discoverable request. |
| Two eligible workers, incompatible third | Work claimed according to current project/capability/capacity policy; incompatible worker cannot execute it. |
| Crash before send / after external start before receipt | Before-send work can recover; ambiguous start reconciles original identity rather than blindly launching again. |
| Disconnect and duplicate delivery | Same operation identity is preserved; no fabricated replay or second external effect. |
| Retry/failed task | Safe retry bounded; uncertain effects held; actionable failure visible; unrelated jobs continue. |
| Long review wait and revision | Worker capacity released after submission; other jobs proceed; review does not become an automatic pass; revision has linked distinct identity. |
| Scheduled work and downtime | Explicit timezone/DST and missed-run policy; no unintended flood or duplicate occurrence. |
| Stop / revoked approval | No new execution from revoked authority; requested stop is distinguished from observed termination. |
| Upgrade/drain/rollback | New admissions pause only as needed; accepted results survive; compatible versions reconnect; rollback doesn't destroy schema/data. |
| Retention and recovery | Operational records prune by policy without losing required task evidence; actual backup restores expected records/artifacts. |

Record pass/fail/not-run for each case, exact version/environment and sanitized evidence. PGlite results do not certify real PostgreSQL locking/roles. No workflow engine promises exactly-once external effects merely because its queue uses that phrase.

## Custom infrastructure exception template

Every new custom infrastructure proposal must name: required behavior; at least two examined alternatives (or why only one exists); exact failing source/test/license constraint; why a thin adapter cannot close it; expected code and ongoing maintenance cost; deletion/exit strategy; architect decision.

Potential justified custom responsibilities are canonical project/result/review relationships, current approval checks, cross-harness normalization and uncertain-effect reconciliation. This is not blanket exemption: use upstream primitives beneath those rules. Existing code, generic 'security', 'more control', or familiarity alone are insufficient reasons.

## Delivery sequence after selection

| Block | Coherent deliverable | Acceptance / dependencies |
|---|---|---|
| A — replacement decision | Close open source/version/license items; evaluate queue finalists; select exact integration and retirement map | Written decision with actual test evidence where authorized; no adoption claimed from research. |
| B — first usable project | Real PG/bootstrap/login, protected dispatch and usable approval integration, one Marvin task -> artifact -> review/revision | One owner browser journey plus recovery case. This is the next product milestone, not another series of unmounted components. |
| C — productive fleet | Packaged per-host adapters, compatible identities, continuous pickup, concurrent tasks and global Needs Me | Mac/PC/VPS evidence, independent tasks continue while another awaits review; no manual message relay. |
| D — Idea Lab and ABS | Real bounded discussion -> ordinary project/work; sourced news -> selected task -> reviewed output | Build in parallel once B's application services are stable. Use attributed components and ordinary job pipeline. |
| E — daily-use acceptance | Monitoring, restore, update/rollback, retention and sustained fleet trial | Start operations work during B/C, not after data exists unprotected. Final gate includes C/D journeys. |
| F — optional consumers/public sharing | Specialist project packs, public information/release work | Separate scope; license/provenance readiness is continuous, not cleanup deferred until publication. |

Keep private PostgreSQL on the VPS as global write authority, R2 for artifacts/backups only. Tailscale remains reachability, not job authorization. Preserve GitHub bootstrap until deliberate per-job-class handover; publication is currently paused.

## Team and owner responsibilities

Architect owns inventory reconciliation, boundary decisions, database/migration design, final acceptance and integration. Bounded research/build agents can inspect candidates, build isolated UI/pure-module adapters and run authorized deterministic tests. Independent reviewers test failure claims and provenance. External host agents participate after exact installer/prerequisite packets exist; no shared checkout or credential copying.

Owner decisions should be consolidated: selected identity/private deployment configuration, one scoped disposable PG/package-evaluation authorization if needed, then exact live host activation. No repeated approval for ordinary already-authorized source work, and no implied permission for services/native calls from approving this plan.

Next action: close the focused queue/Codex/supervision evidence gaps and prepare the bounded finalist test packet plus code-retirement map. Do not resume the old custom dispatch-building sequence automatically. Research has not established a defensible total percentage or delivery date.

Progress: [REUSE_FIRST_VALIDATION_PACKET.md](REUSE_FIRST_VALIDATION_PACKET.md) records the existing queue baseline, supported Codex interface recommendation, service-packaging gaps and acquisition/test authority. The owner approved needed downloads; [E01](research/REUSE_E01_PG_BOSS_RESULTS.md) now records 11 passing actual pg-boss/PGlite tests and the important cache/retention limitations. Candidate adoption remains undecided until real PostgreSQL and integration tests. [Download ledger](REUSE_DOWNLOAD_LOG.md) tracks exact acquisitions, storage and cleanup; no application dependency was added.

Subsequent progress: [E02](research/REUSE_E02_POSTGRES_RESULTS.md) exercised pg-boss on an
owner-approved temporary PostgreSQL cluster. Nine distinct checks passed across the original
and focused follow-up runs, including real concurrent pickup, clean restart, narrow role
correction and the actual capacity store. Preserve the original role failure. Cluster stopped
and disposable data removed; no production dependency or service adopted. Next integration
experiment should connect canonical approval/intent/audit and operational queue submission
with exact replay policy and runtime grants, then extend the common test card. pg-boss is
the leading candidate; a second queue/workflow platform still needs a concrete unmet need.

Local implementation progress: [REUSE_INTEGRATION_PROGRESS.md](REUSE_INTEGRATION_PROGRESS.md)
records the tested canonical pg-boss submission adapter and first attributed ABS source
adaptation. Continue that live handoff rather than treating the older assessment-only
or package-not-installed statements as the current implementation state.

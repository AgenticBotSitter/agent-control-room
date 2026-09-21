# Final single-machine execution plan

**Status:** active source plan, September 20, 2026.

## Product decision

Agent Control Room has two installation choices: **This computer** and **Several computers**. They are one product: one PostgreSQL authority database, the existing pg-boss queue, one task/result/review/correction lifecycle, and the same signed delivery packet.

The local enablement order is Hermes / Marvin, Codex, Claude, then three-agent daily use and remote delivery. Later source work may proceed while an earlier real-world proof waits on the owner. An unproven capability is never shown as live.

## Donor decisions

| Donor | Useful behavior | Decision |
| --- | --- | --- |
| T3 Code, MIT, `6a699f0` | Clear unavailable, reconnecting, incompatible and failed connection messages | Reuse behavior/tests in Control Room React panels. Do not import its Effect supervisor, relay, profile store, RPC runtime or stdio host; status output can reveal private URLs and SSH identities. |
| Hermes WebUI, MIT, `f6a37b2` | Bounded browser-refresh coalescing and deliberate-loss distinction | Behavior/test reference only. Do not import its Python app, session DB or read-only-to-writable SQLite fallback. A browser refresh is never task proof. |
| Hermes Desktop, MIT, `2663e2e` | Separate connection, authorization, capability and unknown states; prevent duplicate approval submission | Presentation reference only. Do not import Electron, IPC, secrets, SSH setup or broad always-approve behavior. |

No donor source is copied by this plan. A future extraction must pass `REUSE_DECISION_GATE.md`, preserve notices in `THIRD_PARTY.md`, and prove it saves more code than it costs to integrate.

## Build packages

### P0 — Shared local foundation

Finish the existing project, task, result, review, correction, worker and attention screens. Show safe reason codes and proof freshness, not paths, accounts, tokens or addresses. Prove canonical task identity, duplicate-delivery refusal, disposable recovery and truthful missing-proof UI.

### P1 — Make Marvin useful first

Use the existing Hermes queue delivery, controlled subprocess, task policy, terminal staging, receipt and pending-review publisher. Keep private executable, profile, model/provider and folder bindings out of task records.

The current `bot_room` route is text-only, not project writing. First jobs are supplied-context reviews, acceptance cases, test outlines and proposed patches returned as text. Codex reviews/applies changes. Then qualify a separate writing route with an isolated worktree, exact allowed files/commands, bounded diff, out-of-scope denial and process-tree cancellation. Prove one task reaches review once, restart uses staged evidence, and forbidden/expired work cannot start. Writing also needs a permitted change and blocked out-of-scope attempt.

The current text-only path also performs a fresh canonical task/lease/authority
check after its delivery receipt is retained and immediately before the private
Hermes runner is invoked. A cancellation or permission withdrawal in that
handoff window stops the run instead of being treated as an automatic retry.

The shared worktree-change audit is source-only preparation for that later writing route. It binds a returned list of changed files to one approved delivery, one existing worktree lease, one base revision, explicit file limits and exact allowed paths. It also refuses a worktree lease that belongs to a different delivery run. It does not create a worktree, run Git, launch a harness or turn an audit into permission to write. This is deliberately shared so a later local or remote worker uses the same evidence rule rather than a separate local-only system.

### P2 — Codex second

Keep App Server framing, journals, workspace identity, approval intake and result pipeline. The reviewed native bridge remains Linux-only. Before a macOS activation, prove suspended executable identity and protected private-state directory custody. Otherwise show the limitation, never a pretend Mac button. Prove bounded task, denial, stop/cleanup, result, restart read, bad-frame refusal and lost-reply recovery.

### P3 — Claude third

Keep the bounded JSON-lines decoder, owned process-session helper and canonical result publisher. Add only a private process-acquisition host under them; all authority stays shared. Prove authenticated task, denial, cancellation and post-restart result reading without a guessed retry.

### P4 — Complete locally, then extend remotely

Finish capability-aware assignment, progress, attention, correction, schedules and research-to-task promotion on the same queue. Idea Lab participant rounds are ordinary canonical tasks, not direct provider calls; the accepted rule and its migration/acceptance proof are in [IDEA_LAB_CANONICAL_LIFECYCLE_DECISION.md](IDEA_LAB_CANONICAL_LIFECYCLE_DECISION.md). Later add remote enrollment, compatibility, reconnect, revocation and a two-node proof below the existing delivery contract. Every qualified agent must complete the same project → task → delivery → result → review → correction journey across restart and disposable restore. Remote delivery never adds synchronization or a second writer.

## Owner-attended gates

Source work can continue without the owner. Live enablement needs private bindings, exact harness qualification, actual database/artifact/backup choices, a narrow first coding task and any persistent supervisor. Codex on macOS and Claude have their additional process-specific gates. Remote enrollment follows local proof.

# Reuse candidate register

This is the short, living list of outside projects considered before Control
Room writes comparable infrastructure. An entry is **not** permission to copy
code or a claim that it has been integrated. Before adoption, pin an upstream
revision, inspect the exact files, verify the license and notices, prove the
fit with disposable data, and record the resulting decision in `THIRD_PARTY.md`
if any material is retained.

Control Room keeps one authoritative PostgreSQL database, one task/review
lifecycle and explicit effect boundaries. A candidate may improve a user
interface or adapter, but it may not silently replace those rules.

For any substantial new component, the required comparison and adoption record
is defined in [REUSE_DECISION_GATE.md](REUSE_DECISION_GATE.md). This register
is the candidate inventory, not a substitute for that decision.

| Candidate | Current decision | Useful possible parts | Must not adopt without a separate fit test |
| --- | --- | --- | --- |
| `mreflow/control-center` | Partially adopted for news collection only. | Feed discovery, source reading, freshness and curation. | Its application-level workflow, identities, scheduling or storage assumptions. Provenance is in `THIRD_PARTY.md`. |
| `asimons81/hermes-gpt` | Source-inspected, conditional Hermes connector target. | The documented session continuation, status and result shapes. | A live connector until controlled qualification proves the selected Hermes interface. |
| `herdrdev/herdr` | Optional and deferred. | Read-only terminal/session observation. | Task authority, launch control, scheduling, approval or result publication. |
| `alibaba/open-code-review` | Planned review-tool evaluation. | A supplementary code-review pass after ordinary project checks. | Final approval, merge authority, credentials or the worker queue. |
| `pingdotgg/t3code` | **Reference / adapt concepts only; no code retained.** MIT, pinned at `6a699f0f2fbd8847d7ec2df8d9245ce8c2eb8707` (2026-09-20). | Version compatibility refusal, plain-English connection/reconnect presentation, and installer/service ordering concepts. | Its Effect runtime, connection supervisor, relay, credential/profile stores, RPC/session ownership, native helpers, event model, installer and provider control. Control Room's canonical records and effect boundaries remain authoritative. |
| `nesquena/hermes-webui` | **Source-inspected; no code retained.** Inspected at `f6a37b2381b2c3f3dc5f1425c2812268b0aa6b2b` (2026-09-20). | Bounded/coalesced browser refresh and conservative session-recovery behavior as acceptance-test inspiration. | Its full Python server, session database, profile/provider settings, agent loop, file browser, cron, authentication or command controls. |
| `fathah/hermes-desktop` | **Source-inspected; no code retained.** Inspected at `2663e2e63fb834c15a30e1e15068277d4339c35d` (2026-09-20). | Capability, connection and active-session presentation ideas. | Electron runtime, IPC, secret store, SSH/remote setup, provider/model management, session database, dashboard state or installer. |
| `jmanzo/ralph-sandbox` | **Source-inspected; selectively adapt later.** Pinned for evaluation at `5cc70ef4d09e336e6d9c5cedd91a87270eeb51b6` (2026-09-20). Do not install, vendor, or use for the local Hermes worker. | Later optional hardened development-worker mechanics: private writable clone, no Docker-socket exposure, egress containment, resource caps, progress-stall observation, and host-side notifications. | Its complete Docker/runtime setup, writable-host default, credentials, provider fallback, completion signals, scheduler, logs/snapshots, or dependency recipe. It is not a Hermes adapter or Control Room authority system. |
| `anthropics/claude-agent-sdk-python` | **Source-inspected; reference only.** MIT, pinned at `f7547d7233527739ece8b12ed28c57be96c966b5` (2026-09-21). | Chunk-safe line framing, cancellation-resistant cleanup, and subprocess buffering test cases. | Python runtime, executable discovery, inherited environment, resume/settings/plugins, permissive output handling, and its longer cleanup window. Control Room retains its stricter owned-session lifecycle. |
| `anthropics/claude-code-action` | **Source-inspected; rejected as runner.** MIT, pinned at `cfc3eb22bfed5c26ef66e3223c982af27e4524de` (2026-09-21). | Negative result-classification tests: a `success` subtype with an error flag is still failure; max-turn results must not be treated as success. | GitHub Actions runtime, SDK wrapper, inherited settings/environment, raw-message collection, transcript files, arbitrary options, and its result-only completion rule. |
| `herdrdev/herdr` | **Source-inspected; reference only.** Apache-2.0, pinned at `309749ad65f3aa596f077ec23a1bf3ee428b7a04` (2026-09-21). | Read-only pane/session observation and generation-aware reconnect-state tests. | Its remote attach, server start, SSH bridge, pane control, scheduling, task execution, result publication and transport authority. The accepted observation pin is not changed by this research. |
| `joeynyc/honeycomb-lab` | **Source-inspected; reference only.** MIT, pinned at `848feef3ea2473b4673d0c4031e954dfb2d0a2a2` (2026-09-22). | Compact status vocabulary, visibly stale last-known activity, bounded history, transition notifications, and hostile-input test ideas. | Its Swift fleet application, Python gateway/router, SSH/Docker controls, browser token storage, host inventory, installer, service, or any second worker authority. |
| `joeynyc/hermes-hudui` | **Source-inspected; selectively adapt presentation only.** MIT, pinned at `3604013b434cc2f65f9add1ac6990d6c700ebe6d` (2026-09-22). | Small React/Tailwind panel shell, responsive tabs, worker/attention/activity grouping, and result receipt/timeline presentation, retyped to Control Room's existing safe browser contracts. | Its FastAPI backend, Hermes/process/tmux/session collectors, alternate task state, raw transcript/replay controls, watcher/WebSocket runtime, signer/exporter, remote mode, or any agent control. |
| `joeynyc/hermes-hud` | **Source-inspected; selectively adapt tests and display organization only.** MIT, pinned at `ad6300ff4b99226684f33edb95f600d079d33166` (2026-09-22). | Compact live/idle/attention/recent-activity grouping and negative tests for missing tools, malformed output, process races, and stale observations. | Its Python TUI/runtime, direct SQLite/profile/session readers, filesystem/project scans, raw command-line/cwd/pane capture, heuristic readiness, JSONL snapshot store, scheduling, or task authority. |
| `joeynyc/openclaw-mission-control` | **Source-inspected; UI ideas only, no source retained.** Pinned at `2a5c9ee098dd8243f27af1d8246cf1c36894f89f` (v1.1.0, 2026-09-22); README claims MIT but no LICENSE file exists. | A compact two-column command-room layout and read-only connection/service/model/skill/cron card concepts. | All source/runtime reuse until a real license is supplied; its Swift application, direct gateway/CLI actions, prompt-based task dispatch, in-memory activity, polling, credentials, install script, and unaudited effect behavior. |

## T3 Code initial finding

The pin and exact source-file list in
[INSTALLATION_REUSE_IMPLEMENTATION_MAP.md](INSTALLATION_REUSE_IMPLEMENTATION_MAP.md)
record an earlier source inspection. This repository does not vendor that
upstream checkout or any T3 file, so this audit can confirm the pin and the
absence of retained source here, but cannot repeat a line-by-line upstream
comparison offline. T3 therefore has no `THIRD_PARTY.md` entry: the MIT notice
is required only if T3 source is later copied or materially adapted.

T3 Code is MIT licensed. Its upstream architecture keeps provider processes and
project files in the environment that owns them, exposes a versioned RPC
contract to independently updated clients, and isolates provider-specific
behavior behind adapters. Those are useful design references for the **This
computer** installation choice and later phone/desktop access.

It is not a drop-in Control Room backend. Its upstream project describes itself
as early, and its orchestration event log, server process, client sessions and
provider controls would overlap with existing Control Room authority and
security boundaries. Reusing the whole product would create competing
orchestration systems, which this project explicitly forbids.

## Next bounded evaluation

Before any code is copied or adapted:

1. Inspect the exact pinned adapter and client-runtime files, including their
   dependency licenses and notices.
2. Map one concrete gap at a time: local provider-status display, capability
   negotiation, or reconnect presentation.
3. Build a disposable read-only prototype against Control Room's existing
   delivery/result records. It must neither start a provider nor grant task
   authority.
4. Compare the prototype against the smallest existing Control Room component
   it would replace. Adopt only if it removes real custom code without adding a
   second authority, scheduler, database, or credential path.

## Ralph Sandbox source finding

Ralph Sandbox is MIT licensed at the inspected pin, but its runnable image is
not yet suitable for Control Room reuse: it resolves agent packages and system
packages without a locked dependency inventory or software-bill-of-materials.
Its helper shell scripts contain useful containment and recovery ideas, but
the runnable product defaults to a writable host mode, broad persistent
credentials and model-declared completion/fallback behavior that conflict with
Control Room's exact task assignment, review, and evidence rules.

The only future fit is an **optional** isolated code-writing executor behind
the existing Control Room task, approval, result, and review contracts. That
future package may study a read-only source/private writable clone, no Docker
socket, internal-only network plus egress proxy, fixed resource limits and
host-side notifications. It must reimplement those pieces with pinned images,
license inventory, a task-bound policy, durable journal, cleanup proof and no
shared credentials. It does not affect the current local Hermes integration path.

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
| `pingdotgg/t3code` | **Source-inspected; no code retained.** Inspected at `6a699f0f2fbd8847d7ec2df8d9245ce8c2eb8707` (2026-09-20). | Version compatibility refusal and plain-English connection/reconnect presentation patterns. | Its Effect runtime, connection supervisor, relay, credential/profile stores, RPC/session ownership, native helpers, event model, installer and provider control. Control Room's canonical records and effect boundaries remain authoritative. |
| `nesquena/hermes-webui` | **Source-inspected; no code retained.** Inspected at `f6a37b2381b2c3f3dc5f1425c2812268b0aa6b2b` (2026-09-20). | Bounded/coalesced browser refresh and conservative session-recovery behavior as acceptance-test inspiration. | Its full Python server, session database, profile/provider settings, agent loop, file browser, cron, authentication or command controls. |
| `fathah/hermes-desktop` | **Source-inspected; no code retained.** Inspected at `2663e2e63fb834c15a30e1e15068277d4339c35d` (2026-09-20). | Capability, connection and active-session presentation ideas. | Electron runtime, IPC, secret store, SSH/remote setup, provider/model management, session database, dashboard state or installer. |
| `jmanzo/ralph-sandbox` | **Source-inspected; selectively adapt later.** Pinned for evaluation at `5cc70ef4d09e336e6d9c5cedd91a87270eeb51b6` (2026-09-20). Do not install, vendor, or use for the local Hermes worker. | Later optional hardened development-worker mechanics: private writable clone, no Docker-socket exposure, egress containment, resource caps, progress-stall observation, and host-side notifications. | Its complete Docker/runtime setup, writable-host default, credentials, provider fallback, completion signals, scheduler, logs/snapshots, or dependency recipe. It is not a Hermes adapter or Control Room authority system. |

## T3 Code initial finding

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

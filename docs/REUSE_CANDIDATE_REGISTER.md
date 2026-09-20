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

| Candidate | Current decision | Useful possible parts | Must not adopt without a separate fit test |
| --- | --- | --- | --- |
| `mreflow/control-center` | Partially adopted for news collection only. | Feed discovery, source reading, freshness and curation. | Its application-level workflow, identities, scheduling or storage assumptions. Provenance is in `THIRD_PARTY.md`. |
| `asimons81/hermes-gpt` | Source-inspected, conditional Hermes connector target. | The documented session continuation, status and result shapes. | A live connector until controlled qualification proves the selected Hermes interface. |
| `herdrdev/herdr` | Optional and deferred. | Read-only terminal/session observation. | Task authority, launch control, scheduling, approval or result publication. |
| `alibaba/open-code-review` | Planned review-tool evaluation. | A supplementary code-review pass after ordinary project checks. | Final approval, merge authority, credentials or the worker queue. |
| `pingdotgg/t3code` | **New: source-inspected candidate; no code retained.** Pinned for evaluation at `7445aa733ada33e45289e5aa5055f79142556513` (2026-09-19). | Local multi-harness control-surface ideas: provider adapters, authenticated client/server boundary, capability negotiation, connection/reconnect presentation, and mobile/desktop/web experience patterns. | Its complete application, event-log/database model, service installer, update mechanism, authentication design, provider credentials, or background process control. Control Room's canonical records and effect boundaries remain authoritative. |

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

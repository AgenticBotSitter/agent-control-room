# CR14A — upstream reuse decisions

**Checked:** 2026-09-04. Source/docs/license inspection only; no upstream install or native/provider test.
No third-party implementation code is copied in CR14A. Preserve attribution and license notices if code is later
adapted; pin and review the exact source and dependencies. No claim of tested installed-host compatibility is made.

## Keep Control Room as the integrating product

Keep the project-neutral UI, PostgreSQL authority, node ceilings, review/evidence model and GitHub bootstrap.
Do not import a competing global scheduler, expose four unrelated admin dashboards, or replicate their local SQLite
state into a second global authority. Reuse focused modules and interaction patterns, not whole runtimes by default.

| Source and inspected revision | Useful part | Decision / boundary |
|---|---|---|
| `mreflow/control-center` / `d13e79e866cc33a1fddfe84f563ce2fb9a2113e0` | Industry relevance, source diversity, canonical story grouping, freshness and daily information view | MIT; adapt focused helpers for ABS, not its local settings/database/security model |
| `nesquena/hermes-webui` / `e168b67e4278df618d1cab61fdb3a8dc55b29a81` | Conversations, project/session organization, event journaling and reconnect patterns | MIT; reference existing working stream behavior; Python runtime is not a drop-in TypeScript connector |
| `fathah/hermes-desktop` / `3f744975f818bbb40ed029e6b3022cd0c5ad7a24` | Connection onboarding, profile selection, tool/usage display and session reconciliation | MIT; selected TypeScript helpers/patterns, no Electron shell or updater dependency |
| `EKKOLearnAI/hermes-studio` / `8544f4b59dd43bae1984b45f601190fb4a0f69ee` | Multi-harness rooms, project workspace and workflow/result navigation | BSL 1.1 with restricted commercial use; workflow inspiration only unless separately licensed |
| `NousResearch/hermes-agent` release `v2026.8.31` / `29112bef099274229cadff79cdff7bf7b99c4b77` | Native run/status/events/stop/idempotency capability and desktop-independent Bot Mode peers | Preferred native interface for a thin, separately accepted adapter; not authority to run/update Hermes |

## Concrete implementation targets

### ABS

[industry-curation.ts](https://github.com/mreflow/control-center/blob/d13e79e866cc33a1fddfe84f563ce2fb9a2113e0/lib/industry-curation.ts)
provides configurable selection, reasons, duplicate/event grouping and source diversity.
[freshness.ts](https://github.com/mreflow/control-center/blob/d13e79e866cc33a1fddfe84f563ce2fb9a2113e0/lib/freshness.ts)
separates freshness from plausible dates. Our existing canonical story/digest/archive machinery stays authoritative.
First add deterministic digest selection using already-normalized stories; later connect collectors and real task
materialization. Do not re-fetch all articles or call an LLM merely to rank a small known collection.

### Conversation and connection UX

WebUI's [runtime adapter seam](https://github.com/nesquena/hermes-webui/blob/e168b67e4278df618d1cab61fdb3a8dc55b29a81/api/runtime_adapter.py)
is useful interface evidence, but its runner selection is default-off and does not prove live wiring.
Its [session SSE RFC](https://github.com/nesquena/hermes-webui/blob/e168b67e4278df618d1cab61fdb3a8dc55b29a81/docs/rfcs/session-sse-contract-v1.md)
explicitly separates proposed per-session replay from current run-journal streams. Preserve that distinction.
Borrow session continuity, unread/attention and reconnect presentation rather than copying an unimplemented promise.

Desktop's [SSE parser](https://github.com/fathah/hermes-desktop/blob/3f744975f818bbb40ed029e6b3022cd0c5ad7a24/src/main/sse-parser.ts)
is an example of testable tool-progress/usage parsing, not a validated complete replay/framing implementation for us.
Its Electron app updater is not a fleet rolling-update protocol. Reuse the guided local/remote setup experience;
avoid a new desktop distribution requirement for a browser-based Control Room.

Studio demonstrates the desired shared workspace across real runtime families in its
[README](https://github.com/EKKOLearnAI/hermes-studio/blob/8544f4b59dd43bae1984b45f601190fb4a0f69ee/README.md).
Its [license](https://github.com/EKKOLearnAI/hermes-studio/blob/8544f4b59dd43bae1984b45f601190fb4a0f69ee/LICENSE)
requires separate commercial licensing for commercial use; future Apache conversion is not permission today.
Private hosting alone does not settle the license question for the owner's business projects.

### Hermes native interface

The release's [run implementation](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/gateway/platforms/api_server_runs.py)
defines the lifecycle routes. [Peer CLI](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/hermes_cli/subcommands/peer.py)
and [Bot Mode guide](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/user-guide/bot-mode.md)
cover short messages versus durable run handles and desktop-independent reachability. Avoid main-branch drift.
The adapter still needs exact profile/identity binding, capability checks, run-scoped cancellation, event bounds,
credential custody and project isolation. Endpoint existence is not evidence that replay, hard budget enforcement
or our required tool restrictions are supported. Do not use native peer messaging as an alternate work dispatcher.

## License/source handoff

Before any later code import: retain source URL/revision/license and copyright notice; record adapted paths and
dependency changes; test behavior under our contracts; check that no credentials, raw profile data, unrelated
history, network defaults or duplicate scheduler are imported. Prefer a small original implementation of our
frozen requirements when adapting a large module would introduce more machinery than it removes.

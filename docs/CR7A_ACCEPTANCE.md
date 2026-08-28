# CR-7 harness foundation and Hermes adapter acceptance

**Status:** Accepted for the pinned, authority-bound Hermes gateway lifecycle. Discovery, start, stream, steer, cancel, resume, and usage are implemented. Approval response remains unimplemented because no approval request was safely reachable with all callable tools disabled.
**Scope:** CR7-FND-001/002 and CR7A-001/002/004. The owner authorized one provider-backed disposable lifecycle using Marvin's existing local Hermes installation and credentials. This acceptance does not authorize a production profile, unrestricted toolset, native dashboard connection, external job, install, service, or consequential effect.

## Frozen seam

- Adapter: `adapter.hermes.gateway.v1`, version `1.0.0`.
- Hermes package: `0.20.6` at exact installed upstream revision `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`.
- Runtime declaration: Python 3.11 or newer within Hermes's pinned supported range.
- Execution observability: TUI gateway JSON-RPC event frames.
- Management reads: exactly `/api/status`, `/api/sessions`, `/api/cron/jobs`, and `/api/analytics/usage` through an injected read transport.
- Implemented verbs are discovery, start, stream normalization, steer, cancel, resume, and usage. Approval remains observe-only.

## Delivered boundary

1. A strict, versioned harness manifest, run, lifecycle, event, usage, and lineage contract.
2. Migration 0020 with canonical harness runs and append-only events bound to the exact tenant, project, job, attempt, and node.
3. Monotonic event sequencing, exact replay, conflict detection, time-regression denial, terminal-state enforcement, and tenant-scoped Session Watch reads.
4. Sanitized Hermes gateway fixtures and event normalization that discard message deltas, transcript text, tool arguments, profile details, paths, and native session identifiers.
5. Read-only Hermes status, session, cron, and usage projection with bounded collections and one-way scoped digests for native session and cron identities.
6. A compatibility decision that fails closed on package-version drift, source-revision drift, missing required gateway methods, or duplicate/ambiguous method evidence.
7. An authority-bound gateway lifecycle client that refuses to submit a prompt unless the exact pin is compatible, the launch uses a disposable profile and workspace, context files are ignored, MCP count is zero, and Hermes reports zero callable tools.
8. A sanitized live qualification record that contains no prompt, transcript, credential, path, raw native identifier, or provider account identifier.

## Security disposition

- The live run used a disposable cloned profile and temporary workspace. Its MCP servers, plugins, configured toolsets, and project discovery were removed before the provider call. The gateway was then launched with `HERMES_TUI_TOOLSETS=context_engine` and `HERMES_IGNORE_RULES=1`; both initial creation and post-restart resume reported zero callable tools and zero MCP servers.
- The bounded provider-backed run produced structured start and stream events, accepted a steering correction, confirmed interruption, reported nonzero usage for the completed correction turn, persisted four transcript records, and resumed idle after a gateway restart without another prompt submission.
- Raw gateway output was used only as owner-attended qualification evidence and was not committed. The committed fixture contains only bounded statuses, counts, the exact public source pin, and negative-content assertions.
- Native identifiers are compared only at the node-local normalization boundary and are persisted only as tenant/node/adapter-scoped digests.
- Foreign event payloads are never retained wholesale. Unknown event types become bounded protocol-drift evidence or are deliberately ignored when they are lossy streaming/UI-only events.
- The serve adapter has no write route and receives transport as an injected dependency; live connection and authentication remain outside this effect-free slice.
- Hermes remains a harness beneath a Control Room attempt. It does not become the scheduler, approval authority, audit authority, global queue, or secret store.
- Hermes treats an empty or invalid TUI toolset selection as a fallback, not as no tools. The accepted no-effect pin is the valid built-in `context_engine` toolset, which resolves to zero tools at the exact accepted revision. Any pin or tool-count drift fails before prompt submission.
- Hermes's generic configuration display can print credential-bearing MCP URLs. Control Room must never call, capture, normalize, or persist raw configuration-display output; credential resolution remains inside the node-local Hermes process.

## Automated evidence

- Focused CR-7A suite: 11 passed, 0 failed.
- Full suite: 351 tests, 349 passed, 0 failed, 2 intentional platform skips.
- Type checking and ESLint pass.
- Production build and both rendered-route tests pass.
- Migration verification applies 0001 through 0020 and verifies 68 PostgreSQL tables.
- The disposable `cr7probe` profile and temporary workspace were deleted after evidence capture; Marvin's default profile and installation were not modified.

## Remaining boundary

Approval request/response remains observe-only until a separate no-effect harness path can deterministically produce an approval event without enabling a callable effect. A later node integration must add durable private native-session reference storage and preserve this exact fail-closed launch attestation. The immediate next block is the planned CR-7B Codex worker adapter. Any upstream, method-set, tool-count, or fixture drift returns Hermes lifecycle execution to incompatible until reviewed.

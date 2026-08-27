# CR-7 harness foundation and Hermes adapter acceptance

**Status:** Harness foundation and the effect-free Hermes discovery/read slice are complete. A provider-keyed disposable Hermes lifecycle remains owner-authorized work and is not claimed here.
**Scope:** CR7-FND-001/002 plus the non-live portions of CR7A-001/002/004. This record does not authorize a Hermes process, provider credential, prompt submission, native dashboard connection, or external job.

## Frozen seam

- Adapter: `adapter.hermes.gateway.v1`, version `1.0.0`.
- Hermes package: `0.20.6` at exact upstream revision `4956ff0cb9646aaf894c228e6dc932b126d1f927`.
- Runtime declaration: Python 3.11 or newer within Hermes's pinned supported range.
- Execution observability: TUI gateway JSON-RPC event frames.
- Management reads: exactly `/api/status`, `/api/sessions`, `/api/cron/jobs`, and `/api/analytics/usage` through an injected read transport.
- Implemented verbs are declared honestly as discovery, stream normalization, and usage. Start, steer, cancel, and resume remain unsupported until the disposable lifecycle gate passes.

## Delivered boundary

1. A strict, versioned harness manifest, run, lifecycle, event, usage, and lineage contract.
2. Migration 0020 with canonical harness runs and append-only events bound to the exact tenant, project, job, attempt, and node.
3. Monotonic event sequencing, exact replay, conflict detection, time-regression denial, terminal-state enforcement, and tenant-scoped Session Watch reads.
4. Sanitized Hermes gateway fixtures and event normalization that discard message deltas, transcript text, tool arguments, profile details, paths, and native session identifiers.
5. Read-only Hermes status, session, cron, and usage projection with bounded collections and one-way scoped digests for native session and cron identities.
6. A compatibility decision that fails closed on package-version drift, source-revision drift, missing required gateway methods, or duplicate/ambiguous method evidence.

## Security disposition

- No Hermes process was started and no live endpoint, credential, profile, workspace, prompt, transcript, tool argument, command output, or schedule body was read.
- Native identifiers are compared only at the node-local normalization boundary and are persisted only as tenant/node/adapter-scoped digests.
- Foreign event payloads are never retained wholesale. Unknown event types become bounded protocol-drift evidence or are deliberately ignored when they are lossy streaming/UI-only events.
- The serve adapter has no write route and receives transport as an injected dependency; live connection and authentication remain outside this effect-free slice.
- Hermes remains a harness beneath a Control Room attempt. It does not become the scheduler, approval authority, audit authority, global queue, or secret store.

## Automated evidence

- `npm run test:cr7a`: 8 passed, 0 failed.
- `npm test`: 348 tests, 346 passed, 0 failed, 2 intentional platform skips.
- Type checking and ESLint pass.
- Production build and both rendered-route tests pass.
- Migration verification applies 0001 through 0020 and verifies 68 PostgreSQL tables.

## Remaining owner gate

Before the adapter may declare start, steer, cancel, resume, reconnect, or approval-response support, Codex and the owner must run one disposable provider-keyed Hermes lifecycle against the exact pin. The run must use a disposable profile/workspace, bounded prompt, no project mutation, no production credentials, and sanitized fixture capture. It must test start, structured events, usage, waiting/approval behavior when available, cancellation, reconnect/resume, and terminal truth. Any upstream or fixture drift returns the adapter to incompatible until reviewed.

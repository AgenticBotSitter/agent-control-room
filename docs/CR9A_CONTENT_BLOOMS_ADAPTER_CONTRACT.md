# CR-9A Content Blooms source-scheduled adapter contract

**Status:** Frozen for effect-free repository implementation
**Contract:** `control-room-content-blooms-adapter/v1`
**Core boundary:** `control-room-project-adapter/v1`
**Live connector:** Disabled

## Purpose

Content Blooms is the first real source-scheduled project adapter. Content Blooms remains authoritative for customers, recordings, transcripts, voices, knowledge, recipes, content, reviews, source schedules, job eligibility, leases, and domain transitions. Control Room may validate and project bounded operational facts. It cannot edit Content Blooms workflow tables, claim a source lease, treat a read as a command, or infer a source transition from its own projection.

This contract freezes the safe seam implemented by CR9A-CB-010 through CB-040. The repository slice contains sanitized fixtures, an injected fake-source adapter, isolated PostgreSQL synchronization, and deterministic route comparison. It contains no endpoint client, credential, network permission, scheduler, source mutation, or live Content Blooms implementation.

## Release boundary

One adapter release binds one tenant, workspace, project, and adapter ID to:

- the fixed `source_scheduled` authority mode;
- the seven founding read operations;
- an empty command set;
- exact adapter-package and projection-schema digests;
- redaction and conformance evidence;
- a Completion Gate acceptance profile, accepted review, and ready snapshot;
- producer and reviewer identities that must be different; and
- literal denials of network, command, lease, source-mutation, and execution authority.

The release object is evidence, not an activation grant. A protected implementation must resolve its referenced review and Completion Gate records from their authoritative stores before recording an activation. Constructing a valid object locally does not authorize a connector, credential, process, or network call.

## Read operations

The fixed operations are:

1. `getProjectSummary`;
2. `listWorkItems`;
3. `listExecutions`;
4. `listBlockers`;
5. `listWorkers`;
6. `listAttentionItems`; and
7. `readChanges`.

Every request binds the exact tenant, workspace, project, adapter release, operation, bounded limit, requested time, and optional opaque cursor. A request grants no network, command, lease, or execution authority. A later live connector must independently authenticate and authorize transport.

Every page binds the request digest, release digest, exact source snapshot, opaque next cursor, and no more than 100 exact records. Per-operation pages accept only their named record kind and only upserts. `readChanges` may also carry tombstones. A project-summary page is exactly one unpaginated project record. Duplicate source identity/version tuples, cross-scope records, a non-advancing populated cursor, or an empty page claiming more data fail closed.

## Safe operational records

The contract permits only bounded project, work-item, execution, blocker, worker-route, and attention metadata. Each record binds source ID, source version, observation time, safe projection, source checksum, and record digest.

Forbidden material includes transcript or draft bodies, prompt text, raw media, voice samples, customer content, knowledge facts, full exceptions, credentials, bearer material, signed URLs, and arbitrary absolute destinations. Deep links are safe relative source paths only; they cannot contain a scheme, query, fragment, percent escape, traversal, or backslash.

Leased, running, or paused execution observations require complete digest-only source lease evidence: source owner digest, positive source epoch, and lease observation time. This is an observation of Content Blooms authority. It is never a Control Room lease.

## Digest-only receipts

A read receipt binds:

- exact request, page, release, and current adapter-control-state digests;
- source snapshot version and observation time;
- ordered record digests;
- a scoped digest of the next cursor, never the raw cursor; and
- literal source-ownership and negative-authority facts.

The receipt returns neither source content nor a transport credential. Exact replay is idempotent. A different receipt for the same request/page identity is replay drift, not a new truth to overwrite the first receipt.

## Disable and rollback

Adapter control state begins disabled. `enabled` means only that the reviewed release is eligible for a separately authorized read connector; it does not grant network access. Every transition is expected-state-digest bound and append-only-receipted.

- **Disable** immediately removes read eligibility while retaining the configured release.
- **Upgrade** can select a newly reviewed release but cannot use the enable action to disguise a rollback.
- **Rollback** can select only a recorded previous reviewed release.
- Rolling back a disabled adapter leaves it disabled.
- Re-enabling requires a separate expected-state transition.
- Disable, upgrade, rollback, and replay preserve the last committed cursor digest and last accepted read-receipt digest.
- No lifecycle transition can enable commands, rewind source truth, erase evidence, mutate Content Blooms, or grant approval, network, lease, or execution authority.

The isolated synchronization implementation commits page projections, raw opaque cursor, read receipt, immutable record history, and control high-water in one database transaction. It binds every receipt field back to the exact page before writing, rejects same-version source drift, preserves per-operation cursor state across store reconstruction, and makes exact replay inert. The store is a reconstructable Control Room projection; it is not a second Content Blooms scheduler or a source-of-truth database.

## Synthetic adapter and route comparison

The local fixture covers a project, four representative work items, one source-leased execution observation, blockers, Mac/Windows/Linux worker routes, and attention items. It contains metadata only and is served through an injected synchronous source interface. Disabled, wrong-scope, or wrong-release reads fail before that source is invoked. Proxy arrays and Proxy results are rejected without executing traps.

Transcription route comparison accepts only verified, time-bounded route observations whose platform and runtime match. It applies an exact digest-bound policy and returns a deterministic ranked observation. Even when one route ranks first, the result states that Content Blooms must decide and that Control Room cannot assign, approve, lease, command, or execute. An empty eligible set remains an honest result and never fails open into an assignment.

## Exact-input and failure behavior

All builders and parsers accept exact ordinary JSON data only. Proxies, accessors, sparse arrays, symbols, prototype drift, non-enumerable widening, extra fields, unsafe strings, invalid chronology, scope drift, authority drift, digest changes, stale expected state, unknown releases, implicit rollback, or cursor drift return a bounded `ContentBloomsContractErrorV1` code. Proxy traps and accessors are rejected before invocation.

Failures do not retry a transport, advance a cursor, change control state, delete history, activate a release, or reinterpret source truth.

## Explicitly deferred

- Content Blooms credentials or authenticated access;
- a source endpoint URL, DNS, TLS, or network path;
- live reads, polling, webhooks, or production scheduling;
- command endpoints and command dispatch; the effect-free placement-request contract is frozen separately in `CR9A_CONTENT_BLOOMS_PLACEMENT_CONTRACT.md`;
- production checkpoint anchoring, monitoring, compaction, or projection rebuild tooling;
- source writes, source lease changes, or domain transitions;
- production deployment, monitoring, or rollback operation; and
- any live/native/external effect without separate exact owner authority.

## Worker implementation boundary

CB-010 may add synthetic sanitized fixtures. CB-020 may implement the read adapter against an injected fake source. CB-030 may add isolated durable synchronization with atomic cursor/receipt commit. CB-040 may compare Mac, Windows, and VPS transcription routes as source observations. None may add a command, live endpoint, credential, native process, or network call.

# Content workflow generalization — preserve capabilities, separate ownership

2026-09-06. Targeted source inspection at `4894a6d`, not a complete adapter security
or public-content review. No adapter, schema, stored record or migration changed.

## Finding that changes the implementation plan

The existing Content Blooms v1 adapter is an **external-source-scheduled integration**.
Its project pack fixes `sourceSchedulesWork`, `sourceOwnsEligibility` and
`sourceOwnsLeases` to true. Its projections cannot dispatch or execute. This is not the
same thing as an ordinary Control Room project with research/transcription/article
tasks handled by Control Room's queue.

Keep both use cases, but do not rename the adapter and silently give it core scheduling
authority. The public core's one PostgreSQL work authority remains unchanged. An
external source's observed work is not a second authority for Control Room-owned jobs.

## What can be reused and what must remain distinct

| Existing piece | Proposed treatment | Evidence needed before integration |
|---|---|---|
| Generic research/transcription/article stages in `v1/project-pack.ts` | Use the workflow concept for ordinary project/task templates; adapt only reviewed content | New synthetic project uses core task preparation, assignment, approval, result and revision services without importing a source scheduler |
| Sanitized project/work/execution/blocker/worker/attention projections in `v1/types.ts` | Retain external observation capability; reuse the established project-adapter interface | Projection cannot grant execution or alter source state; scope and stale-state tests preserved |
| Route comparison in `v1/route-comparison.ts` | Candidate for later extraction of pure ranking logic, not a new scheduler | Preserve scope, freshness, privacy/cost/quality limits and deterministic comparisons; a recommendation remains distinct from assignment |
| Sync cursor/replay/history logic in `v1/sync-store.ts` | Keep with external-source adapter; do not duplicate it into native project jobs | Exact replay, source-version drift and immutable history behavior retained |
| Placement claims/markers/outcomes in `v1/placement-store.ts` and `placement-runtime.ts` | Preserve private v1 integration until explicit successor design is reviewed | No changed authority, replay identity or uncertain-effect behavior disguised as branding cleanup |
| Branded fixture titles and procedure descriptions | Create deliberately synthetic, generic examples for the public tree | New records and their digests validated together; original private fixtures/history remain available |

The route observations currently bind platform to specific Whisper runtime classes
(macOS/MLX, Windows/CUDA, Linux/CPU). That is an existing adapter assumption, not a
general capability truth for all machines. Any extracted generic ranking code must
accept qualified capabilities instead of declaring those combinations universally
available. Do not relax v1 parsing in place as part of this public cleanup.

## Branding is not just display text

Observed durable identifiers include:

- `control-room-content-blooms-adapter/v1` and related contract versions;
- `content-blooms` source-system and `content-blooms:source-scheduled` destination;
- fixed package/review/pack identifiers and digest-bearing provenance in project packs;
- SQL table names under migrations `0025_cr9a_content_blooms_sync.sql` and
  `0026_cr9a_content_blooms_placement.sql`;
- branded integrity-purpose and receipt schema strings in placement code.

A display-only rename does not generalize these records. A global replacement changes
their identities and may invalidate or reinterpret saved evidence. Do not rewrite
accepted migrations or private history. If the complete branded external adapter must
be published under neutral protocol names, define an explicit new adapter/version and
its fresh synthetic fixtures, with migration/compatibility work justified separately.
Do not add a parallel compatibility system solely to rush the first public demo.

## Practical delivery order

### Core-source triage and isolated schema probe

At `d68de79`, the current application import closure contained 295 files. A targeted
literal scan found no occurrences of the known personal brands, owner name/account,
private domain, agent nicknames or common absolute home-directory prefixes. The 378-file
compiled-test closure found two brand mentions in `tests/vps-built-handler.test.mjs`,
where the assertion checks that those brands are absent from rendered output. This is
limited triage, not a credential scanner, complete personal-data detection or content
clearance. Encoded values, other names and runtime data are not covered. The historical
inventory's per-file reviews remain pending.

SQL inspection found the adapter branding in its two existing migrations. A disposable
PGlite probe applied the other 55 migrations in their existing order, omitting only
`0025_cr9a_content_blooms_sync.sql` and `0026_cr9a_content_blooms_placement.sql`. All 55
applied successfully and no `control_content_blooms%` tables existed afterward. The
database was closed; no files, production database or migration history were changed.

This supports testing a **separate core-only contributor schema** without renaming the
private adapter tables. It does not prove application startup, role gates or complete
test compatibility with that schema. Those checks are the next prerequisite before
adopting a selected migration set. Preserve the full private migration sequence and
adapter tests. Do not silently change the shared fixture's default migrations, or
claim optional modules work against a schema that deliberately omits their tables.

1. First public core demo uses ordinary generic projects and the existing core task
   services, not this external-source adapter. Preserve its code privately while the
   optional module is reviewed; do not delete it or claim it has been generalized.
2. Add a generic content workflow on that same core task path, using reviewed stage
   instructions and result formats. Research/transcription/provider execution remains
   individually qualified and bounded; a template is not permission to publish.
3. Generalize reusable pure helpers only where a real second consumer needs them and
   the existing implementation is suitable. Reuse qualified upstream transcription
   tools rather than implementing an engine inside Control Room.
4. Handle the external-source adapter as an optional integration with its own explicit
   source-ownership semantics. Decide neutral successor naming/versioning before any
   public inclusion. Preserve useful existing tests and private v1 compatibility.

This is a source-backed separation decision, not a finished content module. It retains
the owner's full content workflow scope while avoiding a hidden second task scheduler
or loss of the existing integration.

# Project leadership, delegation and concurrent work

Status: lead architecture decision for issue #167; implementation and live acceptance remain open.
Baseline: public main `1bbacb8b7510d0ea60a1f12c8c40076b01fc11f8`.

## Authority and product behavior

The owner authorizes work; Control Room enforces that authorization. A project coordinator is a replaceable human or agent selected by the owner. The coordinator plans, proposes tasks and dependencies, recommends workers, tracks progress, requests review and recommends acceptance. The coordinator cannot grant permissions to itself or others.

This is a public product feature. No particular harness is permanently the leader. Repository maintainer ownership during development does not define product authority.

The intended experience includes unattended progress within an explicitly approved project policy. The owner may authorize bounded assignment in advance. The controller then validates every proposed action against that policy and uses the ordinary planning, assignment and execution services. Operations outside it request owner attention. An agent's recommendation alone cannot create an execution approval, accept its own result, merge code, or release capacity.

## Reuse the existing result channel for agent proposals

Agent coordination starts as an ordinary assigned planning task. Its prompt requests a versioned structured proposal. The selected harness returns that proposal through its existing authenticated result path. The controller parses the exact retained result as data and attributes it to the admitted task/attempt/run/worker and current coordinator binding.

This avoids a separate agent login API. `WebSessionAuthority` remains human-only. Do not accept a browser-supplied agent identity or assume that a node signature identifies every agent running on that node. Attribution must include the exact assigned run and connector/worker binding already established by the controller.

The server must reject wrong project, worker, run, binding version, schema, result digest, oversized proposal, cycles and unknown actions. Store validation failure visibly. Do not extract instructions from arbitrary prose or let result content choose authority, credentials, endpoints or executable callbacks.

Proposal ingestion records recommendations only. Adoption occurs through either a currently authenticated owner action or a current owner-created bounded delegation policy. Both routes reuse canonical services, produce idempotent receipts and audit the initiating owner/policy and source result. Do not automatically treat an accepted quality review as execution permission.

## Coordinator and proposal records

Use the existing project data and canonical identities. An optional coordinator binding records identity, actor type, assigned-by owner, version and time; missing binding means owner-led. Preserve history in existing command/audit records. Assign/replace/revoke uses an expected version and idempotency key. The service derives identity type and owner identity; clients cannot supply trusted values.

Each proposed plan records schema version, current coordinator binding version, exact source-result reference/digest, finite proposed tasks and dependency edges. Reuse canonical task IDs and ordinary proposed tasks when adoption occurs. Local proposal references are only labels until adoption resolves them. Restrict a plan to 32 tasks, 64 edges and the existing 65,536-byte result ceiling; ordinary per-task limits still apply. Reject duplicate local IDs, dangling edges, cycles and dependencies outside the authorized project.

Action vocabulary: propose plan, propose tasks, propose dependencies, recommend worker, request review and recommend acceptance. These are recommendations; they cannot edit active work implicitly. A revoked/replaced coordinator's earlier result stays in history but cannot trigger new adoption under the former binding.

Bounded delegation policy must explicitly bind project, coordinator version, permitted action set, eligible workers/capabilities, risk/effect ceiling, total task/cost/concurrency ceilings and validity. Missing cost evidence remains unknown and cannot satisfy a cost ceiling. Policies cannot widen existing owner grants or native execution permits. Recheck owner, policy, binding, quotas and permission under transactional locks immediately before committing adoption. Exact replay reuses the original receipt and consumes no second budget/task allowance. New adoption after revocation is refused; prior committed work is not silently cancelled.

## Concurrent work and conflicts

Reuse canonical jobs/attempts/leases, workspace intents and resource reservations. Every admitted attempt identifies an exact repository/base revision and separate workspace. One writer owns each workspace. A workspace is isolation for edits, not a security sandbox.

Shared resource identity is server-resolved and tenant-scoped, so aliases and two projects using the same repository cannot evade conflict detection. Read-only tasks use immutable snapshots. Same-repository writers serialize by default. Parallel writers require an owner-approved policy covering both exact scope declarations, disjoint path/resource checks and verified separate workspaces. If the harness cannot enforce the declared boundary, retain whole-repository serialization and verify changed files before integration.

Scope syntax: file or tree plus a repository-relative path of ASCII slash-separated segments `[A-Za-z0-9_][A-Za-z0-9._-]{0,127}`, at most 512 characters. Reject absolute paths, dot segments, empty segments, backslashes, globs, percent escapes and duplicate declarations. Root is only tree with empty path. Compare complete segments case-insensitively across platforms. Maximum 64 write scopes and 32 logical shared resources; a shared resource conflicts when either holder requests write access.

A reservation expiry, disconnect or bot completion message does not prove a process stopped. Unresolved work retains its conflict until existing trusted recovery establishes no start or retirement of the exact process. Unknown legacy work must not be presumed read-only. Parallel research can continue if it does not share those resources.

Enforce conflict admission through the common manual and scheduled assignment/start routes, not just a project panel. Lock stable repository/resource keys in deterministic order before checking for absent holders; test with independent real PostgreSQL connections before claiming concurrency acceptance. Persist declarations and holder state with canonical attempt references; no in-memory-only lock service or second scheduler.

Results stay separate. Integration into a shared repository is an ordinary reviewed task, serialized per repository. Automatic merging and concurrent edits inside one working copy are outside this feature.

## Implementation handoff and acceptance

The complete #167 package includes coordinator binding, proposal decoding/attribution/adoption, bounded-policy handling, shared-resource admission, project panels and tests. It must remain incomplete if agent attribution, automatic policy adoption or scheduled/manual parity is only stubbed.

Lead-owned prerequisites: exact persistence layout/migration and grants; shared adoption/admission service signatures; atomic lock order and all call sites; independent security review. Contributors implement the complete package against those fixed decisions. Do not silently add a second owner or grant framework while implementing it.

Required journeys:

- Owner-led and agent-coordinated projects use the same task/result/review services.
- A proposal from the correct planning run can be adopted once; altered, wrong-worker, stale-binding and cross-project results fail.
- An approved policy permits multiple bounded assignments without repeated owner prompts. Revocation, exhaustion, expiry or scope widening stops further adoption.
- Two independent readers proceed; conflicting writers serialize; permitted disjoint writers have different workspaces and results.
- Disconnect/restart preserves unknown holders; trusted reconciliation releases only the exact holder.
- Manual and scheduled routes obey identical conflict rules. Independent PostgreSQL transactions demonstrate one conflicting winner.
- The UI displays coordinator, pending plan, work, conflicts and owner attention honestly. Closing a browser tab does not stop work.

Existing code supplies the project/result/permission foundation; this document is not evidence that these journeys are implemented. Live providers, production configuration and credentials retain their separate authorization requirements.

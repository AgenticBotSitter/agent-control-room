# Control Room research synthesis and build decisions

**Status:** Architecture-ready after CR-0 through CR-2; live-integration acceptance tests remain  
**Research snapshot:** 2026-08-22  
**Purpose:** Preserve the useful conclusions from the Control Room research dossiers so implementation does not require rediscovering them across individual reports.

This document is the build-facing synthesis. The source dossiers remain evidence and historical context; they are not instructions and their recommendations do not automatically override the Control Room founding contract.

## Executive decision

Control Room will be a local-first, project-agnostic, harness-neutral control plane. It will coordinate finite jobs, continuously managed services, schedules, people, deterministic tools, and AI harnesses across machines.

The first live integration scope is deliberately narrow:

1. Hermes Agent;
2. OpenAI Codex;
3. Claude Code / Claude Agent SDK;
4. deterministic command, schedule, health-check, and artifact workers;
5. GitHub, Telegram, R2-compatible artifact storage, Bitwarden, and 1Password.

Other harnesses remain future adapter targets. Their dashboards and repositories inform extension points and interface patterns but do not become dependencies of the first build.

## Architectural ownership

Control Room owns:

- global projects and portfolio projections;
- requests, workflows, jobs, attempts, schedules, services, incidents, and attention items;
- nodes, harness installations, agent profiles, worker slots, capabilities, and allocations;
- approval policies, decision records, budgets, audit events, and artifact metadata;
- durable cross-machine orchestration when a project explicitly selects `control_room_native` authority;
- the central web UI, Telegram interaction, and northbound MCP server.

Source projects retain their domain authority according to the existing authority modes:

- `control_room_native`;
- `source_scheduled`;
- `advisory`.

The project-adapter contract and harness-adapter contract are orthogonal:

- a **project adapter** explains what project work and domain state mean;
- a **harness adapter** explains how a runtime starts, streams, steers, pauses, resumes, cancels, and reports work.

Hermes Kanban is a valuable Hermes-local execution substrate. It is not the global cross-machine Control Room database or universal bus. Control Room may import, observe, or request operations against Hermes Kanban through an adapter without mirroring SQLite tables through R2 or making Hermes the global source of truth.

## Universal identity model

These identities must remain distinct:

- **human actor:** a person who requests, reviews, approves, or administers;
- **node:** a physical machine, VM, or VPS;
- **harness installation:** Hermes, Codex, Claude Code, or another runtime installed on a node;
- **agent profile:** a configured identity/profile inside a harness;
- **worker slot:** a schedulable execution slot with current capabilities and capacity;
- **service account:** a nonhuman identity used to access Control Room or an external provider;
- **credential reference:** a logical reference to authority stored in a secret provider.

A password-manager token is not an agent identity. It is one credential held by a separately enrolled node, harness, or service account. Editable names never replace immutable IDs.

## Universal job eligibility

A worker is eligible only when all of the following hold:

```text
hardware and software capabilities satisfy the job
AND a compatible skill version is installed or safely installable
AND required credential references are resolvable
AND project and environment policies authorize the assignment
AND node-local policy authorizes the action
AND current capacity and storage thresholds permit it
AND required approvals are present and unexpired
```

The UI must retain ineligible workers and explain the reason and remedy rather than hiding them.

## Reuse decisions

| Component or pattern | Decision | Build use |
|---|---|---|
| Existing CR-0 through CR-2 contracts, projections, PostgreSQL schema, simulator, and UI | **Adopt** | Foundation; extend without replacing established authority and redaction rules. |
| Hermes dashboard | **Wrap** | Native Hermes administration console; normalized status in Control Room plus protected deep links. |
| Hermes dashboard plugin SDK | **Adopt for thin plugin** | Add Control Room assignment, authority, artifact, and project context inside Hermes. Keep central device credentials out of browser JavaScript. |
| Hermes `tui_gateway` JSON-RPC and serve REST | **Adopt behind a pinned adapter** | Use spawned stdio JSON-RPC for execution and the authenticated read-only serve routes for management projections. Re-run schema fixtures on every supported Hermes upgrade. |
| Hermes Kanban | **Wrap as local/source substrate** | Import and operate Hermes-local boards where useful; never use SQLite/R2 mirroring as the global bus. |
| Hermes peer messaging | **Defer to optional conversational transport** | Useful for native Hermes conversation, not authoritative job transport. |
| Codex TypeScript SDK | **Primary adopt candidate** | Structured events, thread resume, cancellation, working-directory controls, and job execution. Pin versions. |
| `codex exec --json` | **Fallback wrapper** | Simple and robust fallback; close stdin, parse JSONL, store thread ID, and never use danger-full-access unattended. |
| Codex app-server | **Evaluate / defer** | Rich JSON-RPC interface, but experimental and version-sensitive. Use after protocol and lifecycle spike. |
| Codex MCP server | **Do not use as internal queue** | May expose Codex as tools, but MCP is not the heartbeat, lease, or durable job transport. |
| Control Room MCP server | **Build** | Let Codex, Claude Code, Hermes, and other clients create requests, delegate, inspect, approve, and retrieve results. |
| `claude -p --output-format stream-json --verbose` | **Primary Claude seam for v1** | A pinned subprocess protocol minimizes integration surface. Authenticated lifecycle acceptance remains required before enabling the adapter. |
| Claude Agent SDK | **Secondary/deferred seam** | Reconsider when Control Room needs SDK-only callbacks or hooks. The open bindings still drive the separately licensed Claude Code runtime. |
| OpenClaw Control UI patterns | **Borrow** | Live run digest, attention rail, read-only run companion, explicit ineligibility reasons, pairing, and recoverable placement. |
| Other harness dashboards | **Defer** | Future native-console adapters; no proxy-every-dashboard architecture. |
| Control Room-native state machine | **Adopt for v1** | Central API owns leases, attempts, approvals, events, and idempotency. Use PostgreSQL in deployment and the existing compatible local test path; remote workers never open the database. |
| Hatchet | **Defer behind workflow contracts** | Reconsider when scheduling density, operational UI, or horizontal control-plane scale exceeds the native implementation. |
| DBOS | **Named migration candidate** | Reconsider if durable-function semantics become preferable without adopting a separate queue server. |
| Temporal | **Defer** | Strong durability model, disproportionate initial operations burden. |
| Uptime Kuma | **Wrap after deployment acceptance** | External service and dead-man monitoring feeding Control Room incidents; do not make it Control Room's source of truth. It is optional for the core architecture. |
| Beszel | **Defer-light** | Optional machine metrics after the node bridge's native telemetry proves insufficient. |
| Bitwarden and 1Password | **Initial secret providers** | Implement behind one secret-provider interface with node-, harness-, and destination-native resolution modes. |
| OPA/Cedar/OpenFGA/SPIRE | **Borrow patterns / defer services** | Current scale does not justify their operational burden; preserve replaceable policy and identity interfaces. |
| Seatbelt, Docker, gVisor, hosted sandboxes | **Policy-dependent executors** | Select per OS and risk class only after platform tests. No single isolator is universal. |
| OpenTelemetry conventions | **Borrow and design for** | Normalize traces, metrics, correlation IDs, and export without requiring a full observability stack initially. |

## First harness integrations

### Hermes

Control Room should use a layered Hermes adapter:

1. **Discovery and read path:** profiles, skills, sessions, cron, gateway, version, analytics, and host status through documented local APIs.
2. **Execution path:** Hermes API server or serve protocol through the local node bridge after schemas and authentication are captured in a versioned fixture.
3. **Native console:** protected links into the machine-level Hermes dashboard with the correct `?profile=` selection.
4. **Reciprocal UI:** optional thin Hermes dashboard plugin showing Control Room job and authority context.
5. **Local board path:** map Hermes Kanban tasks and events into sanitized Control Room projections when a project chooses to use it.

Do not expose Hermes ports publicly. The node bridge communicates outbound to Control Room. Native-console access remains localhost, tailnet/private network, Cloudflare Access, or a future short-lived authenticated tunnel.

### Codex

The preferred order is:

1. TypeScript SDK as the normal worker integration;
2. `codex exec --json` as a tested fallback;
3. app-server only after experimental-protocol validation.

The adapter must capture:

- thread ID and source revision;
- structured events and tool/file activity;
- usage;
- approval or policy failures;
- cancellation state;
- resumability;
- final response and structured result;
- isolated worktree and returned commit/patch.

Codex must also be able to use the central Control Room MCP server from an ordinary project task. That northbound connection is distinct from Control Room invoking Codex as a worker.

Never place raw OAuth state or unrelated environment secrets into job records. Public distribution must require users to supply and license their own Codex installation/account rather than redistributing credentials.

### Claude Code

The preferred v1 order is:

1. pinned CLI `stream-json` wrapper as the primary seam;
2. Python or TypeScript Agent SDK only when an SDK-only lifecycle feature is required.

The unauthenticated live spike captured initialization, session, error, usage, permission-denial, and subagent-stat shapes. Resume, cancellation, hooks, worktree behavior, and successful usage remain adapter acceptance tests requiring an authenticated Claude installation. They do not require another architecture research round.

If an SDK seam is later enabled, its hooks and `canUseTool` decisions map to Control Room policy and approvals. A hook can provide telemetry or deny an operation, but it may not grant authority beyond the job envelope or node-local policy.

The build must not redistribute proprietary Claude Code components. Open SDK repositories/packages require a component-level license decision rather than assuming the license of the Claude Code application.

### Deterministic workers

Agents are not the only workers. The initial node bridge must support scoped deterministic jobs such as:

- Git operations and tests;
- FFmpeg and media validation;
- health checks and HTTP probes;
- artifact checksum/upload/download;
- deployment commands;
- scheduled scripts;
- Unreal command-line rendering when the project pack is ready.

Deterministic checks should verify agent claims whenever possible.

## Durable work and continuous services

Control Room needs both models:

- **finite workflow:** request -> jobs -> attempts -> artifacts -> decision -> completion;
- **continuous service:** desired state -> observation -> drift/incident -> reconciliation.

Schedules create attempts without flooding the main board. Existing cron jobs begin as `observed` or `externally_managed`; migration to `control_room_managed` happens explicitly.

Reusable service blueprints should instantiate health checks, certificate checks, backups, traffic reports, deployment verification, and escalation rules for a new website or service.

For v1, select a **Control Room-native centralized state machine** behind a workflow repository/service contract:

- the Control Room server is the sole database authority;
- deployed state uses PostgreSQL; local development and deterministic tests may use the existing compatible embedded path;
- node bridges claim, renew, complete, and reconcile work through authenticated APIs, never by opening or copying the database;
- leases, attempt history, approval waits, cancellation, idempotency keys, effect intents, and reconciliation are first-class records;
- R2 stores large artifacts and backups, not leases or authoritative workflow state.

The SQLite proof validated the state-machine mechanics and exposed the lease-recovery and claim-before-effect hazards, but its tested code is evidence rather than production code. PostgreSQL crash/recovery and multi-node contention tests are implementation acceptance criteria. Hatchet and DBOS remain replaceable future substrates behind the same contracts.

## Secret-provider design

Control Room stores logical references and safe metadata, never ordinary secret values:

```yaml
credential_ref: websites.cloudflare.production-deployer
provider: bitwarden-or-1password
allowed_project: agentic-bot-sitter
allowed_environment: production
allowed_operation: deploy
requires_human_approval: true
```

Supported resolution modes:

1. **node-brokered:** node bridge resolves just in time and injects into a tightly scoped process/tool;
2. **harness-brokered:** Hermes or another harness resolves the logical reference using its native integration;
3. **destination-native:** GitHub Actions, Cloudflare, or another service uses a credential already stored at the destination.

Prefer short-lived scoped credentials. Otherwise provision a separate scoped credential or route the sensitive step to a node that already resolves it. Never transfer a long-lived key from one agent prompt to another.

The initial provider interface must support both Bitwarden and 1Password even if implementation is sequential. Central Control Room code passes only a `credential_ref`. Secret retrieval and process injection occur in the authorized node-local broker or destination; the ordinary central API must not expose a `get_secret() -> plaintext` operation. Provider setup, rotation, audit availability, redaction, and failure behavior remain live acceptance tests once the owner creates the corresponding accounts and scopes.

## Policy and security boundaries

Three layers must remain distinct:

- **preferences:** notification channels, quiet hours, views, digests, worker preferences;
- **policies:** production approvals, budgets, credential scopes, worker eligibility, installation trust, retention;
- **invariants:** secrets never enter prompts/logs, jobs cannot expand authority, child authority cannot exceed parent authority, approvals are operation-specific and expiring, audit attribution is mandatory, and duplicate delivery cannot silently duplicate consequential work.

The central policy evaluator and the node-local guard both enforce authority. A shell wrapper is useful plumbing but is not a sufficient security boundary because agents and subagents may bypass it.

A signature made by an online Control Room key proves message origin; it does **not** protect a node after that same Control Room server and signing key are compromised. Containment under central compromise therefore depends on node-local scope ceilings, action allowlists, spend and publication limits, expiry/nonces, and approval rules that the online server cannot relax. Consequential approvals must be bound to the exact operation digest and confirmed through a separately protected owner authority. The architecture package must specify which approval keys or channels are outside the ordinary online control-plane trust domain.

Prompt, repository, webpage, issue, email, and artifact content are untrusted data. None may grant permissions or alter the authority envelope.

## Worker and native-console user experience

Every worker page has universal tabs for status, current work, queue, history, capabilities, skills, credential resolvability, resources, performance, incidents, and recommendations.

Harness adapters may add declarative, safely rendered panels and protected native-console links. Initial central plugins may not inject arbitrary third-party JavaScript.

Hermes exposes a machine-level console with profile deep links. Codex and Claude initially use native Control Room coding-worker screens showing repository, worktree, branch, events, changed files, tests, usage, approvals, and review state.

Borrowed OpenClaw UX patterns:

- structured live digest with optional utility-model phrasing;
- attention rail that expands for input or failure;
- bounded read-only companion for asking about a run without interrupting it;
- unavailable workers remain visible with an explanation and next step;
- parent/child lineage and queued versus running state;
- scoped device enrollment and explicit permission upgrades.

## Monitoring and incidents

Control Room should ingest existing signals instead of replacing every specialist:

- Hermes status and resource telemetry;
- node-bridge heartbeats and capacity;
- systemd, launchd, and Windows Service state;
- existing cron outcomes;
- Uptime Kuma service checks and push/dead-man heartbeats if adopted;
- GitHub workflow/deployment events;
- project-specific checks.

Deterministic monitoring opens an incident. An agent diagnoses only after evidence collection and retry rules. Recovery actions remain policy-scoped and may require approval.

## Packaging and extension rules

The eventual public architecture should separate:

- public Control Room core;
- public versioned adapter SDK and conformance kit;
- optional reference adapters;
- private deployment configuration, secrets, workers, projects, and history.

Prefer supported SDKs and protocols over copied source. When source is reused, record repository, path, commit, license, NOTICE obligations, modifications, and upgrade owner. Maintain an SBOM and automated license scan before public release.

No public release decision follows solely from repo-level license labels. Package-level and per-directory licenses may differ.

## Research conclusions explicitly rejected or narrowed

The following dossier conclusions are not build decisions:

1. **Hermes Kanban as the cross-machine global bus:** rejected. It remains a Hermes-local/source scheduler behind the adapter boundary.
2. **R2 mirroring of SQLite task events and claims:** rejected for authoritative coordination. R2 remains artifact/backup storage, not a transactional lease bus.
3. **Bitwarden machine account as the agent identity:** rejected. Credential possession and actor/node identity remain separate.
4. **Fifty-line policy wrapper as primary enforcement:** rejected. Use deterministic central and node-local policy; wrappers are defense-in-depth only.
5. **Proxy every harness dashboard:** rejected. Use normalized adapters and optional protected native-console federation.
6. **Hatchet already selected:** rejected for v1. The follow-up proof supports a small native state machine at current scale; Hatchet remains a future migration candidate rather than a present dependency.
7. **Seatbelt/gVisor selected for every corresponding host:** narrowed to risk-class candidates pending platform tests, especially Windows coverage.
8. **All internally usable licenses are acceptable:** rejected as the release standard. The intended public project requires distribution/SaaS-aware review now.

## Follow-up gate disposition

The eight follow-up dossiers are sufficient to begin architecture. “Sufficient for architecture” does not mean “certified for unattended production.” Deferred tests are carried into the relevant implementation phase rather than blocking the design package.

| Gate | Architecture status | Acceptance work carried forward |
|---|---|---|
| Claude lifecycle and licensing | **Sufficient with correction** | Run one authenticated successful turn and verify resume, cancel, permission behavior, subagents, usage, and worktree output before enabling the Claude adapter. |
| Hermes lifecycle and schema | **Sufficient with pinned seam** | Run one provider-keyed disposable turn; preserve versioned protocol fixtures and repeat them on supported Hermes upgrades. |
| Durable workflow substrate | **Decision made for v1** | Implement the native centralized state machine; test PostgreSQL crash recovery, leases, approval waits, idempotent effects, and concurrent remote claims. |
| Windows node | **Sufficient for cross-platform design** | Run service, process-tree cancellation, GPU, sleep/reboot, filesystem, and secret-injection checks during Windows node onboarding. |
| Bitwarden and 1Password | **Interface direction sufficient** | Test each provider only after the owner provisions it; never make plaintext retrieval a central API. |
| Identity and threat model | **Sufficient after central-compromise correction** | Prove enrollment, revocation, forged-job rejection, node-local ceilings, and separately protected consequential approval. |
| Uptime Kuma monitoring | **Non-blocking optional integration** | Execute the VPS runbook before promoting Kuma from optional adapter to supported deployment component. |
| License and SBOM | **Sufficient for architecture** | Verify remaining package-file licenses before import or redistribution and automate SBOM/license checks as dependencies are selected. |

Codex already has enough tested CLI evidence for architectural mapping. The SDK/app-server comparison becomes adapter implementation work, not a reason to delay the system architecture.

## Research conclusion and next stage

The broad research phase is complete. Do not request another landscape survey. Additional research should be triggered only by a concrete architecture decision, failed acceptance test, dependency import, security review, or adapter upgrade.

The next stage is **CR-3 — Consolidated Architecture and Build Plan**. It is a design phase with no production credentials, live project mutations, or unattended workers. CR-3 must produce:

1. system context, trust boundaries, and Mac/Windows/Linux/VPS deployment topology;
2. canonical domain model and state machines for requests, workflows, jobs, attempts, approvals, services, incidents, artifacts, and schedules;
3. versioned API, event, node-heartbeat, lease, and artifact contracts;
4. node bridge, capability discovery, benchmark, resource telemetry, and worker-enrollment design;
5. project-adapter, harness-adapter, secret-provider, monitor, notification, and artifact-store SDK boundaries;
6. scheduling, cross-project allocation, bottleneck detection, priority, fairness, budget, and recommendation rules;
7. owner authentication, node identity, credential references, policy evaluation, approvals, audit, quarantine, and recovery design;
8. responsive dashboard, worker detail, project selector, attention inbox, review surface, native-console links, and Telegram interaction design;
9. deployment, migration, backup, upgrade, observability, testing, conformance, licensing, and public-packaging plan;
10. phased implementation backlog with acceptance criteria, beginning with one synthetic cross-machine vertical slice and ending before live project integrations unless separately approved.

CR-3 ends with an owner-reviewable architecture decision package. Implementation begins only after that package is accepted.

## Source dossier index

The source research is stored outside this repository in `Control Room Research/`:

- `control-room_research_codex-integration-deep-dive.md`
- `control-room_research_claude-code-agent-sdk-deep-dive.md`
- `control-room_research_hermes-adapter-source-audit.md`
- `control-room_research_durable-workflow-engines.md`
- `control-room_research_node-runners-and-isolation.md`
- `control-room_research_secrets-identity-policy.md`
- `control-room_research_monitoring-observability-reuse.md`
- `control-room_research_license-reuse-matrix.md`
- `control-room_research_orchestration-landscape-2026-08-22.md`
- `control-room_research_agent-harnesses-landscape-2026-08-22.md`
- `control-room_research_web-dashboards-across-harnesses-2026-08-22.md`
- `control-room_research_followup_claude-code-live-spike.md`
- `control-room_research_followup_hermes-isolated-spike.md`
- `control-room_research_followup_workflow-engine-proof.md`
- `control-room_research_followup_windows-node.md`
- `control-room_research_followup_secrets-provider-contract.md`
- `control-room_research_followup_identity-threat-model.md`
- `control-room_research_followup_monitoring-proof.md`
- `control-room_research_followup_license-sbom-correction.md`
- `cr-sbom-2026-08-22.json`
- `CONTROL_ROOM_CONTENT_BLOOMS_HANDOFF.md`

When a source dossier and this document disagree, this synthesis governs the Control Room build until superseded by an accepted architecture decision record.

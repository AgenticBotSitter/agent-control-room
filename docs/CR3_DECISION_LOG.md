# CR-3 architecture decision log

**Purpose:** Preserve what was decided, why, what it costs, and what would justify changing it.  
**Status:** Accepted 2026-08-22; later changes require a superseding decision record.

## Decision format

Each record contains context, decision, alternatives, trade-offs, and reevaluation triggers. A future change supersedes a record; it does not erase the original reasoning.

## ADR-001 — Public-code security model

**Decision:** Assume attackers know the complete implementation and protocol. Authenticate and authorize every operation independently of source secrecy.

**Why:** A future public repository must not become a map that grants access. Security by obscurity fails even for private repositories once code, logs, or binaries leak.

**Alternatives rejected:** Keep endpoints/protocols private; rely on hard-to-guess URLs or API shapes.

**Trade-off:** More identity, policy, replay, and conformance work is required from the beginning.

**Reevaluate:** Never reverse the principle; only strengthen controls.

## ADR-002 — Modular monolith before microservices

**Decision:** Deploy one Control Room application with strong internal module boundaries and one database.

**Why:** The initial KVM2 host has limited resources and one operator. Networked microservices add failure modes, credentials, queues, tracing burden, and transactional complexity without current scale benefits.

**Alternatives rejected:** Separate scheduler, API, UI, identity, notification, and adapter services immediately.

**Trade-off:** Internal modules share a failure domain and deployment cadence.

**Reevaluate:** Independent scaling, security isolation, team ownership, or availability requirements become measurable.

## ADR-003 — PostgreSQL is the sole global write authority

**Decision:** Production global state lives in one PostgreSQL primary. PGlite is for local development/tests.

**Why:** Leases, approvals, budgets, idempotency, and cross-project allocation require transactional truth. The repository already uses PostgreSQL-compatible migrations.

**Alternatives rejected:** R2/SQLite synchronization, Git as runtime database, per-node multi-writer stores.

**Trade-off:** The primary is a service dependency and initial availability bottleneck.

**Reevaluate:** Add a dedicated standby/managed database when RTO or criticality demands it; preserve single-primary semantics.

## ADR-004 — Node journals, not global replicas

**Decision:** Nodes persist only their own bounded attempt/replay/checkpoint journal.

**Why:** Journals allow reconnect and recovery without exposing all operational data or implementing distributed consensus on heterogeneous devices.

**Alternatives rejected:** Full database copy on every worker; worker election after server loss.

**Trade-off:** Nodes cannot schedule new work while Control Room is unavailable.

**Reevaluate:** An offline-site operating requirement is explicitly adopted and a consensus/security design is funded.

## ADR-005 — Native centralized workflow state machine for v1

**Decision:** Implement leases, retries, approvals, history, idempotency, and reconciliation in Control Room on PostgreSQL behind a workflow interface.

**Why:** The required state semantics are modest and already align with the core database. It avoids running a second orchestration platform on the KVM2.

**Alternatives rejected/deferred:** Hatchet now; DBOS now; Temporal now; Hermes Kanban as global scheduler.

**Trade-off:** We own correctness tests and a focused amount of workflow code.

**Reevaluate:** Scheduling density, horizontal control-plane scale, or workflow operations UI materially exceed the native implementation.

## ADR-006 — Outbound HTTPS/WebSocket worker connectivity

**Decision:** Node bridges initiate outbound TLS connections to Control Room. No worker listener is required.

**Why:** Works behind NAT, reduces exposed ports, survives different networks, and is less dependent on Proton VPN/Tailscale coexistence.

**Alternatives rejected:** Server dialing workers directly; SSH as the job transport; shared filesystem polling.

**Trade-off:** Long-lived reconnect, backpressure, and durable delivery logic must be implemented.

**Reevaluate:** A constrained environment forbids outbound persistent connections; add a polling transport without changing lifecycle contracts.

## ADR-007 — Cloudflare edge, Tailscale optional

**Decision:** Use Cloudflare Tunnel/Access as the expected protected web ingress. Keep Tailscale as optional native-console and maintenance networking.

**Why:** Tunnel removes public origin ports; Access fits owner authentication; ordinary outbound HTTPS keeps workers portable. Tailscale remains useful but should not stop orchestration if another VPN interferes.

**Alternatives rejected:** Build a Control Room VPN; require every node to join one tailnet; expose origin services directly.

**Trade-off:** Cloudflare becomes an edge dependency and requires careful JWT validation and recovery instructions.

**Reevaluate:** A deployment cannot use Cloudflare; swap the edge adapter while retaining TLS and application identity requirements.

## ADR-008 — Application device identity in addition to edge service auth

**Decision:** Enroll each node with its own asymmetric key and immutable ID. Cloudflare service tokens may be an outer layer only.

**Why:** Shared/symmetric edge credentials do not express node identity, local ceilings, rotation, or per-node revocation adequately.

**Alternatives rejected:** Tailscale IP as identity; password-manager token as identity; one fleet-wide API key.

**Trade-off:** Enrollment, key storage, rotation, revocation, and replay protection must be built.

**Reevaluate:** Replace cryptographic implementation with a mature workload-identity provider only behind the same identity contract.

## ADR-009 — Node-local ceilings and separate consequential approval

**Decision:** Nodes enforce immutable maximum authority locally. High-risk effects require owner approval evidence that the online dispatch key cannot forge.

**Why:** A signature from a compromised Control Room key cannot constrain the compromised server. Local restrictions and a separately protected owner factor contain blast radius.

**Alternatives rejected:** Trust any correctly signed server job; let Telegram alone approve every action.

**Trade-off:** Some actions pause for stronger confirmation; approval key recovery becomes important.

**Reevaluate:** Mechanism may evolve, but the separation stays.

## ADR-010 — Secrets resolve at the node or destination

**Decision:** Central records contain credential references. Authorized node brokers or destination systems resolve/inject values just in time.

**Why:** The scheduler needs to know resolvability, not secret plaintext. This prevents the central database/API from becoming a universal secret exfiltration point.

**Alternatives rejected:** Send credentials in job payloads; transfer secrets between agents; add a central plaintext `getSecret` API.

**Trade-off:** Nodes need provider integrations and jobs may be eligible only on certain nodes.

**Reevaluate:** Add new providers behind the broker contract; do not centralize values.

## ADR-011 — Project and harness adapters are orthogonal

**Decision:** Project adapters model domain/authority; harness adapters model agent lifecycle.

**Why:** Content Blooms can run through multiple harnesses, and Hermes can work for multiple projects. Combining them creates an integration matrix and lock-in.

**Alternatives rejected:** One bespoke adapter for every project-harness pair.

**Trade-off:** Canonical contracts require careful translation.

**Reevaluate:** Never collapse globally; optional composite convenience packages may bundle independent adapters.

## ADR-012 — MCP is northbound, not the internal queue

**Decision:** Expose typed Control Room actions through MCP for Codex/Claude/Hermes clients. Keep internal delivery on the node protocol and PostgreSQL workflow state.

**Why:** MCP is excellent for tool discovery and agent interaction but does not replace leases, heartbeats, durable retries, or node telemetry.

**Alternatives rejected:** Model every worker as a remotely callable MCP server and infer orchestration from tool calls.

**Trade-off:** Two clean interfaces exist instead of one overloaded protocol.

**Reevaluate:** Add MCP transports/features without moving authoritative orchestration into it.

## ADR-013 — Typed executors, no default general shell

**Decision:** Jobs call typed, validated executor operations. General shell execution is absent unless a node owner explicitly enables a scoped executor.

**Why:** A universal remote shell defeats least privilege and makes public protocol knowledge dangerous.

**Alternatives rejected:** Send arbitrary command strings from Control Room.

**Trade-off:** New deterministic operations require adapter work.

**Reevaluate:** Add an opt-in trusted-development executor with strict path/tool/risk constraints, never as the universal default.

## ADR-014 — R2 for artifacts and recovery, not coordination

**Decision:** R2 stores large objects, manifests/anchors, and encrypted backups. It does not hold locks, leases, or authoritative queues.

**Why:** Object storage is durable and inexpensive but lacks the transaction semantics required for orchestration.

**Alternatives rejected:** Poll files in R2 to coordinate agents; synchronize SQLite databases through object storage.

**Trade-off:** PostgreSQL and the node protocol remain necessary.

**Reevaluate:** None for authority; alternate object stores may implement the same artifact interface.

## ADR-015 — Cross-platform native bridge with optional containers

**Decision:** Ship one portable node protocol and platform-specific service packaging. Containers are an executor/deployment option, not a universal requirement.

**Why:** Mac, Windows, Ubuntu, WSL2, GPU workloads, and future nodes have different strengths. A Docker-only worker would exclude or complicate important capabilities.

**Alternatives rejected:** Require Docker everywhere; make Hermes the node bridge.

**Trade-off:** Service supervision, process cancellation, paths, and secret storage require OS-specific implementations/tests.

**Reevaluate:** Add platform packages while keeping the protocol stable.

## ADR-016 — Specialist dashboards remain specialist

**Decision:** Control Room shows normalized worker/project state and protected deep links. Thin plugins may show Control Room context inside a harness.

**Why:** Proxying or reimplementing every dashboard expands attack surface and couples UI to unstable internals.

**Alternatives rejected:** iframe/proxy every harness console; patch Hermes core.

**Trade-off:** Some advanced administration opens a separate protected interface.

**Reevaluate:** Build a dedicated native panel only when repeated owner workflow justifies it.

## ADR-017 — Deterministic policy before AI management

**Decision:** Code evaluates hard eligibility, authority, cost, security, leases, and transitions. An orchestrator agent proposes workflows, explains decisions, triages, and recommends within those limits.

**Why:** Models are useful managers but cannot be the sole enforcement mechanism, especially under prompt injection.

**Alternatives rejected:** Let a manager agent directly issue unrestricted commands or edit policy.

**Trade-off:** More explicit schemas and rule logic; less magical flexibility.

**Reevaluate:** Models may improve but remain untrusted for permission grants.

## ADR-018 — Backup/PITR before distributed worker consensus

**Decision:** Recover with encrypted PostgreSQL backups/WAL and optional later standby; use node journals for reconciliation.

**Why:** This achieves practical recovery with far less complexity and exposure than multi-writer replication across personal devices.

**Alternatives rejected:** All nodes retain global state and vote on recovery.

**Trade-off:** Initial system has recovery-based availability, not seamless failover.

**Reevaluate:** Add a dedicated PostgreSQL standby when measured RTO/criticality justifies it.

## ADR-019 — CR-3 stops before live integrations

**Decision:** Architecture, contracts, migration designs, and build backlog precede credential use, deployment changes, and source mutations.

**Why:** Security and authority need owner review before the system can act across machines.

**Alternatives rejected:** Discover architecture while connecting production systems.

**Trade-off:** One deliberate design milestone before visible automation.

**Reevaluate:** Superseded when the owner accepts CR-3 and authorizes the first bounded implementation phase.

## ADR-020 — Current releases through pinned, staged upgrades

**Decision:** Track current supported releases, but pin exact production versions/digests and promote upgrades through disposable tests, one canary node, and then the fleet.

**Why:** Automatically installing every latest release can introduce breaking protocol changes, regressions, compromised dependencies, or incompatible database migrations across all machines simultaneously.

**Alternatives rejected:** Freeze dependencies indefinitely; automatically update every node to latest without conformance tests.

**Trade-off:** The fleet can trail a new release briefly while tests run, and urgent security patches need an accelerated canary path.

**Reevaluate:** Change cadence and automation as conformance coverage improves; never remove rollback or staged promotion.

## ADR-021 — Asymmetric node identity and digested single-use enrollment

**Decision:** Nodes generate Ed25519 keys locally, enroll their public key through a class-scoped maximum-15-minute single-use token and signed challenge, and sign canonical application frames. Control Room persists only the token digest, public key, key lifecycle, and bounded replay state.

**Why:** A public protocol needs identity independent of Hermes, Codex, Claude, operating system, Cloudflare, or a shared VPN credential. Asymmetric keys let one node be revoked without rotating the fleet and keep private material off the VPS.

**Alternatives rejected:** Shared fleet API key; Cloudflare service token as the only identity; central generation/storage of node private keys; unsigned TLS-only application messages.

**Trade-off:** Each platform needs protected private-key storage and rotation packaging, and every message pays canonicalization/signature verification cost.

**Reevaluate:** Algorithms may be added through a new negotiated protocol version. Do not permit in-place key-byte replacement or silent downgrade in v1.

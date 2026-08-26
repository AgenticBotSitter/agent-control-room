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

## ADR-022 — Exact delivery retry is distinct from conflicting replay

**Decision:** After successful signature verification, an exact repeated frame is acknowledged as a duplicate and never reprocessed. Reuse of its message ID or nonce with any different connection, sequence, signature, or complete-frame digest fails closed as a replay conflict.

**Why:** At-least-once delivery must survive acknowledgement loss without turning a legitimate retry into either a security incident or a duplicate effect. Signature verification alone cannot distinguish exact retry from altered replay without durable frame identity.

**Alternatives rejected:** Reject every repeat with no acknowledgement path; process an exact repeat through ordinary handlers; allow a new body under the same message ID.

**Trade-off:** Replay storage adds a complete-frame digest and the transport must preserve a duplicate-only branch that cannot reach mutation handlers.

**Reevaluate:** Retention may change, but replay tombstones must outlive the maximum accepted frame/retry window.

## ADR-023 — Owner-anchored ceiling intersects server lease authority

**Decision:** A node acts only inside the strict intersection of an owner-signed local ceiling, complete signed lease authority, typed executor capability, and current local gates. The owner provisioning-key pin arrives out-of-band; the Control Room may relay but cannot author or widen the ceiling.

**Why:** Containment of a compromised Control Room is impossible if its own key can define the machine maximum or deliver the sole trust anchor.

**Alternatives rejected:** Server-signed ceiling; unsigned local policy; digest-only lease grants.

**Trade-off:** Enrollment and recovery require an owner-present provisioning ceremony and monotonic local state.

**Reevaluate:** Add fleet provisioning conveniences only when they preserve an independent owner trust path.

## ADR-024 — Private key storage and public trust are separate interfaces

**Decision:** Node private-key signing, server public-key trust, and approval public-key trust use separate interfaces and stores. No general key-store interface also decides protocol trust.

**Why:** Secret protection, online server-key rotation, and owner approval have different compromise and lifecycle boundaries.

**Alternatives rejected:** One `NodeKeyStore` with signing and `verifyTrust`; storing node private keys centrally.

**Trade-off:** Three small adapters replace one superficially simpler abstraction.

**Reevaluate:** Implementations may share a platform backend, but the authority interfaces remain separate.

## ADR-025 — Expiry has a pure decision path and an event monitor

**Decision:** Admission and pre-effect checks are pure functions of an injected clock. A runtime monitor only emits expiry events. The effective deadline is the earliest applicable deadline; expiry cannot be renewed back into execution.

**Why:** One admission-time check misses long-running work, while wall-clock reads inside policy destroy determinism. Post-expiry resurrection widens authority.

**Alternatives rejected:** Admission-only expiry; policy-owned timers; implicit post-expiry grace.

**Trade-off:** Executors need a wrapper and fake-timer tests. Hard stopping can create ambiguous effects.

**Reevaluate:** Add typed no-effect cleanup or measured advisory thresholds without granting new post-expiry effects.

## ADR-026 — Effect identity is independent of delivery identity

**Decision:** Durable effect admission is keyed by tenant/node/project/job/attempt/operation digest. Message ID is delivery deduplication only. A pre-effect marker separates safe re-evaluation from honest ambiguity; ambiguous effects never auto-retry.

**Why:** At-least-once delivery may re-offer the same effect under a fresh message ID. Message-scoped claims can double-fire.

**Alternatives rejected:** Message-scoped claims; in-memory locks alone; exactly-once claims; blind retry after crash.

**Trade-off:** Durable claim/tombstone state and human or destination-assisted ambiguity resolution are required.

**Reevaluate:** Destination-specific evidence can automate settlement but cannot weaken the ambiguous default.

## ADR-027 — Approval-required effects use a separate owner attestation

**Decision:** Approval-required effects need a single-use, digest-bound attestation signed by a separately trusted owner/approval key. An online Control Room assertion alone cannot satisfy this gate.

**Why:** A compromised online server can forge its own statement that a human approved. The node can verify a signed attestation even though it cannot witness the human act.

**Alternatives rejected:** Server-only approval flag; AI approval; unbound reusable approval.

**Trade-off:** Consequential effects remain disabled until the CR-8 approval flow can issue the attestation.

**Reevaluate:** Additional factors may be supported through new attestation versions; never collapse the approval key into ordinary server signing.

## ADR-028 — Canonical target enforcement precedes execution

**Decision:** Filesystem paths and network destinations are canonicalized before authorization. Files stay within real-path roots. General v1 networking is exact HTTPS destinations with TLS hostname verification, connect-time address pinning, and independent redirect authorization.

**Why:** Raw strings permit traversal, symlink escape, redirect inheritance, DNS rebinding, and confusion between an IP and authenticated host identity.

**Alternatives rejected:** Lexical path prefixes; raw URL equality; inherited redirects; IP pinning without TLS verification; opaque executor networking.

**Trade-off:** Non-TLS and opaque networking remain unavailable until a typed weaker class is deliberately designed.

**Reevaluate:** Add network classes only with explicit ceiling vocabulary, executor enforcement, and integration proof.

## ADR-029 — Denial detail stays local

**Decision:** The node keeps detailed denial evidence locally and emits a closed coarse wire vocabulary with rate limiting/coalescing. Wire receipts contain no free text, raw errors, refused arguments, allowlists, or ceiling identifiers/digests.

**Why:** A compromised server can probe local ceilings through detailed differential responses, and raw failures frequently leak secrets or private paths.

**Alternatives rejected:** Rich policy codes on wire; raw exception forwarding; stable ceiling IDs; disabling production denial limits.

**Trade-off:** Remote operators see less detail and may need a protected node-local view for diagnosis.

**Reevaluate:** Add privacy-preserving diagnostics only after a realistic workload corpus proves they do not become an oracle.

## ADR-030 — Server trust rotation is owner-root authorized

**Decision:** Nodes accept only monotonic owner-root-signed server trust bundles anchored by an out-of-band pin. Online server keys cannot authorize their own replacement, revoked keys never reactivate, and a bundle cannot leave zero active keys.

**Why:** Online-key self-rotation does not contain a compromised server. Re-enrollment is too disruptive and crosses the same compromised channel.

**Alternatives rejected:** Online self-rotation; silent replacement; routine re-enrollment; first-slice `valid_until` without a clock-skew contract.

**Trade-off:** Server-key rotation requires an owner step and offline revocation remains bounded by already-held authority deadlines.

**Reevaluate:** Automate owner signing through a protected service only if it remains outside the online Control Room trust boundary.

## ADR-031 — Private-key provider selection never silently downgrades

**Decision:** Each deployment explicitly selects exactly one private-key provider. A native-provider failure never causes runtime fallback to encrypted-file mode. Encrypted-file mode is selected directly and requires an operator-configured protected file, file descriptor, or platform secret facility for its unwrap secret. Test-memory mode is structurally unavailable in production.

**Why:** Automatic fallback lets availability failures silently weaken key protection and gives a compromised process influence over its trust level. Environment variables and command-line arguments also expose unwrap material too broadly.

**Alternatives rejected:** Native-first auto-detection; default-on fallback flags; environment-variable or command-line unwrap secrets; production access to the memory fake.

**Trade-off:** A failed native provider requires an explicit operator configuration change. On the probed Linux VPS, encrypted-file is configured as the primary mode rather than discovered as a fallback.

**Reevaluate:** A future owner-signed deployment policy may authorize a planned provider transition, but a node never makes that downgrade autonomously.

## ADR-032 — Security artifact adoption uses an independent prepared high-water store

**Decision:** A node persists the current signed ceiling and server-trust bundle in one SQLite database and their monotonic high-water records in a distinct SQLite database path. Adoption follows `verify -> prepare high-water -> commit artifact -> commit high-water -> acknowledge`. A prepared record names the exact signed-body digest. Initial provisioning is a separate owner-present operation. Operational adoption cannot create missing trust state.

**Why:** Updating only the mutable artifact permits replay after rollback. Pretending two SQLite files share an atomic transaction would create a crash window. A durable prepared record instead converts every crash boundary into either deterministic completion or a fail-closed state that requires the exact pending owner artifact.

**Alternatives rejected:** One mutable file with an adjacent version field; automatic regeneration when high-water state is missing; accepting the highest file found; server-directed bootstrap; online-key self-rotation; treating two databases as one atomic commit.

**Trade-off:** A crash after prepare but before artifact commit temporarily locks that security object until the same signed owner artifact is supplied again. A same-UID attacker or coordinated rollback of both database files remains outside this mechanism's guarantee; CR-6 service isolation, ownership, backup, and host-hardening rehearsals must reduce that risk.

**Reevaluate:** Replace the second SQLite store with a stronger platform monotonic primitive when a supported cross-platform mechanism is proven. Preserve the prepared-artifact recovery semantics and never migrate by silently resetting a high-water value.

## ADR-033 — Local executor capability classifies external effects

**Decision:** The node's locally registered executor capability, not a server request flag alone, declares which operation IDs cross an external-effect boundary. A normalized request is invalid unless its `externalEffect` value exactly matches that local classification. The operation digest is recomputed locally over stable job/attempt identity, executor, operation, credentials, normalized target, risk, effect classification, duration, and measurable cost.

**Why:** A compromised online server could otherwise relabel a write, upload, publish, or other consequential operation as non-effectful and bypass approval, concurrency, ambiguity, and effect-policy checks. Trusting an unbound operation digest would create the same bypass with different spelling.

**Alternatives rejected:** Trust the request's boolean; infer effectfulness from a target kind; classify only network operations as effects; let each executor decide after policy admission; accept an opaque server-supplied operation digest.

**Trade-off:** Every executor adapter must maintain a closed local operation catalogue and version capability changes. An unknown or mismatched operation denies until the local adapter is updated.

**Reevaluate:** A future signed executor manifest may supply the catalogue, but it must be anchored in local deployment trust and must not be mutable by an ordinary online Control Room key.

## ADR-034 — Admission commits before inbound processing and acknowledgement

**Decision:** A bridge command that has a local policy plan is not marked processed or acknowledged until its accepted/refused decision is committed to the durable local admission store. The stable operation key binds tenant, node, project, job, attempt, and normalized operation digest. Multiple delivery message IDs may alias the same exact admission, but only one accepted admission may exist for an operation key.

**Why:** Acknowledging first can lose the only command after a crash. Re-evaluating an exact retry at a later clock instant can produce contradictory history. Keying admissions by delivery message ID alone lets a fresh-message re-offer bypass deduplication.

**Alternatives rejected:** Ack then persist; queue in memory; one admission per message ID; overwrite the prior decision; re-evaluate exact inputs on every retry; permit multiple accepted admissions before effect-claim serialization.

**Trade-off:** A storage failure leaves the authenticated inbox row unprocessed and causes retry/backpressure. A prior refusal may coexist with a later differently authorized admission, but the partial uniqueness constraint still permits at most one accepted admission for the stable operation.

**Reevaluate:** CR-5C effect claims may unify admission and effect identity in one transaction, but it must preserve fresh-message aliases, original-decision replay, and commit-before-ack ordering.

## ADR-035 — Runtime authority expires at the earliest immutable clamp

**Decision:** Every admitted execution persists one effective deadline equal to the earliest ceiling/authority duration deadline, authority expiry, lease expiry, approval expiry, and executor-reservation expiry. Deadline equality is expired. A pre-expiry lease renewal may replace only the lease-expiry component under a strictly increasing epoch and the same authority digest. Expiry is locally terminal for new work and effects; in-flight work also records a cancellation request. No late renewal or server message can resurrect the same execution identity.

**Why:** Admission-time validity does not prove execution-time authority. Restart, clock boundaries, delayed renewal, and server disconnection must not extend a grant implicitly. Persisting the contributing clamps makes the decision deterministic and auditable after restart.

**Alternatives rejected:** Admission-only expiry checks; server timers as authority; grace after expiry; last-arriving deadline wins; replacing authority on renewal; reviving an expired attempt; relying on an in-memory timer; treating cancellation delivery as proof that an effect did not fire.

**Trade-off:** Work can stop at a strict boundary and restart classification is conservative. Running work may need cancellation even when it was harmless. Whether an external effect fired remains ambiguous until the effect-claim slice adds durable pre-effect evidence.

**Reevaluate:** Measured deployments may configure an advisory `expiring_soon` threshold, but it cannot alter the effective deadline. A new attempt/effect identity may be admitted after expiry through the normal authority path; the old identity never revives.

## ADR-036 — Target authority produces pinned local identity plans

**Decision:** A canonical target string is necessary but not sufficient for execution. Filesystem targets require real-path, volume, and object-identity evidence under a directory root, with a separate absent-new-file plan and mandatory pre-use revalidation. Network targets remain exact canonical HTTPS host/port tuples. DNS names resolve once into a bounded pinned address set; prohibited address classes deny unless the ceiling exactly names the same canonical IPv4 literal. The connected address and port plus TLS certificate hostname verification must match the plan. Redirects receive new authorization. Executors that cannot expose/control their final destination are ineligible.

**Why:** Lexical prefixes do not contain symlink, junction, reparse, mount, case-alias, device-name, or alternate-stream behavior. Raw URL equality does not contain IDNA/numeric aliases, redirects, DNS rebinding, private-address pivots, or TLS-host confusion. Separating authorization evidence from actual I/O keeps these checks deterministic and reviewable.

**Alternatives rejected:** Lexical path prefixes; canonical-string-only filesystem authorization; overwrite through the new-file path; silent URL normalization; inherited redirect authority; repeated resolution during one connection; IP pinning without TLS hostname verification; allowing opaque/browser networking under the general v1 HTTPS class; live-network unit tests.

**Trade-off:** Some legitimate aliases, submounts, local hostnames, opaque tools, and IPv6 literal destinations deny in v1. Pre-use object revalidation narrows but cannot alone eliminate the final filesystem race; platform-specific atomic open/delete behavior remains a rehearsal gate.

**Reevaluate:** Add a network or filesystem class only with a new typed ceiling/executor contract and enforcement proof. A future IPv6 literal exception needs an unambiguous bracketed canonical grammar. Destination-specific long-lived DNS policy may change only after measured workloads justify it; it cannot weaken per-connection pins or TLS identity.

## ADR-037 — Effect truth is durable, effect-scoped, and honestly ambiguous

**Decision:** Every external effect receives a node-local claim keyed by tenant, node, project, job, attempt, and normalized operation digest before dispatch. Delivery message IDs are aliases, not effect identity. Immediately before the external boundary, one transaction persists the complete pre-effect marker and executing transition. Recovery may re-evaluate only an unmarked claim; a marker or executing state without terminal truth becomes ambiguous and never auto-retries. Potentially fired effects settle only from destination receipt or affirmative non-execution evidence. Terminal history may compact only after every relevant horizon, and only into a permanent digest tombstone in this slice.

**Why:** Delivery deduplication cannot contain a fresh-message retry of the same effect. A crash after dispatch can make both success and failure plausible; silently choosing failure permits duplicate publication, upload, payment, or mutation. Keeping the exact normalized operation and authority binding beside the pre-effect marker makes recovery mechanical and auditable.

**Alternatives rejected:** Message-scoped claims; in-memory locks; writing the marker after the effect; treating acknowledgement loss as failure; automatic retry from ambiguity; cancellation as proof of non-execution; claiming exactly-once semantics; deleting all terminal history at a fixed local age; caller-assembled claim authority.

**Trade-off:** Ambiguous work can require destination evidence or a human decision and may remain blocked indefinitely. The node retains tombstones without a deletion mechanism, and the separate node-local ledger adds another durable store to operate and back up.

**Reevaluate:** Destination adapters may automate evidence collection when they use the same stable idempotency key and produce verifiable evidence. A future owner policy may authorize tombstone deletion only after it defines and enforces every retention horizon; unknown remains retain. Real process-kill and concurrent-process behavior remains a CR-5Q/CR-6 rehearsal gate.

## ADR-038 — Private-key providers are explicit boot-unlock adapters with no downgrade

**Decision:** Production selects exactly one provider that must match the actual runtime platform and key-reference mode. macOS reads one Keychain generic-password item, Windows decrypts one DPAPI CurrentUser blob, and the portable provider opens one AES-256-GCM envelope whose 32-byte unwrap secret comes from an owner-only POSIX file, one-shot inherited descriptor, or injected platform facility. Native failures never select encrypted-file mode. OS commands run without a shell; private plaintext uses stdout/stdin only at boot unlock and never an argument. Signing remains in process behind `NodePrivateKeyStore`.

**Why:** Provider discovery and fallback let availability failures silently reduce key protection. Environment variables and command arguments are widely observable. Keychain and DPAPI are viable for boot retrieval but do not supply non-exportable Ed25519 signing on the probed machines, while the headless Linux container has no usable native key store.

**Alternatives rejected:** Native-first auto-detection; automatic native-to-file fallback; environment-variable or argv unwrap secrets; Windows LocalMachine DPAPI; per-frame subprocess signing; storing plaintext PKCS#8; treating POSIX mode bits as Windows ACL evidence; production construction of the memory fake; claiming immediate `KeyObject` zeroization.

**Trade-off:** The Ed25519 key remains in the node process while unlocked and is vulnerable to same-account process compromise. Native provisioning requires a separate safe enrollment helper. Windows service startup depends on a loaded user profile; macOS background access depends on Keychain session and ACL behavior; Linux security depends on the unwrap-secret delivery mechanism.

**Reevaluate:** A vetted native binding may replace either CLI adapter behind the same interface. Secure Enclave P-256 or TPM keys require an explicit protocol algorithm change, not an adapter shortcut. Provider status cannot advance from implemented to qualified until the real macOS, Windows, and Linux packets pass.

## ADR-039 — Host qualification separates checkout preparation from owner-attended effects

**Decision:** Every host qualification starts with a stock-Node stage-zero check. Missing checkout dependencies produce a structured setup requirement rather than an improvised repair. Setup uses the pinned pnpm version and lockfile with `CI=true`, attempts cache-only installation first, requires separate authorization before network access, and executes no package lifecycle scripts. macOS native qualification can begin only from the repository-owned attached-terminal launcher after the owner types the exact one-shot confirmation phrase; a worker-reported token or acknowledgement is not human-presence evidence.

**Why:** A clean Linux checkout could not launch the TypeScript readiness command, while an agent-generated macOS acknowledgement could not prove that a human was available during the Keychain prompt window. Combining setup, readiness, and native effects made a recoverable prerequisite look like a qualification failure and encouraged workers to expand their own authority.

**Alternatives rejected:** Assume every checkout is preinstalled; link another checkout's dependencies; automatically fall back from offline to network; allow pnpm to choose lifecycle scripts interactively; embed shell-specific setup strings; accept a worker-supplied owner token; let a background agent invoke the macOS harness directly; treat preparation success as native-provider qualification.

**Trade-off:** Fresh hosts may require two separately authorized steps before qualification, and macOS qualification cannot be fully unattended. Denying package lifecycle scripts means the full application build relies on distributed platform packages and must remain part of repository validation.

**Reevaluate:** A signed, hermetic qualification bundle could replace dependency preparation after its contents and provenance are independently reproducible. A future OS-native presence primitive may replace typed confirmation, but agent possession of a reusable secret or token remains insufficient.

## ADR-040 — Human attention is a first-class cross-harness projection

**Decision:** Control Room provides one Action Inbox and Session Watch projection for questions, reviews, approvals, failures, ambiguity, incidents, expiring authority, and native sessions waiting for direction. Every item names the requested action, reason, blocked work, legal responses, evidence, age/expiry, and delivery status.

**Why:** A technically correct scheduler still fails operationally if the owner must open every harness and project to discover what is waiting. Native session lists are useful but cannot represent cross-project or non-agent work.

**Alternatives rejected:** One inbox per harness; raw chat notifications as the work record; Kanban state alone; hiding unavailable or blocked work.

**Trade-off:** Control Room must normalize attention without importing unrestricted transcripts or pretending every harness supports the same interaction verbs.

**Reevaluate:** Add new attention types through versioned adapter capabilities; do not weaken the common reason/action/evidence contract.

## ADR-041 — Review, verification, preference, and approval are separate authorities

**Decision:** A review evaluates quality against an immutable target and acceptance profile. Verification evaluates named scenarios and binds claims to evidence. Preference selects among acceptable alternatives. Approval authorizes one exact consequential operation. No record implicitly grants the function of another.

**Why:** An aesthetically approved video may still be unauthorized to publish, while a securely authorized operation may still produce unacceptable work. Artifact presence does not prove a claim.

**Alternatives rejected:** One approve/reject flag for everything; artifact upload equals verification; review acceptance authorizes publication; operation approval implies quality.

**Trade-off:** Completion has more explicit states and may require two owner decisions for a reviewed consequential effect.

**Reevaluate:** The UI may combine compatible low-risk interactions, but persistence and audit must retain the distinct decisions and authorities.

## ADR-042 — Completion Gates use bounded revision lineage

**Decision:** Submitted work passes deterministic checks, required independent review, bounded correction cycles, verification scenarios, and an evidence-backed decision. Review-requested changes create explicit revision lineage and immutable superseded targets. Exceeding the configured correction limit creates attention.

**Why:** Technical retry is not the same as intentionally changing a result after feedback. Unlimited self-repair loops consume resources, hide repeated failure, and can let the producer silently redefine success.

**Alternatives rejected:** Treat requested changes as a retry; overwrite the original artifact; unbounded agent repair; merge or publish immediately after an agent claims success.

**Trade-off:** Some salvageable work pauses for human direction after the revision budget is exhausted.

**Reevaluate:** Project acceptance profiles may tune the limit and required evidence, but cannot erase lineage or authorize an effect.

## ADR-043 — Procedures and knowledge are versioned separately from policy and authority

**Decision:** Procedure packages describe repeatable methods; knowledge bundles provide facts and context; policy determines eligibility and gates; authority envelopes grant bounded operations. Procedures and knowledge carry immutable versions, digests, provenance, trust, compatibility, and promotion history. Neither can grant authority.

**Why:** Combining instructions, project facts, permissions, and acceptance criteria in one prompt makes work packets brittle and lets untrusted content look like authorization. Successful instructions need reuse without uncontrolled drift.

**Alternatives rejected:** Harness-local skills as the only registry; prompts as policy; automatically activate agent-written playbooks; copy secrets or permissions into procedure text.

**Trade-off:** Package promotion and compatibility add lifecycle work, and harness-native skills require adapter mappings.

**Reevaluate:** A future package standard may unify transport, but the four semantic boundaries remain.

## ADR-044 — Reviewer independence and deterministic risk floors are enforceable policy

**Decision:** Review policies may require separation from the producer by worker, agent profile, harness, or model family. Joint authors are not independent final reviewers of their combined output. AI risk and quality scores are advisory and may raise scrutiny but never lower the deterministic risk floor.

**Why:** Self-review and correlated model failure can make repeated review cosmetic. Model-generated risk scores are vulnerable to prompt injection and optimistic misclassification.

**Alternatives rejected:** Producer is always sufficient reviewer; count multiple turns from the same agent as independent; AI score can downgrade a migration, credential use, publication, spend, or sensitive destination.

**Trade-off:** Strict independence can reduce eligible reviewer capacity and create visible bottlenecks.

**Reevaluate:** Evidence may justify a narrower independence rule for a task class, but deterministic authorization and risk floors remain non-negotiable.

## ADR-045 — Proprietary agent products integrate at adapter or client boundaries

**Decision:** Zide may become a northbound MCP client or protected native console. Devin may become a provider-backed harness adapter. Neither is a Control Room core dependency or authority. Documented APIs, MCP, and licensed reference components are preferred over UI scraping or copied proprietary behavior.

**Why:** Zide's product is proprietary and desktop-workflow-centered; Devin's core platform is proprietary and cloud-software-agent-centered. Control Room must continue operating with owner-selected harnesses, machines, deterministic tools, and projects.

**Alternatives rejected:** Rebuild Control Room as a Zide plugin; use Devin as the global database/scheduler; scrape proprietary dashboards; copy publicly visible but unlicensed code.

**Trade-off:** Optional integrations arrive later and cannot reproduce every native feature in the normalized interface.

**Reevaluate:** Promote an integration only after a stable supported seam, license review, conformance fixtures, least-privilege authentication, and exit strategy are proven.

## ADR-046 — External agents submit bounded candidates into frozen integration waves

**Decision:** Codex freezes non-overlapping task capsules in a versioned build wave. Eligible agents acquire ready capsules through a globally serialized GitHub claim transition, may hold several independent claims within a route limit, submit machine-described results to the named `integration/<block>` branch, and never target `main`. Submission releases route capacity before review so production can continue. Untouched work may return to ready; started or attempted work becomes blocked for triage. Automated intake can quarantine a result but cannot accept it. An independent verifier evaluates meaningful producer output, Codex promotes accepted commits, and one Codex-owned block pull request reaches `main`.

**Why:** A large legacy issue queue allowed stale, speculative, overlapping, and direct-to-main work to accumulate. Each worker pull request became an unplanned architecture and integration decision, so review cost grew faster than accepted output. Frozen contracts and mechanical intake move scope failures ahead of semantic review while preserving external implementation capacity.

**Alternatives rejected:** Agent self-assignment from a standing backlog; one worker PR per integration decision on `main`; shared live checkouts; accepting a passing worker test suite as merge authority; allowing producers to verify or merge their own work; keeping speculative future scaffolds merge-ready.

**Trade-off:** Codex must keep enough ready, non-overlapping capsules in each wave, and accepted worker commits may wait for a block integration window. GitHub issue comments temporarily serialize claims until Control Room can perform atomic scheduling itself. Small tasks with high packet cost remain architect-owned.

**Reevaluate:** When Control Room can schedule itself, replace GitHub wave metadata with the canonical job/attempt/result records while preserving frozen inputs, exact authority, producer/verifier separation, quarantine, and architect-owned integration.

## ADR-047 — Worker capacity builds product; it does not earn work through calibration queues

**Decision:** External routes receive only real bounded implementation, test, integration-candidate, platform-evidence, or necessary product-documentation work. Control Room does not issue qualification-only or instruction-following capsules as a prerequisite to useful work. Eligibility is evaluated per capsule from the frozen contract, risk, platform, required tools, prior observed behavior where available, and independent-review boundary. Effect-free work for the next block may proceed on an isolated integration branch while a platform-specific gate remains unresolved, but it cannot change the current block's disposition or reach `main` without Codex's completion-gate decision.

**Why:** Calibration packets consumed worker and review time without materially advancing the executable system. The V2 intake contract already constrains scope, commits, effects, and review. Real code with deterministic acceptance supplies better capability evidence while also building the product.

**Alternatives rejected:** Repeated T0 calibration waves; model-reputation promotion; allowing unbounded real work to avoid qualification overhead; treating parallel future-block work as proof that the prior block passed; removing result manifests or independent review.

**Trade-off:** A route may fail on its first real task and consume bounded review capacity. Capsules must therefore remain small, non-overlapping, and architect-frozen, and higher-risk work still requires stronger evidence or owner authority.

**Reevaluate:** When Control Room has measured per-route task outcomes, scheduling may use those records to rank eligible routes. It must not reintroduce make-work qualification or turn model reputation into authority.

## ADR-048 — The remaining build runs from one dependency graph and a continuous production queue

**Decision:** `docs/CONTROL_ROOM_COMPLETION_PROGRAM.md` is the architect-owned execution graph from CR-5D through CR-10. Codex retains architecture, security, authority, migrations, cross-module integration, adversarial acceptance, and release decisions. External workers receive every non-overlapping, contract-ready production slice in batches, may continue claiming independent work while earlier submissions are reviewed, and do not wait for the owner to relay ordinary job messages. Codex promotes accepted dependencies and publishes newly unlocked capsules. Only credentials, installs, native-host actions, live infrastructure, consequential effects, and required integration/release approvals return to the owner.

**Why:** Tiny sequential waves underused available workers and turned the owner into a message bus. Publishing speculative future implementations would be equally wasteful because workers would have to invent contracts or rebuild against changed foundations. A complete dependency graph makes all remaining work visible while allowing the ready frontier to expand continuously as real contracts and integrations land.

**Alternatives rejected:** One capsule followed by one review followed by another capsule; asking the owner to forward every claim and result; opening every future phase as immediately claimable; delegating security or integration to increase apparent parallelism; rebuilding the entire product in one shared branch.

**Trade-off:** Codex must actively keep the ready frontier stocked, batch reviews, and resolve dependencies. Some serial gates remain unavoidable, but they are named before work begins and do not block unrelated effect-free production.

**Reevaluate:** When CR-7 northbound MCP and Control Room scheduling are operational, import this graph and capsule/result history into canonical jobs, attempts, evidence, and integration gates. Preserve the ownership split, frozen contracts, dependency checks, and owner-effect boundaries.

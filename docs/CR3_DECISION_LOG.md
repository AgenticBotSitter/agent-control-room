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

## ADR-049 — Native agent authentication lives behind an at-most-once credential broker

**Decision:** A native agent worker never receives saved provider authentication, a readable credential store, inherited credential material, or a direct provider route. Control Room provisions a separately isolated broker with one short-lived run/model/endpoint grant and bounded input, output, and provider-call ceilings. The broker durably claims each request before dispatch; retry after claim cannot redispatch, and restart uncertainty becomes ambiguity. Permit and ticket digests are evidence, not bearer credentials. Broker provisioning and settlement remain internal. Experimental client transports are not production security boundaries.

**Why:** The first read-only native Codex call proved that a model-controlled command could read the disposable saved-auth file. Workspace sandboxing does not isolate credentials. A stateless proxy would also permit duplicate provider effects after timeout or crash and would let a worker replay a valid request beyond its intended call budget.

**Alternatives rejected:** Saved auth in a disposable worker profile; hiding `CODEX_HOME`; environment-only redaction; direct provider networking from the worker; a static digest permit without a consumption ledger; automatic retry after uncertain dispatch; treating Codex app-server WebSocket as a production credential boundary while its documented transport is experimental.

**Trade-off:** Native execution now needs a separate least-privilege process identity, private durable ledger, local IPC authentication, broker-only provider egress, and operational recovery for ambiguous calls. At-most-once dispatch can consume a call allowance without obtaining a result when the broker crashes before or during the provider request.

**Reevaluate:** A supported upstream run-scoped credential delegation mechanism may replace the local broker only if it independently proves credential unreadability, direct-egress denial, exact run/model/call bounds, revocation, durable replay containment, and sanitized evidence.

## ADR-050 — Northbound MCP records proposals but never becomes orchestration authority

**Decision:** Control Room targets the stateless MCP `2026-07-28` core for its northbound agent interface. Every request requires a short-lived signed scope grant plus possession of its bound bearer secret. MCP may expose redacted scoped observations and record job, delegation, or approval proposals. It cannot create an approval attestation, mint authority, claim or lease work, dispatch an executor, issue a credential, or perform an effect. Internal policy review, canonical workflow materialization, leases, retries, and node delivery remain outside MCP.

**Why:** Agents need one discoverable interface to request work and inspect results, but a tool call is not a durable scheduling or authorization protocol. Treating a tool name or client session as capability would bypass Control Room's tenant, replay, approval, lease, and effect gates.

**Alternatives rejected:** MCP as the internal worker queue; session-scoped authorization; tools that directly approve or execute; returning credentials through tools; accepting client-supplied parent authority; allowing proposal recording to imply dispatch.

**Trade-off:** Proposal materialization requires a separate internal idempotent workflow, and clients must poll scoped job/artifact evidence rather than treating a tool receipt as completion.

**Reevaluate:** New MCP transports or protocol revisions may replace wire details after compatibility and security review. The separation between northbound intent, canonical orchestration, authority, and effects remains.

## ADR-051 — Harness adapters publish observations, not operational authority

**Decision:** The public harness adapter SDK is restricted to a pinned manifest, compatibility decision, and safe normalization of node-local frames into canonical harness events. It exposes no lifecycle execution, approval, credentials, scheduling, lease, dispatch, artifact publication, or effect method. Raw native identifiers stay node-local and become tenant/node/adapter-bound digests before output. Hermes and Codex retain their existing protected lifecycle and security modules behind this boundary.

**Why:** A shared adapter interface is useful only if it prevents a new adapter from treating its transport client as an authority bypass. Lifecycle capabilities differ across harnesses, and a common `start` or `approve` method would obscure the stricter provider-specific requirements.

**Alternatives rejected:** One universal execution interface; adapters that return raw native IDs; conformance that launches external harnesses; treating a passing fixture as native qualification; letting example adapters inherit workflow or approval power.

**Trade-off:** Execution remains in protected adapter-specific modules and later adapters must implement a small wrapper rather than a full generic runtime.

**Reevaluate:** A future public operation layer may be considered only after canonical authority, replay, credential, isolation, and effect gates can be represented without weakening the strictest current adapter.

## ADR-052 — Package activation is an append-only reviewed pointer change

**Decision:** Procedure and knowledge bodies are immutable digest-addressed versions. Reviews, exact harness mappings, promotions, and rollbacks are separate append-only records. The only mutable registry record is a serialized active-version pointer for one tenant/project/kind/name channel. Activation requires an accepted independent review, a verified exact-version harness mapping, and the caller's expected prior digest. Rollback appends a new activation event and may select only a previously active reviewed version. Package resolution explicitly denies policy, approval, dispatch, execution, credentials, and authority.

**Why:** Editing trust into a package body would destroy provenance, while allowing a mutable status or automatic run-outcome promotion would let reusable prompt content become permission. Exact review and mapping evidence must survive later activation and rollback decisions without reinterpretation.

**Alternatives rejected:** Mutable package documents; trust flags rewritten in place; automatic activation after a successful run; compatibility by adapter name without exact versions; rollback by deleting history; treating procedure selection as execution authority.

**Trade-off:** Every useful revision creates several small immutable records and activation needs optimistic concurrency. Consumers must combine package compatibility with separate policy, lease, authority, and effect gates.

**Reevaluate:** A signed package distribution standard may replace the transport format, but immutable bodies, independent review, exact compatibility, append-only activation history, and authority separation remain mandatory.

## ADR-053 — Telegram is a presentation and response-proposal channel

**Decision:** Telegram may deliver recipient-scoped redacted notifications, collect short-lived authenticated bounded response proposals for low/medium-risk items, and deep-link to the protected dashboard. It never proves owner identity, creates a consequential approval, grants execution authority, dispatches work, or carries a credential. High/critical-risk items are deep-link only. Every callback is bound to a strict server-side record, signed within Telegram's callback-size limit, chat-bound, expiring, and consumed idempotently.

**Why:** Messaging is useful for attention but its account/session, forwarded content, bot transport, and callback replay properties are not a strong approval or execution boundary. Keeping the system of record and all consequential authority in Control Room preserves ADR-009 and ADR-041 while still supporting fast operator response.

**Alternatives rejected:** Treat any Telegram button as approval; put operation authority or secrets in callback data; trust usernames or inbound chat IDs as enrollment; allow high-risk inline actions; send raw artifacts or transcripts; let callback retry repeat downstream effects.

**Trade-off:** High-risk actions require opening the authenticated dashboard, and low/medium responses require a separate policy/materialization step. Durable idempotency and live recipient verification add deployment work.

**Reevaluate:** Transport and signing details may evolve after live qualification, but Telegram's inability to grant approval or execution authority remains.

## ADR-054 — Credential material is consumed inside a node-local single-use broker

**Decision:** Central Control Room, MCP, harness adapters, workers, and message channels may carry only logical credential references and safe catalog metadata. After exact node-local policy admission, a node-private broker issues one short-lived purpose-bound invocation, claims it before provider resolution, passes bytes only to a fixed trusted local consumer, and returns a negative-authority safe receipt. Exact terminal replay cannot reacquire material. Any uncertainty after claim is terminal ambiguity. Provider locators remain digest-only outside the provider-private boundary, and live providers are unavailable until their durable local claim, IPC, process, cleanup, and canary contracts pass.

**Why:** Returning a resolved credential to central orchestration or a general worker would turn every prompt, log, tool, adapter, and retry path into a disclosure boundary. Claim-before-resolution and terminal ambiguity also prevent a crash or timeout from silently consuming the same credential twice for an effect whose first outcome is unknown.

**Alternatives rejected:** Central vault proxy with plaintext responses; secrets in jobs, prompts, environment variables, command arguments, logs, or artifacts; bearer references that resolve without exact local admission; generic node-local `getSecret` RPC; automatic retry after provider, consumer, or cleanup uncertainty; treating buffer zeroing as proof that no copy exists.

**Trade-off:** Every credential-using operation needs a typed local consumer and provider adapter. At-most-once use may consume an invocation without a result, and production requires node-private durable claims, authenticated narrow IPC, provider-specific least privilege, restart recovery, and owner-attended operational proof.

**Reevaluate:** A provider-native workload identity or one-time delegated credential may replace local byte resolution if it preserves exact tenant/project/job/operation scope, prevents central plaintext access, supports revocation and expiry, and supplies durable at-most-once evidence.

## ADR-055 — Source-scheduled adapter reads are evidence and lifecycle changes cannot rewrite source truth

**Decision:** A source-scheduled adapter release declares only reviewed sanitized reads and carries no command, lease, network, or execution authority. Each read binds exact source scope, release, snapshot, opaque cursor, record digests, and the current adapter-control-state digest. Disable is immediate. Upgrade and rollback are expected-state append-only transitions that preserve committed cursor and receipt high-water. Rollback may select only a previously reviewed release and never re-enables an already disabled adapter. The source retains eligibility, leases, and domain transitions throughout.

**Why:** Content Blooms already owns durable scheduling and lease truth. Treating a Control Room projection, cursor reset, adapter downgrade, or local enabled flag as source authority would create two schedulers and make crashes or rollbacks capable of replaying old work. Preserving read high-water and negative authority lets Control Room recover or replace its projection without rewriting the source.

**Alternatives rejected:** Direct edits to source workflow tables; Control Room-issued leases for source-scheduled work; adapter activation as network authorization; command fields hidden in read records; cursor rewind on rollback; deleting receipts on disable; automatically re-enabling after rollback; accepting a producer's unreviewed adapter release.

**Trade-off:** Live reads need a separate authenticated connector and protected activation store. Rollback cannot erase a bad source observation and may require re-projecting from the preserved cursor or an explicit source snapshot. Placement changes arrive later as versioned source requests with source receipts rather than direct lease mutation.

**Reevaluate:** Content Blooms may explicitly delegate a bounded command in CR9A-CB-050 after the read path, redaction, idempotency, disable, rollback, and source-receipt gates pass. Its core source-scheduled lease authority remains unless a separately reviewed future contract changes the project authority mode.

## ADR-056 — Content Blooms placement is a versioned source preference with source-settled truth

**Decision:** The first Content Blooms command is only `setWorkerPreference` for one exact transcription work item and one eligible observed route. A request binds the accepted declaration and read release, a lifecycle revision that changes on enable/disable/upgrade/rollback but not ordinary reads, the exact source record version/checksum/digest, route-comparison and route-observation digests, job/attempt/effect identity, medium risk, strong approval, and one deterministic source-echoed idempotency key. Dispatch additionally requires authoritative approval resolution, a separately trusted node attestation, durable effect claim, and pre-effect marker. Content Blooms settles accepted, already-applied, or rejected truth. Missing post-marker truth is ambiguous and never auto-retries.

**Why:** A route recommendation is useful but is neither source eligibility nor a lease. Binding the expected source version prevents a stale projection from overwriting newer source truth. Separating lifecycle revision from read high-water keeps synchronization from cancelling valid approval while making disable and rollback real command invalidation barriers. Stable idempotency and source receipts allow safe reconciliation without pretending exactly-once delivery.

**Alternatives rejected:** Direct Control Room lease takeover; hidden placement inside a read; low-risk or approval-free classification; request ID as effect identity; new idempotency key on retry; retry after an unknown post-marker result; treating a local accepted receipt as source truth; allowing disable then re-enable to revive an old authorization; allowing a route comparison to dispatch directly.

**Trade-off:** Every placement needs exact source and route evidence, a fresh lifecycle-bound approval, protected claim/marker storage, and an authenticated source receipt. A harmless lifecycle change intentionally invalidates pending placement. Ambiguity may require operator-visible source reconciliation and can consume an authorization without an immediate result.

**Reevaluate:** CB-060 may implement the bounded command against injected fakes after durable request, authorization, claim, marker, receipt, ambiguity, replay, and tombstone storage pass. Live transport remains a separate owner-authorized rehearsal and cannot change source lease ownership.

## ADR-057 — Fake-backed placement uses one protected at-most-once ledger and packages remain non-authoritative

**Decision:** The first placement runtime stores the reviewed declaration, exact request, central approval records, separately verified node attestation, effect claim, pre-effect marker, source or ambiguity outcome, and permanent replay tombstone in one scope-bound HMAC-authenticated ledger. Request ID, source idempotency key, operation digest, node attestation nonce, and effect claim are independently unique. A duplicate marker cannot dispatch. Restart may re-evaluate only an unmarked claim; every marked unknown result becomes ambiguity. The only callable source is an exact injected fake with no endpoint or credential path. The research/transcription/article project pack is stored and independently reviewed through the package registry but remains inactive and non-authoritative.

**Why:** Durable state must make the safe recovery choice mechanical. Splitting replay identity from protected outcome truth or allowing a generic transport during fake acceptance would leave a path for duplicate placement. Treating reviewed instructions as runtime authority would bypass the same approval and effect gates the placement ledger is intended to enforce.

**Alternatives rejected:** In-memory placement locks; request-ID-only deduplication; a generic connector interface in the fake phase; redispatch after a duplicate marker; treating a source timeout as rejection; overwriting ambiguity with a later local receipt; deleting full outcomes when a tombstone is written; automatically activating a reviewed project pack; letting procedure text grant approval or execution.

**Trade-off:** The local slice creates several small authenticated rows and requires separate central and node approval evidence. An uncertain fake call may consume the effect without a final answer. Full outcomes remain stored even after a tombstone, and project packages require a later exact harness mapping and activation decision before use.

**Reevaluate:** CB-080/090 may add one owner-authorized authenticated read rehearsal only after endpoint identity, credential custody, transport authentication, rollback, cleanup, and evidence scope are frozen. A live placement write remains a separate explicit authorization and must preserve the same ledger and source-reconciliation rules.

## ADR-058 — Project Workspaces turn project evidence into proposals without becoming authority

**Decision:** Every project receives the same ordered owner-facing workspace shell for Overview, Inbox, Work, Agents, Automations, Files and artifacts, Reviews, Activity, and Settings. Project adapters may append bounded extension sections but cannot replace the core. ABS AI and Tech News may curate verified story projections and prepare digest-bound action proposals. A story URL is evidence, not fetch authority. An action proposal remains a draft, creates no work item, requires owner review, and grants no approval, network, command, lease, dispatch, publication, or execution authority.

**Why:** Control Room's project view is operationally strong but does not yet provide a fluid information-to-action workspace. A news project needs daily briefs, source health, queues, archive/history, evidence, and article actions without turning a content card or AI ranking into an orchestration bypass. The shared shell lets other projects add useful owner workflows while preserving the canonical scheduler, Completion Gate, package registry, node ceiling, and effect ledger.

**Alternatives rejected:** Copy a separate dashboard into the core; make ABS a standalone scheduler; let a story button dispatch immediately; treat search snippets, newsletters, or AI summaries as verified source truth; store current model names as permission; let a project extension replace the global Work or Reviews view; let the private workspace publish directly to the public ABS site.

**Trade-off:** Proposal materialization adds one explicit step before useful work enters the queue, and project-specific sections need versioned schemas. Live collection and publication require later source, privacy, credential, cost, retry, and destination contracts. The initial visible action buttons remain disabled until durable proposal storage and owner review are connected.

**Reevaluate:** CR9D-ABS-040 may connect accepted proposals to canonical workflows after replay, scope, policy, route, package, and Action Inbox tests pass. Live collection and publication remain separately owner-authorized and cannot weaken the proposal boundary.

## ADR-059 — ABS review materializes only non-runnable work and restart uncertainty is terminal

**Decision:** An ABS proposal review is a digest-bound owner decision, not a Control Room approval. Only an accepted exact review may materialize one deterministic canonical draft request, proposed workflow, and proposed job in a single transaction. The job has no credentials, filesystem roots, network destinations, effect permission, attempt, lease, dispatch, or outbox event. Collector and monitor declarations are immutable, canonical-schedule-backed, and disabled by default. The current block may record synthetic run evidence only. A run found unsettled after restart becomes terminally ambiguous; only a definite allowlisted pre-effect failure may create a separately identified bounded retry.

**Why:** Turning a news-card click or owner content decision directly into runnable work would bypass ordinary route, readiness, policy, lease, and effect controls. Separating review from approval preserves the useful information-to-work flow while keeping scheduling authority canonical. Terminal restart ambiguity prevents a monitor or collector from silently duplicating work when its prior outcome is unknown.

**Alternatives rejected:** Dispatch on article action; treat proposal acceptance as strong-factor approval; create a ready job; sequential non-transactional request/workflow/job writes; embed live endpoints or credentials in schedule declarations; start a background timer when a declaration is saved; automatically retry a run that crossed its start boundary; overwrite run history; treat local receipt creation as proof that an agent or source ran.

**Trade-off:** A reviewed item still needs ordinary readiness, route, package, policy, lease, and execution steps before useful agent work begins. Live collection needs a separate owner-authorized packet, and ambiguous runs may require manual source reconciliation instead of immediate retry.

**Reevaluate:** CR9D-ABS-060 may add one frozen owner-authorized live-read rehearsal after endpoint identity, source allowlist, credential custody, privacy, cost, timeout, cleanup, and evidence contracts are accepted. It cannot turn schedule declaration, review acceptance, or local materialization into live authority.

## ADR-060 — ABS live reads require an exact owner packet and protected at-most-once evidence

**Decision:** An ABS live read may target only a frozen, canonically ordered set of exact public unauthenticated HTTPS RSS or sitemap endpoints. The request binds endpoint identity, source set, project/job/attempt/effect identity, byte/item/time/cost ceilings, allowed content types, and one stable idempotency key while explicitly denying redirects, cookies, credentials, model calls, raw-body retention, execution, and publication. A separate non-synthetic strong owner decision must bind that exact operation before an owner-live authorization can exist. Durable claim precedes transport preparation and a marker precedes the first possible read. Any uncertainty after the marker is terminal ambiguity and cannot retry. Cleanup and terminal truth remain authenticated in the same protected ledger. The accepted repository coordinator is simulation-only, uses injected results, contains no network path, and rejects owner-live authorization.

**Why:** Reading a public feed is still an external effect with SSRF, redirect, privacy, replay, cost, and crash ambiguity risks. An enabled schedule or accepted article action cannot safely stand in for endpoint-specific authority. Keeping the first runtime fake-only proves the durable rules without turning the contract itself into a network capability.

**Alternatives rejected:** Treat public URLs as harmless and fetch on discovery; let a schedule enable the collector; accept redirects; reuse browser cookies; resolve credentials through a generic connector; return or persist raw bodies; retry after timeout or restart; mint a new idempotency key after ambiguity; treat approval as agent-execution or publication authority; ship an unreviewed generic HTTP client in the simulation block.

**Trade-off:** A real read requires a separately reviewed native transport and one owner-approved populated packet. Terminal ambiguity may consume a single-use authorization without stories. Public feeds that require redirects, authentication, cookies, or query tokens are not eligible for this lane.

**Reevaluate:** CR9D-ABS-070 may prepare publication packages locally without publication. A real ABS read remains blocked until exact sources, transport implementation, authoritative approval resolution, and operational cleanup evidence are reviewed and the owner authorizes that single packet.

## ADR-061 — ABS publication uses immutable revisions and two-boundary idempotency

**Decision:** ABS publication preparation binds one immutable content artifact and revision, source and Completion Gate evidence digests, exact destination identity and path, high-risk strong-approval operation, and a stable destination idempotency key. Declared editorial acceptance requires authoritative Completion Gate resolution before live use and never grants approval. A protected ledger claims the stable semantic publication before a pre-effect marker. The destination must independently absorb the same idempotency key and return exact revision and receipt evidence. A changed delivery/request ID cannot create a new publication identity. Definite rejection before mutation is terminal; every uncertainty after the marker is terminal ambiguity with no automatic retry. CR9D-ABS-070 implements only an injected fake destination and rejects owner-live authority.

**Why:** Publication is public, consequential, and difficult to undo. Relying only on queue delivery deduplication permits a fresh message to repeat the same revision, while relying only on a destination promise leaves restart ambiguity unrecorded. Binding the content revision and destination at both boundaries makes duplicate behavior testable without pretending the effect is exactly once.

**Alternatives rejected:** Publish from an accepted review; embed a mutable draft body in an authorization; use request/message ID as the destination key; let a new request ID republish the same revision; retry after timeout or restart; accept a destination URL without an exact adapter identity; treat a fake receipt as public truth; allow configured-live destinations into the simulation coordinator; store destination credentials in the package or ledger.

**Trade-off:** Every changed article revision requires a new package, review evidence, approval, and idempotency identity. Ambiguity can require owner-visible destination reconciliation. A live rehearsal remains blocked until a native destination adapter, authoritative evidence resolution, node attestation, credential custody, and rollback procedure are accepted.

**Reevaluate:** CR9D-ABS-080 may perform one exact owner-authorized rehearsal or record a disabled disposition. It cannot weaken the immutable revision, two-boundary idempotency, protected marker, receipt, cleanup, or ambiguity rules.

## ADR-062 — Missing live-publication evidence becomes durable disabled truth

**Decision:** CR9D-ABS-080 records publication readiness as one canonically ordered nine-gate assessment. Every gate carries an exact evidence class, current state, evidence digest when present, check time, optional expiry, and negative-authority flags. Candidate package and destination identities must each be complete ID/digest pairs. Only current evidence for every gate plus both complete identities can produce an owner-approval candidate; a candidate still grants no approval, execution, or publication authority. Missing or expired evidence produces a digest-bound disabled disposition with no attempt, mutation, effect, or automatic retry. Assessments and dispositions append atomically to a scope-bound authenticated ledger. A later assessment cannot rewrite the prior disposition, and whole-file rollback remains blocked on an independent checkpoint.

**Why:** The permitted alternative to a live rehearsal must be operational truth rather than an informal note. Without exact negative evidence, a future operator could mistake prepared contracts, an accepted article, configured destination text, or old approval for readiness. Append-only disabled records preserve why nothing ran and force future work to re-establish every prerequisite.

**Alternatives rejected:** Treat absence as implicitly disabled; mark the preparation block as a live pass; carry blockers only in prose; allow partial package or destination identity; let all-green checks authorize publication; reuse a disabled disposition as a retry; overwrite the old assessment; claim rollback resistance from an HMAC database without an independent checkpoint.

**Trade-off:** Reassessment requires nine explicit evidence records and new immutable identities. The local ledger adds authenticated state but cannot by itself detect restoration of an older complete file. A real attempt therefore remains blocked until protected checkpoint custody and every native/live prerequisite exist.

**Reevaluate:** A future owner-directed ABS publication block may consume a new candidate assessment only after authoritative evidence resolution and a separately approved one-use window. ADR-061's effect ledger, marker, destination idempotency, receipt, cleanup, and ambiguity rules remain controlling.

## ADR-063 — Wayfarer media moves through an immutable graph and synthetic evidence never becomes quality authority

**Decision:** Lo-Fi Wayfarer uses one digest-bound six-stage graph: model render and audio candidate feed QC and review, review feeds assembly, and assembly feeds publication preparation. Every stage binds exact artifact roles, producer lineage, logical route ceilings, and a CR-8 Completion Gate profile. Artifact declarations contain IDs, digests, content types, size ceilings, retention classes, and quarantine behavior but no bytes, paths, signed locators, credentials, or storage authority. Synthetic execution may emit only no-byte envelopes, non-authoritative QC observations, and negative-authority receipts. Synthetic prerequisite evidence can advance only the synthetic rehearsal; it explicitly is not authoritative Completion Gate resolution. Retention expiry produces an owner-reviewed proposal and never deletes automatically. Unreal remains ineligible until a separately measured owner-controlled benchmark exists. Publication preparation cannot upload or publish.

**Why:** Media workflows are large, branching, and expensive. Without immutable roles and lineage, a stale proxy, wrong audio take, or mismatched render could reach assembly. Without explicit synthetic semantics, deterministic test evidence could be mistaken for independent quality acceptance. Without a storage-neutral artifact contract, project instructions could smuggle paths, credentials, or deletion authority before the storage boundary is reviewed.

**Alternatives rejected:** One mutable project folder as truth; artifact filename as identity; QC implied by successful encoding; producer self-review; synthetic pass equals Completion Gate pass; assembly before accepted review; automatic cleanup at retention expiry; enable Unreal based on a declared GPU; embed R2 keys or signed URLs in the pack; let publication preparation call an uploader.

**Trade-off:** Every real artifact needs an immutable envelope and every stage needs explicit verification. The first workflow produces metadata rather than media, and retention execution needs another protected state machine. High-value media may remain quarantined or blocked while independent evidence is gathered.

**Reevaluate:** CR9B-WF-040 may add storage scope and lifecycle contracts without accessing storage. CR9B-WF-080 remains the first possible measured Unreal benchmark, and upload/publication remains separately destination-idempotent and owner-approved.

## ADR-064 — Wayfarer storage identity is public metadata while every usable locator remains private authority

**Decision:** Wayfarer has exactly two logical artifact stores at this boundary: local-private and R2-private. Control Room binds each immutable artifact declaration to a store-specific object-key digest, short-lived capacity proposal, retention class, and broker-private locator-reference digest. It stores no path, bucket, account, endpoint, signed URL, locator value, credential reference, or bytes. Object keys are immutable and overwrite is forbidden. One retry is allowed only after definite failure before the write marker. Integrity mismatch quarantines. Unknown outcome or restart after the marker is terminal ambiguity and cannot retry. Retention produces only independently evidenced owner-review candidates; legal hold always wins. Cleanup receipts are not deletion evidence. The accepted implementation evaluates injected metadata only and enables neither local nor R2 access.

**Why:** A filename, path, bucket key, or signed URL can disclose private topology and can also become de facto access authority. Binding public identity to digests while keeping resolvable location in a separate protected broker allows Control Room to reason about lineage, capacity, integrity, and retention without becoming a storage credential vault. Store-specific identity prevents local and R2 operations for the same artifact from colliding. Terminal post-marker ambiguity prevents a restart from silently creating duplicate large objects.

**Alternatives rejected:** Put paths or R2 keys in project records; use filenames as artifact identity; one shared ID for local and R2 copies; overwrite objects in place; store presigned URLs; let a capacity proposal write; retry after a marker, timeout, or restart; treat digest mismatch as a transient failure; automatically delete at retention expiry; let cleanup imply deletion; use R2 as a queue or lock service.

**Trade-off:** A future adapter needs a protected locator registry and extra reconciliation work. Operators cannot repair an ambiguous write by pressing retry. Retention creates visible review work instead of background deletion. Local and R2 copies retain distinct records even when their artifact declaration is identical.

**Reevaluate:** CR9B-WF-050 may add a fake adapter with no locator-resolution seam. A real local or R2 adapter requires a new owner-controlled qualification and must preserve store identity, locator custody, no-overwrite, marker, ambiguity, retention, legal-hold, and deletion-evidence rules.

## ADR-065 — Wayfarer project views show unresolved evidence while fake storage and scheduling remain non-operative

**Decision:** The accepted Wayfarer fake adapter holds only immutable metadata and enforces exact replay, no-overwrite, per-store capacity, quarantine, and terminal ambiguity without a locator-resolution or byte seam. The project workspace binds each stage digest to its independent-review target, shows synthetic evidence separately from authoritative completion, and omits command and approval controls. Its storage cards expose only accounted fake metadata and explicitly do not prove object existence. GPU and scratch scenarios reuse the deterministic eligibility and bottleneck engines with injected synthetic signals, but selection creates no reservation, dispatch, release, execution, or approval authority. Unreal remains explicitly ineligible even when declared synthetic resources are generous.

**Why:** A visually complete media workspace can mislead an operator into believing that synthetic stages, fake object metadata, or a scheduler selection represent completed media or executable work. Keeping the negative authority in both the contract and the presentation prevents a rehearsal from becoming an accidental control plane.

**Alternatives rejected:** Display the old fixture's simulated Unreal work as active; add disabled render or approval buttons; interpret a matching fake digest as object existence; let a changed replay consume capacity; combine local and R2 fake stores; infer real GPU readiness from declared capability; treat bottleneck relief as a release instruction; make synthetic QC resolve independent review.

**Trade-off:** The workspace is useful for planning and review but deliberately cannot start work. Every real byte, storage locator, native tool, measured benchmark, review decision, upload, and publication effect requires a later protected boundary.

**Reevaluate:** CR9B-WF-080 may add one frozen owner-controlled Unreal benchmark packet and either measured evidence from a separately authorized attempt or an explicit disabled disposition. It cannot reinterpret WF-050/060/070 evidence as native qualification.

## ADR-066 — Unreal benchmark readiness is an ordered durable gate and missing native evidence becomes disabled truth

**Decision:** Wayfarer freezes one digest-bound Unreal scene/render workload before any native attempt. It fixes 1920 by 1080 output, 300 frames, one warm-up, three measured runs, median wall-clock aggregation, exact metrics/evidence classes, a 15-minute ceiling, one attempt, 16 GiB memory, 64 GiB scratch, zero provider cost, and forbidden network. Thirteen ordered readiness gates bind the packet to private scene, tool, executor, node approval, hardware, GPU, scratch, network, measurement, integrity, cleanup, and owner-window evidence. Complete readiness creates only a candidate for a fresh owner-attended approval window. Measured pass is only an independently reviewable route-qualification candidate and cannot automatically activate Unreal or resolve media completion. Missing gates produce an authenticated append-only disabled disposition with no attempt or retry.

**Why:** A declared GPU, installed-looking application, synthetic benchmark, or complete checklist does not prove that a private scene can be rendered safely and repeatably. A durable disabled result prevents operators and later agents from treating absence of evidence as permission or silently repeating a native attempt.

**Alternatives rejected:** Discover and launch Unreal automatically; install or repair the tool during qualification; accept filenames or paths as scene/tool identity; benchmark an arbitrary scene; vary the workload between machines; permit network or provider fallback; treat three measured runs as three retryable attempts; retry a timeout or restart after the marker; enable the route from a synthetic pass; let benchmark success complete the media stage; store raw scene/render bytes or native output in Control Room.

**Trade-off:** The current WF-080 result is disabled rather than a performance number. A real attempt requires substantial private native evidence and owner attendance. Even a measured pass needs independent review and a later pack/route change before Unreal becomes eligible.

**Reevaluate:** WF-090/100 may add a frozen executor and upload-preparation package only in disabled, no-effect form against this packet. WF-110/120 remain separately destination-idempotent and owner-approved. A later measured benchmark requires a new exact readiness assessment and authorization without weakening the one-attempt or ambiguity rules.

## ADR-067 — A frozen executor has no native seam and upload is not publication

**Decision:** The accepted WF-090 Unreal executor binds the exact WF-080 packet, readiness assessment, and disabled disposition but contains no command, native adapter, process launcher, filesystem reader, private-locator resolver, credential resolver, network client, artifact writer, or cancellation controller. Its only current output is a digest-bound `disabled_before_start` admission and negative receipt with zero attempt or effect. WF-100 binds immutable declarations for the episode master, assembly manifest, and publication package into two separate future high-risk boundaries: private upload and public publication. Neither boundary contains a destination or credential. Each later effect independently requires an exact owner-supplied destination, qualified adapter, protected credential reference, node authority, fresh strong approval, stable destination idempotency, durable claim, pre-effect marker, destination receipt, cleanup receipt, and terminal ambiguity without automatic retry.

**Why:** A class named executor can be mistaken for runnable authority even when the benchmark is disabled. Likewise, an uploaded private master can be mistaken for permission to publish publicly. Removing the native seam makes the present refusal structural rather than conventional, while separate delivery identities prevent one approval or idempotency key from crossing effect boundaries.

**Alternatives rejected:** Store a dormant command line; accept injected process or filesystem callbacks; let the disabled executor create a job or effect claim; record synthetic cleanup as native cleanup; embed a destination placeholder URL, bucket, path, channel, or credential reference; treat private upload as publication staging under one approval; reuse message or request IDs as destination idempotency; retry after a marker; let prepared artifact declarations stand in for bytes, QC, review, or Completion Gate resolution.

**Trade-off:** WF-090 cannot be toggled on; a real adapter requires a newly reviewed implementation and qualification. Delivery remains metadata-only until every artifact and destination prerequisite exists. Operators must approve upload and publication independently, and terminal ambiguity may require manual destination reconciliation.

**Reevaluate:** WF-110/120 may add the exact destination/idempotency/approval readiness contract and either a separately owner-authorized rehearsal or authenticated disabled state. It cannot mutate this package into live authority or combine the two delivery boundaries.

## ADR-068 — Delivery readiness is separate for upload and publication and missing evidence becomes durable disabled truth

**Decision:** Wayfarer private upload and public publication use separate exact destination identities, immutable content sets, operation digests, stable destination idempotency keys, strong approval requests, readiness assessments, and dispositions. Ten ordered gates bind the preparation package, artifact content, Completion Gate resolution, destination, adapter, credential custody, node authority, idempotency qualification, reconciliation, and fresh owner window. All-green evidence creates only an owner-window candidate. Missing evidence produces a boundary-specific authenticated disabled disposition with no attempt, effect, retry, approval, or execution authority. Each lane advances independently in an append-only keyed ledger and requires an independent checkpoint before live use.

**Why:** A private master upload and public publication have different consequences and destinations. A shared approval, request ID, or delivery key could make one effect authorize or duplicate the other. Durable negative truth prevents a prepared package or configured-looking destination from being mistaken for readiness.

**Alternatives rejected:** One combined delivery operation; request ID as destination idempotency; raw destination or credential material in the control plane; approval as execution authority; all-green readiness as authority; one shared readiness row; overwrite the disabled record; retry after a marker, timeout, restart, or unknown result; claim rollback resistance without an independent checkpoint.

**Trade-off:** Upload and publication require separate evidence and owner decisions. Reconciliation may be manual after ambiguity. The present result is disabled because no real media, destination, adapter, credential, node authority, or approval window exists.

**Reevaluate:** A future owner-directed delivery rehearsal may consume one new exact candidate assessment. It must preserve the separate lanes, stable destination idempotency, claim, marker, receipt, cleanup, terminal ambiguity, and no-retry rules.

## ADR-069 — Project adapters reject foreign scope before project evidence can cross boundaries

**Decision:** ABS News, Content Blooms, and Wayfarer retain distinct tenant/workspace/project scope tuples. Wayfarer preparation, destination, request, readiness, disposition, and operator-view contracts require the exact Wayfarer workspace and project identities. A foreign object cannot become Wayfarer evidence by copying fields or recomputing an outer digest. Cross-project isolation is part of CR9 acceptance rather than a presentation convention.

**Why:** Digest integrity proves that a record was unchanged after signing; it does not prove the record belongs to the correct project unless scope is also normative. A structurally valid record with a foreign project ID could otherwise enter later delivery logic and confuse evidence or authorization lineage.

**Alternatives rejected:** Trust the caller to select the right adapter; validate scope only when an effect begins; rely on presentation project IDs; accept arbitrary workspace/project values in downstream delivery schemas; treat a recomputed digest as sufficient scope proof.

**Trade-off:** Wayfarer contracts cannot be reused by simply changing IDs. A new media project needs its own accepted adapter contract or an explicitly versioned generic contract with equivalent scope binding.

**Reevaluate:** A future multi-project media package may generalize these schemas only after project identity, adapter identity, evidence lineage, and effect authority remain exactly bound and cross-project adversarial tests pass.

## ADR-070 — Production begins as seven distinct least-privilege services behind a protected edge

**Decision:** The first production candidate is a recovery-based single-host modular monolith with seven distinct service roles: edge connector, Control Room application, one-shot migration runner, PostgreSQL primary, backup controller, audit anchor, and independent operations observer. Each role has a distinct derived operating-system principal. Only the migration runner may mutate schema. PostgreSQL is the sole global write authority. Nodes initiate outbound authenticated connections through the protected edge and have no direct inbound listener. Approved object storage is for immutable artifacts, backup archives, and audit anchors, never coordination. Fifteen exact authenticated flows are allowed and every unknown flow is denied. The architecture contract contains no hostnames, addresses, ports, credentials, or deployable configuration.

**Why:** A smaller initial failure domain is operable by one owner, while identity and flow separation prevent the modular monolith from collapsing into one overpowered process. Protected ingress and outbound-only nodes avoid publishing an origin or every worker. PostgreSQL preserves transactional authority that object storage cannot safely replace.

**Alternatives rejected:** Public application origin; direct inbound node control; one shared root or host-administrator service account; permanently privileged migration capability; database credentials shared across application, backup, and audit roles; object storage as queue or lock; multi-primary database before recovery evidence exists; hostnames, ports, or credentials embedded in the architecture contract.

**Trade-off:** A single primary does not provide transparent failover, so restore quality and measured recovery objectives become important. More service identities and explicit flows require additional packaging work even on one host.

**Reevaluate:** A later high-availability phase may add replicas or another host only after real backup/restore, canary, monitoring, incident, and RPO/RTO evidence is independently accepted. It must preserve distinct principals, single authoritative write semantics, exact flows, protected ingress, and outbound node connectivity.

## ADR-071 — Readiness, health, and lifecycle evidence never become deployment authority

**Decision:** A release is immutable and reference-only. Deployment admission requires eighteen exact ordered, current gates covering topology, release/signature/provenance/SBOM, configuration and credential custody, edge policy, backup/WAL/restore, migration/rollback, health/resources/monitoring/audit, and a fresh owner window. All-green admission creates only an owner-window candidate. Health uses role-specific independently observed, freshness-bounded probes and yields only a readiness candidate. Deployment progresses through a one-host canary and a separate owner promotion decision. Failed canary becomes rollback-pending; uncertain state after change is terminal ambiguity. Automatic promotion, rollback, down migration, and retry after change are forbidden.

**Why:** Green dashboards and complete checklists are evidence, not consent and not proof that a side effect occurred. Separating observation, planning, approval, and effect authority prevents automation or stale evidence from silently changing production. A canary constrains the first release exposure without pretending a single-host system has a second production host.

**Alternatives rejected:** Deploy when tests pass; treat health as service-control permission; allow a service to self-attest its health; auto-promote a healthy canary; auto-rollback a failed canary; retry after a timeout or restart; run schema migration inside the steady-state application; use down migrations as the default database rollback.

**Trade-off:** Deployment and rollback require deliberate owner interaction and may stop in an ambiguous state needing reconciliation. More evidence must be produced and kept fresh before an owner window opens.

**Reevaluate:** Native deployment tooling may be added only behind a newly reviewed effect boundary with durable claim, marker, receipt, cleanup, and reconciliation semantics. It cannot weaken the eighteen gates or turn health into authority.

## ADR-072 — Recovery proves a disposable restore before any cutover, and application rollback is not database restore

**Decision:** Backup identity is an immutable digest-only manifest binding release, database/schema, base backup, bounded WAL, audit head/anchor, protected locator/key references, signature, and restore window. Recovery targets only a distinct disposable isolated identity and follows eleven ordered phases from isolation and verification through base restore, bounded WAL replay, integrity/audit validation, node-journal reconciliation, independent health validation, and a fresh owner cutover request. Restored central data cannot overwrite node-local journal truth. Production overwrite, direct cutover, down migration, implicit retry, and cutover from restoration evidence are forbidden. Application-only rollback requires a canary and leaves a verified compatible database unchanged; restoring a prior database requires a separately bound verified backup and the recovery path.

**Why:** A backup is not credible until it can restore into a clean isolated target and reconcile with independent system truth. Direct production restore combines destructive data mutation, validation, and cutover into one unsafe action. Separating application rollback from database recovery avoids using down migrations or an old database merely because an application release failed.

**Alternatives rejected:** Trust a backup upload receipt; restore over production first; target an existing production identity; replay unbounded WAL; skip the external audit anchor; replace node journals with restored central state; automatically cut over a healthy restore; silently retry after a restore marker; bundle database rollback into every application rollback.

**Trade-off:** Recovery needs disposable capacity, independent validation, explicit reconciliation, and an additional owner decision. Ambiguous or failed cleanup can stop the process without an automatic retry.

**Reevaluate:** A real clean-host rehearsal may supply measured RPO/RTO and operational evidence under a separate owner-controlled attempt. Production cutover remains a distinct high-risk gate even after the rehearsal passes.

## ADR-073 — Production packaging begins as canonical non-deployable references with exact peer separation

**Decision:** Compose and Linux systemd outputs are canonical value-free references bound to the accepted topology and release, not deployable configuration. Compose uses ten internal two-peer networks for the ten host-local flows rather than a broad shared application or operations network; external flows are digest declarations only. Every service drops all capabilities, uses no-new-privileges, has bounded resources and restart, contains no command/entrypoint/port/host namespace, and has a distinct unresolved user and immutable artifact reference. Linux units have no install section, require an unresolved owner marker, use distinct users, strict system protections, exact address families, and no secondary commands. PostgreSQL is the only writable role and migration remains one-shot with no restart.

**Why:** A realistic-looking template is easily mistaken for approved deployment configuration. Making the output structurally non-deployable allows packaging and security semantics to be tested before host, image, path, account, or credential choices exist. Two-peer networks reduce unintended lateral reach that a shared internal network would permit.

**Alternatives rejected:** Ready-to-run Compose; published origin ports; one internal network for all roles; Docker socket or privileged helper; commands embedded in templates; shared users; systemd install targets; root services; shell pre/post hooks; automatically restarting migration; writable application or observer roots.

**Trade-off:** Later native packaging must resolve references and add independently reviewed enforcement for declared external flows. The references cannot be used directly for a rehearsal.

**Reevaluate:** OPS-080/090 may consume these references for planning and disabled runbooks. Native renderers require a separately reviewed value-binding boundary and owner-authorized target; they cannot weaken exact peers, identities, hardening, or activation stops.

## ADR-074 — Protected-edge provider examples carry shape but no provider value or network authority

**Decision:** Owner ingress and node protocol remain separate exact logical routes with different authentication, audience, freshness, and replay requirements. Both use an outbound connector, expose no public origin, and deny wildcard, redirect, bypass, and inbound node access. The Cloudflare Tunnel and Access-shaped example contains unresolved identity references only and no account, zone, domain, hostname, tunnel, credential, SDK, client, or provider operation. Current truth is a seven-blocker disabled disposition with zero effects. A fake policy match can become only an owner-review candidate.

**Why:** Provider-specific examples are useful for implementation, but values or callable clients would turn an architecture reference into a latent infrastructure mutation seam. Separate owner and node routes prevent a human access decision from becoming node-protocol authority or vice versa.

**Alternatives rejected:** Public application origin; one owner/node route; wildcard hostname or audience; redirect-based compatibility; inbound node listener; embedded provider identifiers; dormant SDK/client; validate by contacting a live provider; treat a matching fake route table as network approval.

**Trade-off:** Actual provider correctness, DNS, tunnel connectivity, and access behavior remain completely unproved. Later value binding and native validation require owner attendance and fresh evidence.

**Reevaluate:** A separately authorized provider rehearsal may bind one exact account/zone/domain/tunnel set and produce protected receipts. It must preserve no-public-origin, route separation, deny-unknown behavior, exact audiences, and non-authoritative readiness.

## ADR-075 — Health collection admits only repository-created fake adapters and re-derives resource truth

**Decision:** OPS-040's current collector accepts only frozen in-memory fake adapters created by a repository factory and registered in a private weak identity map. It calls exactly the role-required probes, marks every other role/probe cell not applicable without an adapter call, and requires an observer identity distinct from all production service principals. Resource samples are bounded policy inputs, not adapter verdicts: the coordinator derives pass/fail and the parser derives it again and cross-binds it to health evidence. The resulting projection is read-only and has no action controls.

**Why:** A generic injected callback would be an undeclared native/network execution seam, and an adapter-supplied green status could hide threshold drift. Factory-only fake adapters make this phase genuinely effect-free while exercising orchestration. Independent derivation makes re-signing changed metrics insufficient.

**Alternatives rejected:** Accept any object with a probe method; perform native checks during reference work; allow service self-report as sufficient; call adapters for inapplicable probes; let adapters decide resource status; treat missing metrics as healthy; expose restart or deploy controls beside the health projection.

**Trade-off:** These results prove contract behavior only, not host health. Real probe adapters and persistence remain future security boundaries.

**Reevaluate:** Native adapters may be added only as separately qualified implementations with exact I/O, timeout, identity, redaction, freshness, and failure contracts. They must not share the fake-adapter admission path or turn readiness into service-control authority.

## ADR-076 — Backup planning is a pure no-command contract and fake execution has authenticated terminal truth

**Decision:** OPS-050 separates the protected backup/WAL contract and no-command CLI from the test-only SQLite lifecycle ledger. The protected path binds topology, release, database identity, digest-only object/key/signer references, retention ceilings, bounded estimates, immutable encrypted manifest requirements, and stable operation identity while importing no database, storage, filesystem, subprocess, or network client. Fake execution uses a repository-created in-memory adapter plus a one-use lifecycle claim, pre-effect marker, and digest-bound receipt. Whole-ledger HMAC state and an external checkpoint port detect mutation or rollback. Reopening after a marker without a receipt is terminal ambiguity and cannot redispatch.

**Why:** A backup contract that imports a database or storage client is already an execution seam, even when current code calls it only in a dry run. Conversely, a fake lifecycle still needs honest crash semantics so later orchestration cannot learn unsafe retry behavior. Keeping the pure contract separate from the ledger makes the absence of commands and clients structural while preserving reusable effect-state discipline.

**Alternatives rejected:** Embed a dormant backup or encryption command; accept a bucket, path, URL, key, credential, or resolved locator; treat uploaded bytes or a storage receipt as manifest verification; place SQLite in the protected contract path; allow retention above the ceiling; retry after a marker, timeout, restart, or unknown result; accept caller-created fake adapters; let a valid manifest grant restore authority.

**Trade-off:** The current CLI cannot perform or even prepare a native backup command. The fake ledger's in-memory acceptance checkpoint is not production rollback-resistant custody. External manifest signature verification, protected-reference resolution, capacity allocation, real backup/WAL tools, and durable independent checkpoints remain unimplemented.

**Reevaluate:** A native backup boundary requires a separately reviewed adapter, owner-supplied exact target, protected reference broker, qualified process and storage identities, real rollback-resistant checkpoint, claim/marker/receipt/cleanup/reconciliation, and explicit owner authority. It cannot be added to the pure contract module or weaken terminal ambiguity.

## ADR-077 — Disposable recovery consumes a target once and can produce only a cleaned recovery candidate

**Decision:** OPS-060 recovery runs only against a repository-declared empty disposable fake identity that differs from every production principal and is consumed once. The coordinator enforces all eleven OPS-000 phases in exact order, records markers before synthetic base restore and WAL replay, refuses restored central data as a replacement for node-journal truth, requires external audit-anchor evidence and a validator distinct from the recovery worker, calculates RPO/RTO, and requires authenticated cleanup before attestation. Missing anchor, self-validation, node overwrite, cleanup failure, reordered work, duplicate targets, and unsettled post-marker restart are terminal failures or ambiguity. The attestation remains `recovery_candidate_only` and grants no readiness, cutover, restore, approval, or execution authority.

**Why:** Successful restoration and successful production recovery are different claims. Reusing a target, skipping cleanup, allowing the restorer to validate itself, or opening cutover from restored data would make a fake rehearsal look like operational permission. Exact phase and identity binding lets the harness test recovery reasoning without creating a hidden database, host, or cutover seam.

**Alternatives rejected:** Restore over an existing or production target; reuse a disposable target; run phases out of order; replay unbounded WAL; skip the audit anchor; overwrite node journals; accept restorer self-validation; attest before cleanup; treat RPO/RTO as production measurements; automatically request or open cutover; retry an uncertain restore; ship a container, database, storage, network, or native adapter in the fake coordinator.

**Trade-off:** The accepted evidence proves state-machine behavior only. It contains no real bytes, process, storage system, database, host, or measured native recovery. A cleanup failure blocks attestation, and ambiguity may require an owner to reconcile rather than retry.

**Reevaluate:** A real clean-host recovery rehearsal requires new owner-scoped authority, exact isolated capacity, qualified backup/restore/WAL adapters, protected reference custody, independent native validation, cleanup proof, and separately accepted measurements. Production cutover remains a later fresh strong-owner gate even after a real rehearsal passes.

## ADR-078 — Monitoring has a closed vocabulary, treats absence as uncertainty, and cannot acquire effect authority

**Decision:** OPS-070 freezes nine metric types, nine alert rules, four queue classes, seven service roles, and exactly thirty digest-bound series. It admits no caller-defined labels, raw tenant/project IDs, destinations, credentials, or authority fields. Missing, stale, and explicitly unknown observations are visible unknown alerts rather than healthy results. Incident clearance requires two consecutive current passing samples and accepts only batches produced by the repository evaluator, so a re-signed handcrafted clear cannot close an incident. Correlated incident transitions may create proposal-only notification evidence on open and escalation. The current adapter is privately admitted and always stops before provider contact or delivery.

**Why:** Unbounded labels leak sensitive values and turn monitoring storage into an uncontrolled data plane. Treating absent data as green hides collector failure. A valid-looking alert payload is not sufficient evidence that the monitoring rules ran, and a notification is an external effect rather than an approval or operational command.

**Alternatives rejected:** Caller-defined labels or series; raw project, tenant, host, or service values; missing data treated as healthy; one passing observation closes an incident; caller-signed clear evidence; notification on every evaluation; provider or destination configuration in the monitoring contract; alerts that authorize restart, deploy, rollback, restore, or incident response.

**Trade-off:** The exact vocabulary is intentionally inflexible, the in-memory stores are not production durability, and owner-visible uncertainty may remain until two trustworthy observations arrive. Real collection and notification require separately reviewed adapters and value binding.

**Reevaluate:** Production monitoring may add qualified collectors, durable protected storage, accepted thresholds, and a gated notification boundary only after exact identities, redaction, cardinality, freshness, integrity, destination custody, rate limits, acknowledgement, and external-effect semantics are reviewed. It cannot weaken missing-data behavior or turn alert evidence into authority.

## ADR-079 — Canary and rollback planning records effect truth without owning an effect path

**Decision:** OPS-080 composes one exact eighteen-gate deployment candidate with an exact same-topology, same-release application rollback plan, then produces eight ordered proposal-only steps, three owner questions, and four distinct intents for forward migration, one-host canary, promotion, and application rollback. Canary cannot bypass verified forward-migration evidence. Promotion requires independently verified pass evidence; application rollback requires independently verified failure evidence; the branches are mutually exclusive. Database restoration is rejected from this planner and remains in recovery. Claims and markers record external evidence but grant no authority. Complete post-marker outcomes require both effect and independent receipts. Restart before a marker is definite pre-change failure; restart after a marker is terminal ambiguity; neither retries. The current ledger uses authenticated portable snapshots, an external checkpoint, and a test-only state port while the executor seam is permanently disabled.

**Why:** A useful deployment plan must preserve sequence and crash truth without quietly becoming deployment software. Treating a green canary as promotion consent, a failed canary as rollback consent, or application rollback as permission to restore a database combines evidence with authority and can magnify an incident. Separate branch evidence and terminal ambiguity allow later native work to reconcile facts without teaching unsafe automatic behavior.

**Alternatives rejected:** Auto-promote on green health; auto-rollback on failed health; start canary before migration evidence; allow both promotion and rollback branches; use a down migration; restore a database as part of application rollback; retry after a marker, restart, timeout, partial receipt, or unknown outcome; accept stale owner windows or substituted gates; embed a dormant command, target, service client, database client, provider client, or native executor.

**Trade-off:** The planner cannot deploy anything, and the current state port is not production persistence. An owner or later qualified boundary must make every consequential choice, supply independent evidence, and reconcile ambiguity. This adds stops but prevents a planner or dashboard from acquiring effect authority.

**Reevaluate:** A native canary or rollback boundary requires a separately reviewed value-binding and executor design with exact host, service, release, approval, claim, marker, receipt, cleanup, credential, checkpoint, and reconciliation contracts. It cannot import execution into this planner, weaken branch separation, or retry terminal ambiguity.

## ADR-080 — Operations runbooks compile evidence order without compiling an executor

**Decision:** OPS-090 freezes eight exact state machines for deploy, forward migration, one-host canary, application rollback, backup/WAL, isolated restore, incident isolation, and audit-anchor recovery. Each graph has exact ordered evidence classes, explicit owner-gate rehearsal points, a disabled effect slot, and mandatory cleanup and reconciliation. Instances are bound to one definition, scope, and operation and are authenticated as complete resumable state. Evidence is synthetic, fresh, exact-step-bound, non-authorizing, and carries no raw output. Exact replay is inert; changed, skipped, mixed-operation, stale, or forged evidence fails closed. Before a change boundary, failure, uncertainty, or abort blocks. At or after a change boundary, it may proceed only to cleanup and reconciliation and then terminates in ambiguity. No runbook contains a native executor, command, target, credential, retry, approval, or authority.

**Why:** A useful runbook must make sequence, stopping conditions, crash uncertainty, cleanup, and reconciliation machine-checkable without making a guide or state record callable. Compiling effect machinery beside these graphs would let evidence or an owner-facing screen become a latent action path. Authentication prevents an ordinary re-digest from rewriting resume truth, while exact graph comparison prevents semantic drift from being hidden behind valid hashes.

**Alternatives rejected:** Free-form prose as the only runbook; caller-defined or reorderable steps; owner prompts treated as approval; stale evidence accepted; evidence reused across operations; skip directly to verification or reconciliation; automatic retry after failure, timeout, restart, or unknown result; unknown native outcome treated as failure or success; cleanup optional; executable commands or dormant clients embedded in definitions; a generic injected executor; production target or credential fields.

**Trade-off:** The runbooks can prove only graph and state-machine behavior. They cannot perform, prepare, or authorize an operation, and synthetic owner gates are not human decisions. Production persistence, protected key/checkpoint custody, exact values, qualified adapters, real receipts, and owner-attended decisions remain future boundaries.

**Reevaluate:** Any native operational path requires a new reviewed value-binding and effect boundary outside this module, with protected persistence, exact target and identity, fresh strong approval, claim-before-effect, marker, independently bound receipt, cleanup, reconciliation, cancellation, and terminal ambiguity. It cannot add callable execution to these accepted definitions or convert rehearsal evidence into authority.

## ADR-081 — Privacy disposition is an evidence and review decision, never an inferred delete command

**Decision:** OPS-100 freezes fourteen exact data classes, revisioned project-scoped retention rules, digest-only disposition requests, externally grounded legal-hold and release evidence, retention/reference/inventory evidence, a fixed fail-closed precedence order, candidate-only proposals, and a control-free projection. Audit/security truth remains an indefinite append-only full record. Replay, approval, work, scope, artifact-metadata, and quarantine truth can at most compact to required digest tombstones after every dependency horizon. Unknown horizons, active references, missing policy values, early expiry, and active holds preserve data. Legal hold wins before every request kind. Control Room makes no legal determination, and the current executor is structurally disabled before any storage or native action.

**Why:** A retention date or deletion request is not proof that data is unreferenced, outside a hold, legally disposable, approved for destruction, or actually deleted. Separating classification, policy, evidence, review, authority, and effect prevents a missing value or green projection from causing irreversible loss. Preserving audit truth and replay tombstones keeps security, idempotency, and later reconciliation possible.

**Alternatives rejected:** One universal retention duration; default deletion when policy is missing; raw subject identity in Control Room; Control Room deciding legal validity; legal release as deletion authority; deletion when any dependency horizon is unknown; full removal of replay/audit evidence; source content deleted solely from a local projection; automatic quarantine cleanup; commands, locators, credentials, storage clients, or generic executors in the policy module; candidate or owner review treated as approval; automatic retry after uncertainty.

**Trade-off:** Current results are conservative and may retain data until external policy, legal, inventory, reference, and dependency evidence is complete. Production cleanup cannot run from this module, and source systems may need separate reconciliation. Additional durable custody and owner-controlled effect machinery are required before any real disposition.

**Reevaluate:** OPS-110 may build a dry-run/idempotent cleanup ledger around exact candidates, but must preserve hold/audit precedence, dependency horizons, tombstones, scope, claim/marker/receipt/cleanup/reconciliation, and terminal ambiguity. A native deletion adapter requires a later separate owner-authorized and independently reviewed effect boundary.

## ADR-082 — Cleanup rehearsal has one action-specific identity and preserves uncertainty instead of retrying

**Decision:** OPS-110 re-derives every dry-run plan from the complete OPS-100 primary evidence and freezes twelve ordered checks and gates. Body deletion, digest-tombstone compaction, source reconciliation, and quarantine have separate action and evidence requirements. A repository-created fake inventory can produce only a bounded review candidate. HMAC plus an independent rollback checkpoint authenticates one stable operation and idempotency key. Exact replay is inert, duplicate start conflicts, restart after a claim but before a marker is definite pre-marker failure, and restart after a marker without a receipt is terminal ambiguity. Synthetic success requires independent postcondition, audit, and action-specific tombstone/quarantine/source evidence. The executor remains disabled before any client or effect.

**Why:** A dry run is useful only if it exercises the same identity, evidence order, terminal proof, and crash rules a later real cleanup must preserve. Treating already-absent data, an existing tombstone, or restart uncertainty as success would allow duplicate or unverifiable destruction. Separate evidence per action prevents a quarantine record or source receipt from masquerading as deletion proof.

**Alternatives rejected:** Generic cleanup action; trust the OPS-100 proposal without re-deriving it; caller-injected inventory callback; inventory body or locator reads; existing absence treated as deletion proof; shared idempotency across actions; start the same plan twice; retry after claim, marker, restart, or unknown result; omit a tombstone for deletion or compaction; reuse quarantine or source evidence as a tombstone; ordinary digest without authenticated state; authenticated state without an independent high-water checkpoint; safe projection without authentication; dormant storage client or native executor.

**Trade-off:** The accepted CLI and lifecycle are synthetic and cannot clean anything. Conservative reconciliation may leave work unresolved when terminal-looking evidence already exists. Production use requires additional durable custody, real adapters, owner authority, and independent receipts.

**Reevaluate:** CR10A-OPS-120/130 may consume these contracts only for separately owner-authorized native rehearsals and final disposition. Any native adapter must remain outside the pure module, preserve the four action lanes and twelve gates, and cannot retry or infer success after ambiguity.

## ADR-083 — Public packaging is default-private and release evidence cannot certify itself

**Decision:** CR10B-PUB-000 admits only eight explicit public material classes under eight exact logical roots; every unclassified or private class is denied. Canonical manifests bind ordered regular-file metadata, exact compatibility policy, source/lock/SBOM/license/NOTICE/provenance/scan/reproducibility digests, and explicit absence declarations without reading content bytes. Compatibility accepts only exact contract identifiers and the supported release line and rejects wildcards, unknown versions, prereleases, substitutions, and downgrades. A signature digest is only an unverified claim. A separately bound independent external verification report remains evidence rather than certification. Eleven ordered, freshness-bounded gates may create only a blocked, synthetic-only, or independent-review candidate. Every candidate is `not_certified`, requires later independent review and a fresh owner decision, and grants no build, signing, installation, upload, or publication authority. The current publisher contains no effect client and always stops before provider contact.

**Why:** Copying files into a public-looking directory, hashing them, or attaching a signature-shaped record does not prove that private values were excluded, dependencies are licensed, provenance is complete, a verifier was independent, or a release is safe. Default-private classification prevents path placement from becoming disclosure authority. Separating content digests, signature claims, external verification reports, certification, and owner publication authority prevents a self-produced green record from promoting itself.

**Alternatives rejected:** Allowlist only by file path or extension; public-by-default repository traversal; symlinks or executable entries; semver ranges, wildcard contracts, or automatic downgrade; signature digest treated as cryptographic verification; producer self-verification; synthetic scan or install evidence treated as release-ready; one combined signing/certification flag; certification implied by all-green metadata; candidate or independent review treated as owner publication approval; dormant registry, signer, filesystem, process, credential, or network clients in the contract.

**Trade-off:** The accepted boundary cannot build a package or prove that any current file is public-safe. Later package builders must emit exact logical metadata and obtain independent evidence, and conservative version policy requires a contract revision when support lines expand. Real signing, clean-room installation, disclosure resources, and publication remain later owner-controlled work.

**Reevaluate:** CR10B implementation may populate only the frozen public roots and must preserve observation-only SDK authority, synthetic examples, canonical manifests, and default-private exclusions. CR10C and CR10Q may add mechanical and independent evidence but cannot turn a digest into verification, let a candidate certify itself, or publish without a fresh protected owner decision and separately qualified effect boundary.

## ADR-084 — Local public candidates expose observation data only and reject added callable surface

**Decision:** PUB-010 through PUB-040 create four source-only package candidates at the exact roots frozen by PUB-000. The public core exposes bounded observation schemas, canonical digests, immutable data, and sensitive-value rejection. The adapter SDK has only compatibility evaluation and observation normalization; package code rejects an adapter carrying any additional own method. The conformance kit consumes supplied in-memory fixtures only. Hermes-shaped, Codex-shaped, and generic adapters transform fabricated frames only. Every manifest remains private and source-only, has one export, and declares no build, binary, publish, registry, provider, process, filesystem, network, environment, access, approval, operation, scheduling, lease, dispatch, or effect surface.

**Why:** A public package boundary must be useful for integrations without becoming a route into an installed harness, private application runtime, or consequential action. Narrow contracts and package-level scans make that separation testable before later clean-room and release work.

**Alternatives rejected:** Re-export the private harness SDK; expose start, cancel, resume, approval, access, or generic command callbacks; identify a local executable or installed harness; make reference adapters inspect real frames; accept undeclared adapter methods; ship package build or publish scripts; treat local source candidates as release artifacts.

**Trade-off:** These candidates are intentionally narrower than the private Control Room runtime and cannot prove released-package behavior. They are not a clean-room installation, distributable archive, license disposition, SBOM, signature, or publication claim.

**Reevaluate:** PUB-050 through PUB-080 may add synthetic deployment examples, guides, reproducible local tooling, and a clean-room contract only if no tool contacts a registry, reads protected values, executes an installed harness, or promotes the candidates from private local source to a release.

## ADR-085 — Reproducibility planning and synthetic reproduction cannot claim a clean-room installation

**Decision:** PUB-050 through PUB-080 add a fifth fabricated-only workspace candidate, five tested public guides, two public schemas, declarative release metadata, an exact nine-step release plan, two synthetic reproduction observations, and a disabled materializer. The plan binds package topology and evidence order while denying archive creation, package installation, registry/network/native-harness contact, signing, upload, publication, and release authority. A synthetic clean-room assessment requires different runner identities and identical output digests, but can produce only `synthetic_candidate_only`. It always records that no actual clean-room installation and no release artifact were observed and that independent external evidence is required.

**Why:** Deterministic planning, public instructions, and repeatable fabricated evidence are useful preparation, but running twice in one prepared repository is not an independent clean-room installation. Encoding that distinction prevents local green tests from silently satisfying the PUB-000 release gate.

**Alternatives rejected:** Create an archive in this phase; install local packages and call it clean-room; contact a registry in offline mode; treat two correlated executions as independent; accept mismatched outputs; infer release authority from a reproducible digest; place a filesystem, process, registry, network, signer, uploader, or provider client behind a disabled flag.

**Trade-off:** The current rehearsal proves deterministic contract behavior only. It does not prove released package contents, dependency availability, license acceptability, a complete SBOM, public-data safety, installation instructions, or independent reproduction.

**Reevaluate:** CR10C may mechanically inventory and scan the frozen candidate roots. CR10Q may accept real clean-room and security evidence only from an independently controlled environment and exact candidate. Neither may convert synthetic observations into certification or publication authority.

## ADR-086 — Mechanical public-tree evidence is bounded, digest-only, and cannot make a legal or release decision

**Decision:** CR10C-MECH-010 through MECH-040 inspect only the eight already-classified public roots. The inspector rejects symlinks and special entries, has no caller-controlled search path, returns ordered metadata and digests rather than file bodies, records five exact candidate manifests and their direct dependencies, records LICENSE and NOTICE digests without a legal conclusion, normalizes the two public schemas, two fabricated fixtures, and local public Markdown links, and runs a bounded private-data scanner. A finding carries only public candidate path, detector kind, and digest and blocks the result. A clean result can become only `mechanical_candidate_only`; it never declares public-tree safety, license acceptability, certification, or release authority.

**Why:** A broad repository scan can leak the very private values it is meant to detect, while an unconstrained scanner can be pointed at host state or silently wander outside the release input. License text and a direct-dependency list are useful evidence but are not legal advice or complete supply-chain analysis. Keeping the inputs fixed and outputs digest-only permits repeatable checking without conflating mechanical observation with an independent reviewer or release owner.

**Alternatives rejected:** Scan the whole checkout or arbitrary paths; include matching source text in reports; permit symlinks; let a clean regular expression scan certify public safety; infer license acceptability from a LICENSE file; treat a package manifest as a complete SBOM; write a release artifact; upload a report; run a package manager, archive builder, registry request, signer, provider, or native harness; downgrade a sensitive finding into a warning.

**Trade-off:** The scanner intentionally has a finite detector vocabulary and no transitive-dependency resolver. It can report that the frozen source candidates meet the current mechanical criteria, not that the source is legally publishable, exhaustive, independently safe, or installable. Findings may require confidential owner handling outside the evidence record.

**Reevaluate:** CR10C-MECH-050 may make a conservative Codex-owned evidence disposition. CR10Q must separately perform threat/privacy/recovery review and independently controlled clean-room evidence. Neither may weaken the fixed roots, output redaction, blocked-finding behavior, or disabled effect boundary.

## ADR-087 — Public-tree disposition preserves legal uncertainty and blocks release before independent review

**Decision:** CR10C-MECH-050 converts the fixed mechanical audit and narrow prepared-workspace dependency observations into one exact 17-gate disposition. Six mechanically established gates are `passed_local`; the missing complete project license text and missing package-manifest license declarations are `failed`; and nine authority, attribution, independent-evidence, final-artifact, signature, clean-room, security-review, and owner-decision gates are `not_observed`. Every failed or unobserved gate is a blocker. The only accepted result is `blocked_before_independent_review`, with unresolved owner licensing authority and no approval to make the candidate tree public.

**Why:** An SPDX identifier file is not the complete license text, local dependency metadata is not independent provenance, and a clean bounded scan is not an independent privacy or security review. Recording those distinctions as exact gate states prevents a mechanically green candidate from silently becoming a legal conclusion, certification, or release authorization.

**Alternatives rejected:** Insert a complete project license or manifest declaration without confirmed owner authority; infer a license grant from repository contents; treat the local Zod MIT files as independent provenance; mark unobserved evidence as failed or passed interchangeably; let a public projection expose paths, digests, or license bodies; create an archive; install packages; contact a registry or provider; sign, upload, publish, or change repository visibility; allow the candidate or reviewer to grant owner release authority.

**Trade-off:** The disposition is useful because it identifies exact blockers, but it deliberately leaves the candidate unreleasable. Resolving the two license failures requires owner authority and may require legal review. CR10Q must still perform independent threat, privacy, recovery, artifact, and clean-room work against the exact candidate.

**Reevaluate:** CR10Q may change a gate only with evidence bound to the exact candidate and reviewer identity. It may not grant a license, infer owner authority, or approve publication. Complete license text, manifest metadata, signing resources, repository visibility, and the first public release remain protected owner decisions.

## ADR-088 — Public conformance validates ordinary data but does not sandbox adapter code

**Decision:** Every public digest, redaction, freezing, adapter, fixture, compatibility, normalization, and conformance-case data boundary first copies bounded ordinary data without executing Proxy traps or accessors. Proxies, accessors, symbols, sparse arrays, custom prototypes, cycles, non-finite numbers, excessive depth/nodes/keys/string size, hidden methods, and mutable shape substitution fail closed. Adapter method references are captured from one exact ordinary object. The conformance runner nevertheless executes those caller-supplied functions in the caller's JavaScript process and must always state that it is a validator, not a sandbox.

**Why:** Structural method names can restrict the public API shape but cannot prove that arbitrary JavaScript code is harmless. At the same time, accepting reflective or accessor-backed data would let hostile values execute before the validator made a decision. Separating exact data collection from code-isolation claims gives downstream users a truthful boundary.

**Alternatives rejected:** Spread or clone untrusted objects before Proxy/accessor rejection; let Zod inspect arbitrary host objects directly; freeze caller objects in place; accept inherited, hidden, symbol, sparse, or custom-prototype shapes; infer effect-free behavior from an adapter's method names; call a conformance pass a sandbox verdict; add a process/network isolation client to the public candidate.

**Trade-off:** The public validator is stricter and rejects some JavaScript objects that could serialize successfully. Trusted adapter code still runs with its host process authority. Untrusted third-party adapter execution requires a separately designed isolated runner with explicit capability, resource, credential, egress, cleanup, and review gates.

**Reevaluate:** CR10Q-SEC-010 must independently reproduce the hostile boundary cases and verify the corrected documentation. Any future third-party adapter runner reopens architecture and independent security review; the current public conformance kit cannot be reused as its isolation boundary.

## ADR-089 — Public ordinary-data records exclude prototype-mutating names and bound property names

**Decision:** Public ordinary-data snapshots create null-prototype record copies, define copied properties explicitly, reject `__proto__`, `constructor`, and `prototype`, and reject empty or longer-than-256-character property names before visiting their values. The security gate must test both the exact accepted name-length ceiling and the first rejected length, prove reserved-key rejection occurs before nested behavior or adapter execution, and bind human scope claims to the machine-counted inventory. A negative independent report remains immutable; remediation is a new producer claim that requires a different independent re-reviewer.

**Why:** A syntactically ordinary own data property can acquire special behavior when assigned to a normal object. If it becomes inherited state, own-key redaction and compatibility checks can disagree about what evidence was actually supplied. Unbounded property names also defeat the stated resource ceiling even when values and key counts are bounded. Machine-readable identity does not excuse a contradictory human scope count.

**Alternatives rejected:** Copy untrusted records with `{}` assignment; permit reserved names because JSON can represent them; scan inherited state after copying; bound values but not property names; silently edit or replace the independent report; treat producer regressions as independent acceptance; re-run only the three findings while skipping the original 24-case matrix; let the architect accept its own remediation.

**Trade-off:** The public boundary rejects a small class of JSON-shaped objects and long property names that could otherwise serialize. This is intentional for a narrow public contract. Existing trustworthy callers must rename reserved fields or shorten names before admission.

**Reevaluate:** CR10Q-SEC-025 must be performed by a reviewer different from the original reviewer, architect, and candidate producer. It must bind the unchanged negative report, remediated candidate identity, all three findings, and all 24 original cases. Acceptance still cannot grant a license, certify a final artifact, satisfy real clean-room or signature evidence, or authorize publication.

## ADR-090 — Agent conversations are bounded proposal surfaces, never job or authority records

**Decision:** Project Agent Team views compose evidence-backed identity, presence, reviewed packages, schedules, canonical work, and owner attention without becoming a second worker registry or scheduler. `working` requires a current lease or authenticated heartbeat plus exact current work. War Rooms allow two to six members, at most three rounds and ten messages, at most four reciprocal agent-pair messages, and fixed duration, reasoning, and cost ceilings. Only bounded safe summaries enter the current projection. An exact `@agent` mention may create a digest-bound owner-review draft handoff, never a work item, dispatch, approval, lease, provider grant, or execution authority. Full audit remains canonical outside the room projection.

**Why:** Hermes Bot Mode's named profiles, conversations, routines, and group rooms create a useful people-first experience, but fire-and-forget messaging, recent-activity presence, shared provider access, desktop-local history, and conversational loops are too weak for durable orchestration. Separating team visibility from job and authority truth lets Control Room gain the fluid experience without making chat behavior a security or completion boundary.

**Alternatives rejected:** Treat a bot profile as a worker permit; mark activity as working without lease/heartbeat evidence; let a routine execute because it is scheduled; use room history as the canonical job or evidence log; dispatch directly from a mention; permit unbounded bot-to-bot recursion; store raw prompts, memory, native profiles, or provider sessions in the projection; share provider access across agent profiles; call unqualified Hermes Bot Mode RPCs; configure or deploy the reserved domain in the local UI phase.

**Trade-off:** The first Team view is deliberately read-only and summary-only. Draft handoffs still require ordinary owner review and materialization, and room ceilings may stop a useful conversation early. Durable rooms, unread state, retention, legal hold, and native Bot Mode reads require additional implementation and review.

**Reevaluate:** CR11A-TEAM-020 may add authenticated local persistence only after exact minimization, integrity, retention, legal-hold, unread, cleanup, and restart semantics are frozen. CR11A-TEAM-040/050 may add a read-only pinned Hermes Bot Mode seam only after separate conformance and owner authorization. Neither may weaken canonical job/approval/evidence authority or turn `agentcontrolroom.xyz` inventory into deployment permission.

## ADR-091 — Durable Agent Team state stores safe events, not conversations or authority

**Decision:** TEAM-020 uses one private SQLite ledger per exact tenant/workspace/project. Four append-only record kinds cover bounded safe room events, owner read receipts, owner-review draft handoffs, and revisioned preservation/legal-hold hooks. Every row and the complete ordered state are HMAC-authenticated, and an independent compare-and-swap checkpoint must match before use or append. Exact replay is inert; changed replay, row or schema mutation, sequence drift, foreign scope, changed key, and complete-database rollback fail closed. Read receipts are monotonic but do not acknowledge action. Retention is `blocked_unconfigured`, legal holds preserve, and no cleanup or deletion executor exists. The UI consumes only a strict digest-bound unread/needs-you/saved-draft projection.

**Why:** A useful room must survive restart and show the owner what changed, but storing full conversations or treating persistence as orchestration would create a second unreviewed audit, memory, and authority plane. Row authentication alone cannot detect deletion or replacement of the complete database; whole-state authentication plus external high-water comparison is required. An explicit preservation default prevents missing policy from silently becoming deletion authority.

**Alternatives rejected:** Store raw prompts, full messages, memory, native profiles, provider sessions, or usable locators; use browser storage as durable truth; share one database across projects; accept mutable rows or non-monotonic read cursors; let a read receipt clear action requirements; save a handoff without its exact source mention; use an ordinary digest without HMAC; keep rollback state inside the protected database; invent a production retention duration; add cleanup, job materialization, dispatch, provider, Hermes, network, D1, R2, or deployment clients.

**Trade-off:** The ledger is local and summary-only. It cannot restore full conversation content, and preserving records until policy is supplied may retain more metadata than a later owner policy chooses. The repository checkpoint is test-only, so production rollback resistance, multi-user authentication, hosted persistence, backup, and cleanup remain unimplemented.

**Reevaluate:** TEAM-030 may materialize only a freshly owner-reviewed exact draft through existing canonical proposed-work and Action Inbox boundaries and must remain no-dispatch. Hosted persistence or cleanup requires a separately reviewed authenticated service, protected key/checkpoint custody, owner policy, backup/recovery, monitoring, and effect semantics. TEAM-040/050 remain separate pinned read-only Hermes qualification gates.

## ADR-092 — Agent Team handoffs require one authenticated exact review and atomic proposed-work materialization

**Decision:** TEAM-030 records one append-only authenticated owner decision for one exact saved handoff. Accepted, rejected, and withdrawn are distinct durable outcomes. Exact replay is inert; a second or changed decision, stale proposal, different source lineage, or foreign scope fails closed. Only `accepted` may enter one transaction that creates a draft request, proposed workflow, proposed zero-effect job, and resolved Action Inbox item. Any conflict rolls back all new canonical records. The materialized job is fixed to the Agent Team handoff specification, the sole `prepare.agent-handoff` operation, no credentials, no filesystem roots, no network, no effects, zero concurrent effects, and zero cost authority. Review is not approval, and materialization is not dispatch.

**Why:** A fluid team surface needs a short path from discussion to real tracked work, but letting chat state or a saved draft create runnable work would establish a second scheduler and authority plane. Binding the owner decision to the exact proposal and committing attention plus canonical work together prevents stale approval, split-brain UI state, and partial materialization after a crash or conflict.

**Alternatives rejected:** Dispatch directly from a mention or review; treat a read receipt as consent; accept mutable or repeated owner decisions; collapse rejection and withdrawal into deletion; materialize request, workflow, job, and attention in separate transactions; create a ready job, attempt, lease, approval, effect intent, or outbox event; permit credentials, filesystem, network, cost, or effects; let a synthetic fixture stand in for a real owner decision; contact Hermes, a provider, hosted storage, or deployment infrastructure.

**Trade-off:** The local interface can display the exact review choices but cannot yet record a real owner action through protected hosted ingress. Accepted synthetic evidence proves the transaction and restart rules, not that the owner approved a real handoff or that any agent can run it. Proposed work still needs ordinary later scheduling and execution authority.

**Reevaluate:** TEAM-040 may consume only pinned injected Hermes Bot Mode observations through a read-only normalization seam. TEAM-050 requires separate owner authorization for one native read qualification. Neither may reuse review evidence as provider, execution, dispatch, or hosted authority.

## ADR-093 — Hermes Bot Mode enters Control Room through an injected-only exact-pin read seam

**Decision:** TEAM-040 accepts only an exact ordinary-data Hermes Bot Mode observation injected into adapter `adapter.hermes.bot-mode.read.v1`. Compatibility is frozen to Hermes package `0.20.6`, revision `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`, ordered profile/room/routine/safe-summary reads, and an empty write set. Normalized identity binds tenant, workspace, project, profile-key digest, and device-key digest. Collections retain distinct observed, absent, and unknown truth. `working` requires a current canonical Control Room lease or authenticated heartbeat with current work; Bot Mode activity alone is only availability. Existing War Room ceilings remain exact. The adapter and conformance surface contain no native reader, runtime connection, provider path, schedule writer, work materializer, approval, dispatch, or executor.

**Why:** Hermes Bot Mode provides the people-first profiles, rooms, and routines needed for a fluid project view, but its local activity and conversation state cannot become Control Room identity, scheduling, audit, completion, or authority truth. An injected-only seam lets the repository prove schema, identity, minimization, resource, and compatibility behavior before any installed runtime is contacted. Exact negative capability and collection truth prevent missing evidence from being upgraded into availability or authority.

**Alternatives rejected:** Discover or read the installed Hermes profile during repository implementation; accept a compatible version range or research repository as runtime authority; use Bot Mode activity as working evidence; merge identities across devices; infer profiles from rooms or messages; collapse absent and unknown; retain full messages, prompts, memory, native paths, provider sessions, or shared provider access; expose connect, send, schedule, approve, dispatch, execute, or generic extension methods; let a conformance pass qualify a native runtime.

**Trade-off:** The adapter is useful for deterministic development and UI-compatible projection but proves nothing about the installed Hermes method set, real profile/device identity, native sanitization boundary, or runtime behavior. Until TEAM-050, Control Room cannot truthfully claim a native Bot Mode read integration.

**Reevaluate:** TEAM-050 may record a disabled disposition or, with separate exact owner authorization, execute one frozen one-profile/one-room sanitized read-only qualification. It must preserve the exact pin and empty write set, perform no provider call or full-content read, prove the native method and identity boundary, sanitize before persistence, and stop on drift. Any broader read, write, schedule, message, provider, deployment, or recurring integration requires a later contract and owner gate.

## ADR-094 — Native Hermes reads stop before contact when sanitation begins after receipt

**Decision:** TEAM-050 accepts `blocked_before_attempt` for Hermes package `0.20.6` at revision `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`. Source inspection is a mandatory readiness gate and does not consume the one authorized runtime attempt. A candidate is ineligible unless the native method itself selects one profile and at most one room, returns metadata only before crossing the boundary, proves stable profile/device identity, and has no provider or write path. The official `profiles.list` result is over-broad and contains room-message text, `profiles.describe` reads SOUL and configuration, and direct `profile.yaml` parsing encounters room-message text before filtering. Therefore no native call or profile-file read occurred and native Bot Mode reads remain disabled.

**Why:** Redacting after an over-broad response protects persistence but does not prevent Control Room from reading data outside the owner's exact authorization. A narrow authorization cannot be widened by hiding the excess afterward. Readiness must be proven from the exact pinned method before private runtime data crosses the boundary.

**Alternatives rejected:** Call `profiles.list` and discard other profiles; call `profiles.describe` and retain only a display name; parse `profile.yaml` and ignore log text after YAML decoding; treat bounded message text as metadata; use a raw native path or model/provider as identity; claim the unused attempt can be retried later; convert source inspection into native qualification.

**Trade-off:** Control Room cannot yet populate its Agent Team view from this Mac's live Hermes Bot Mode state. The accepted TEAM-040 injected-only adapter remains useful for UI and repository development, but native truth stays absent until Hermes exposes a filtered metadata-only read method.

**Reevaluate:** TEAM-060 may freeze the exact upstream-safe method shape and a disabled Control Room bridge using fixtures only. Any Hermes patch, installation, native contact, profile or room read, provider call, or retry needs a later exact pin and new owner authorization.

## ADR-095 — A future Hermes bridge starts with signed producer minimization and an empty runtime pin set

**Decision:** TEAM-060 fixes the future Hermes method to `profiles.control_room_projection`. Requests contain one profile digest selector, one optional room digest selector, and one nonce digest. Responses contain exactly one profile and zero or one room as bounded metadata, explicit omission claims, and negative provider/write truth, signed for at most sixty seconds by a separately pinned Ed25519 device key. Control Room validates injected signed fixtures into digest-bound safe results but retains no raw key or signature. The bridge is disabled, has no native reader or effect method, and its accepted Hermes revision list is empty.

**Why:** TEAM-050 demonstrated that redacting a broad native response after receipt is not compatible with a narrow authorization. Producer-side allowlisting removes message and configuration content before it crosses the native boundary. Signed profile/device identity, nonce binding, and a separate exact runtime pin prevent metadata shape alone from masquerading as authenticated current native truth.

**Alternatives rejected:** Wrap `profiles.list`; parse `profile.yaml` in Control Room; trust bounded message text; accept a version range; infer device identity from a path or hostname; let a result carry its own unpinned key; retain public key or signature in the project projection; activate from fixture conformance; add a generic RPC or native-reader method to the bridge; use unsigned display metadata as identity proof.

**Trade-off:** The contract requires a small Hermes producer change, stable protected device-key custody, a private selector mapping, nonce consumption, and a new native qualification. Until those exist, the bridge remains unable to populate the live Agent Team view.

**Reevaluate:** A later owner-authorized phase may review an exact upstream Hermes commit and native packet. Separately, CR11B-AUTO-000 may continue product progress by defining the continuous real-work ready frontier without depending on native Hermes reads.

## ADR-096 — Continuous queue stocking produces authenticated proposals, never authority

**Decision:** CR11B-AUTO-000 compiles current bounded project goals, dependency and review truth, blockers, canonical work, prior frontier proposals, route observations, cost/risk limits, capacity, and an exact repository policy fixture into authenticated proposal-only frontier evaluations. The fixture and every proposal explicitly state that owner policy is unverified. Hard gates run before deterministic priority, fair-share, and starvation ranking. Exact intent duplicates are suppressed within the source, against every canonical work state, and against authenticated frontier history. Each proposal and complete evaluation is digest- and HMAC-bound. A private fake SQLite ledger authenticates rows and complete state against an external compare-and-swap checkpoint and feeds prior proposal identity into later cycles. The safe view has no approval, ready, claim, lease, dispatch, execution, provider, message, GitHub, or external-effect capability.

**Why:** The owner should not have to keep telling agents what to do next, but an automatic idea generator cannot become an unreviewed scheduler or authority source. Continuous operation also makes cycle-local duplicate checking insufficient: a restarted controller must remember what it already proposed. Separating canonical source revision from frontier-history revision keeps later proposal evidence from making stale project or route truth appear fresh.

**Alternatives rejected:** Let the controller create ready jobs; treat priority or starvation as authority; silently retry failed/cancelled/rejected/expired exact intent; accept missing or stale dependency/route truth; let the caller declare away prior proposals; use a digest without a private authenticator; keep rollback state in the same database; expose source evidence, authentication tags, or objective text in the operator projection; add a timer, provider, bot-message, GitHub, or dispatch client in the contract phase.

**Trade-off:** The phase can continuously produce and preserve useful proposals, but nothing runs yet. Inputs are repository fixtures rather than protected canonical adapters, the rollback checkpoint is test-only, and every proposal still requires a later materialization policy. Conservative duplicate suppression requires a new intent digest for an explicit retry.

**Reevaluate:** AUTO-010 may add authenticated canonical read adapters, a local cycle service, and portfolio/Project Workspace views while remaining proposal-only. AUTO-020 may define standing owner policy and atomic proposed-work materialization. Automatic ready promotion, bot handoff, and protected activation remain separate AUTO-030/040 security and owner gates.

## ADR-097 — A ready-frontier cycle requires four agreeing authenticated reads and remains manually triggered

**Decision:** CR11B-AUTO-010 composes one frontier source only after separate `projects`, `work`, `attention`, and `capacity` reads authenticate the same tenant, sorted project scope, revision, read group, and observation time. Work candidates do not carry self-declared review or blocker truth; one exact attention overlay is required for every candidate. The cycle service accepts only an explicit manual request with a null schedule identity, calls each lane once, records only through the authenticated AUTO-000 ledger, and derives latest/history views from verified durable evaluations. Portfolio and Project Workspace projections expose bounded titles and gate reasons while omitting objectives, candidate/intent/source-evidence identity, authentication tags, policy identity, access data, and private locators. Every request, result, projection, service, and view denies work creation, approval, ready, claim, lease, dispatch, execution, provider contact, and external effects.

**Why:** Connecting the controller to repository modules creates a new confused-deputy and stale-cut risk. A single broad source could mix project truth from one revision, capacity from another, and caller-inferred review state. Separate authenticated lanes with one exact cut make disagreement visible and make source failure leave the durable ledger unchanged. Deriving the operator model from the authenticated ledger makes restart/history behavior match decision truth without storing a second mutable queue. Manual-only invocation lets the owner see the integrated product before a standing policy or automatic materialization exists.

**Alternatives rejected:** Trust one caller-composed object without lane authentication; let work candidates declare their own review or blocker status; accept partial or differently scoped reads; treat a fresh capacity read as freshness for stale project truth; store a second unauthenticated UI queue; expose source objectives, evidence, or auth tags; put approve, create-work, ready, dispatch, or run controls in the frontier view; add a timer or recurrence loop; contact Hermes, providers, GitHub, agents, hosted storage, DNS, or deployment infrastructure.

**Trade-off:** The first integrated cycle needs four coordinated reads and cannot run automatically. Non-proposed UI rows use generic labels and safe reasons rather than source titles, and a repository fixture still stands in for protected service ingress. The extra binding and negative capability make the current screen honest but defer the no-relay experience.

**Reevaluate:** AUTO-020 may add a separately authenticated standing owner-policy enrollment contract and atomically materialize an accepted frontier proposal as canonical proposed work plus owner attention. It must preserve exact proposal/source/policy lineage, keep policy activation distinct from proposal review, and stop before ready, scheduling, claim, lease, dispatch, execution, provider contact, agent messages, GitHub creation, recurrence activation, or any external effect. AUTO-030 requires an independent security review before any protected automatic promotion or handoff.

## ADR-098 — Standing policy may materialize only authenticated non-runnable proposed work

**Decision:** CR11B-AUTO-020 records an append-only HMAC-authenticated standing-policy lifecycle for repository simulation only. Each revision binds tenant/workspace scope, its exact predecessor, digest-only owner evidence, effective/expiry time, maximum proposal age, and exact project/route/platform/capability/risk/cost ceilings. Suspension and revocation preserve the prior ceiling; revocation is terminal. The private ledger authenticates every row and complete state against an external rollback checkpoint. Materialization holds the current-policy revision guard through one canonical transaction and accepts only an authenticated current evaluation and exact unexpired proposal. It creates one draft request, proposed workflow, proposed zero-effect job, and resolved Action Inbox item or creates none. Stable canonical identifiers derive from the proposal, while definition and attention evidence bind the evaluation, source, frontier policy, and standing policy. The receipt is digest- and HMAC-bound. No policy or materialization grants approval, ready, scheduling, claim, lease, dispatch, provider, agent-message, GitHub, or effect authority.

**Why:** A standing policy removes repetitive per-proposal owner relay only if its scope cannot drift and revocation cannot race the canonical write. Separating stable proposal identity from the full authorization lineage prevents a revised policy from duplicating the same work while still making changed evidence conflict visibly. Holding the policy guard through the canonical commit gives suspension and materialization one deterministic order. Keeping the result proposed and structurally non-runnable preserves the ordinary readiness and execution authority planes.

**Alternatives rejected:** Treat the unverified AUTO-000 policy fixture as owner authority; accept a caller-supplied proposal without ledger authentication; let capabilities or routes use prefixes or wildcards; update policy rows in place; reactivate a revoked policy; change ceilings during suspension or revocation; check policy and release the lock before committing canonical work; create request, workflow, job, and attention in separate transactions; derive new canonical identifiers from each policy revision; accept an unsigned receipt; create a ready job, schedule, attempt, lease, approval, effect intent, outbox message, provider call, agent message, GitHub item, or production action.

**Trade-off:** The phase can prove no-relay proposed-work creation in a repository simulation, but it cannot enroll a real owner policy or run the resulting job. The SQLite key and rollback checkpoint are test fixtures, the canonical transaction is local PGlite/PostgreSQL-compatible evidence, and policy plus canonical storage do not yet have protected hosted custody. A conservative stable proposal identity means changed policy lineage conflicts rather than silently rematerializing work.

**Reevaluate:** AUTO-030 may add protected automatic ready promotion and scheduler/jobber handoff only after an independent security review of AUTO-020 and exact policy, duplicate, revocation, readiness, reservation, and rollback boundaries. AUTO-040 remains the owner-gated end-to-end no-relay simulation and protected activation packet. Neither phase may infer production policy enrollment from repository fixture evidence.

## ADR-099 — Ready promotion is a separately reviewed atomic internal handoff, not dispatch

**Decision:** CR11B-AUTO-030 adds a separate append-only HMAC-authenticated ready-policy lifecycle rather than widening the AUTO-020 standing policy that explicitly denies readiness. Every ready-policy revision binds its exact parent standing-policy revision, a separate review digest, repository-simulation scope, global and project active-ready ceilings, exact route/platform/capability/risk/cost limits, and bounded resource reservation parameters. Promotion re-authenticates the frontier evaluation and materialization receipt, holds both current-policy guards, selects only the exact candidate through the deterministic scheduler, and commits the canonical proposed-to-ready transition, database reservation, and canonical internal-handoff outbox record in one transaction. The handoff remains pending and grants no approval, schedule, claim, lease, dispatch, execution, provider, agent-message, GitHub, or effect authority. Exact replay is inert; conflict or capacity failure rolls the transaction back.

**Why:** Readiness creates shared-capacity and downstream-delivery obligations that are absent from proposed work. Treating it as a standing-policy flag would erase the separate review gate and allow policy drift between checks. Treating an outbox record as dispatch would also confuse durable intent with acknowledged delivery or execution authority. Nested policy guards plus one canonical transaction give revocation, concurrency, capacity, and rollback a deterministic boundary while leaving actual delivery disabled.

**Alternatives rejected:** Change the AUTO-020 policy in place to permit ready; accept caller-declared current policy or scheduler selection; check policy before releasing its lock; reserve capacity in memory; transition the job and write the handoff in separate transactions; create a schedule, attempt, lease, claim, GitHub issue, agent message, provider request, or effect intent; let a handoff consumer run in this phase; count repository fixture review as production independent review; accept partial or ambiguous replay as success.

**Trade-off:** The repository can now prove an all-or-nothing ready/internal-handoff boundary, but no worker receives or executes the work. Policy keys and rollback checkpoints are fixtures, the canonical database remains local evidence, and there is no protected outbox consumer or cross-service delivery reconciliation. AUTO-030 remains unaccepted until a different independent agent reviews the exact candidate.

**Reevaluate:** After the independent review passes, AUTO-040 may build an owner-gated end-to-end no-relay simulation with injected delivery and explicit protected-activation evidence. Real policy enrollment, agent messaging, GitHub work creation, dispatch, execution, provider contact, credentials, recurrence activation, hosting, and production effects remain separate owner gates.

## ADR-100 — Independent review moves the ready handoff out of generic delivery and makes policy guards capabilities

**Decision:** The rejected AUTO-030 candidate is not accepted. Its remediation supersedes ADR-099's shared-outbox transport and caller-convention persistence boundary. A frontier job can enter ready only through a canonical operation holding simultaneous unforgeable standing- and ready-policy guard capabilities. Generic transition and generic claim reject frontier work orders. A required trusted clock limits promotion-time skew to five seconds and supplies current policy/materialization freshness. Tenant-scoped canonical idempotency binds one request ID to its exact request digest, receipt, job, reservation, and handoff. The handoff is stored in dedicated `control_ready_frontier_handoffs` state, outside `control_outbox`; no generic delivery or consumer can claim it. Replay locks the tenant first and requires the exact ready job, active reservation, resource-head capacity, transition, completed request, and pending internal handoff.

**Why:** Independent reviewers reproduced five security failures in the original candidate: generic ready bypass, stale direct persistence after revocation, conflicting request reuse, stale replay truth, and invalid observation time. A second transaction audit also proved that caller history could revive expired truth and generic delivery could claim the purportedly internal packet. Fixing isolated conditions while retaining alternate mutation and delivery paths would leave the core invariant false. Capability-bound policy guards and a dedicated one-state handoff make the negative-authority boundary structural rather than conventional.

**Alternatives rejected:** Keep the shared outbox and ask consumers to ignore the topic; trust an exported persistence helper to be called only from the service; treat a tenant lock as authorization; accept caller promotion time as current time; let request IDs be descriptive rather than durable idempotency keys; return a historical active/pending receipt after reservation expiry; reject simultaneous exact requests instead of converging; let reentrant same-store policy calls roll back an outer transaction; interpret the negative review as a documentation gap.

**Trade-off:** Migration `0027` adds a dedicated table that has no consumer and therefore cannot yet deliver work. The trusted clock and live guard capabilities are process-local repository evidence, and full multi-session PostgreSQL scheduling remains unproven. This is intentionally conservative: ambiguous or advanced state rejects replay, and frontier-ready jobs cannot be claimed until a separately reviewed consumer and claim authorization exist.

**Reevaluate:** A different independent agent must re-run every original and supplemental attack against the exact remediated commit. Only an accepted re-review may close AUTO-030. AUTO-040 may then add an injected no-relay simulation, but a real handoff consumer, protected production policy/clock custody, agent/GitHub delivery, scheduling, claims, leases, provider contact, deployment, and effects remain separate gates.

## ADR-101 — Ready promotion requires one exact-operation authorization through database completion

**Decision:** The rejected first remediation is not accepted. Its second remediation supersedes ADR-100's identity-only policy capabilities at the canonical port. While both authenticated current-policy operations are live, only the promotion service may mint one opaque authorization bound to the complete parsed promotion receipt, both full policy snapshots, exact materialization time, and trusted clock. Canonical acquisition registers an in-flight use synchronously, derives every ceiling, resource, request, receipt, transition, reservation, and handoff fact from the hidden binding, and releases the use only after the actual database promise settles. Authorization retirement awaits all registered uses, so an unawaited call cannot let policy revocation overtake an outstanding transaction. Trusted time is sampled after policy queues and repeatedly after the tenant lock at commit-sensitive boundaries; it must be canonical, non-decreasing, within promotion skew, inside both policy intervals, inside materialization age, and before job-authority, reservation, and handoff expiry. Receipt-only operator projection rejects observations outside the active handoff interval.

**Why:** A different independent re-review proved that a legitimate live guard bound only to policy ID/revision/digest could carry caller-inflated ready/resource values, that a fire-and-forget public canonical promise could commit after both guards retired and ready policy was revoked, and that pre-queue clock sampling could authorize an already-expired write. It also proved that an authenticated historical receipt alone was being presented as current pending truth. The protected invariant therefore needs operation ownership, not just identity liveness, and write-boundary time, not a pre-queue observation.

**Alternatives rejected:** Add more caller-field comparisons without a hidden authenticated source; expose an authorization mint helper; rely on TypeScript `private` for runtime security; recheck a WeakMap only once before the first `await`; require callers to await by convention; let a callback return while a database use is unregistered; sample the clock before queued guards; use caller `occurredAt` to expire capacity; label every authenticated historical receipt pending; rewrite either immutable negative report to satisfy whitespace tooling.

**Trade-off:** The authorization and trusted clock remain process-local repository evidence, and deliberately abandoned registered work can hold policy progress until its database promise settles. Receipt-only projection is conservative and fails rather than claiming current state after expiry. Multi-process PostgreSQL behavior, production policy/clock custody, internal-handoff consumption, and cross-service ambiguity remain unproved. The two Markdown hard-break lines in the first immutable review are retained and documented instead of being silently normalized.

**Reevaluate:** An agent different from both prior reviewers must attack the exact second-remediation commit, including direct-port field substitution, unawaited promise escape, queue and transaction time advance, stale projection, every original finding, and all negative-authority paths. Only an accepted report may close AUTO-030. AUTO-040 and every real scheduling, delivery, claim, lease, dispatch, provider, agent, GitHub, hosting, or production effect remain separate gates.

## ADR-102 — Canonical ready promotion accepts only an opaque token and receipt projection is historical

**Decision:** The rejected second remediation is not accepted. Its third remediation removes the caller-owned promotion fact object from the canonical port. The port accepts only one privately minted, single-acquire opaque authorization token, synchronously clones its hidden authenticated receipt and complete policy bindings, and derives every database write fact locally. The non-decreasing trusted clock is checked after the ready transition, after the dedicated handoff write, after promotion-request completion at the final callback boundary, and after replay's last evidence read. Receipt-only projection is explicitly historical and always reports zero current ready jobs and zero current pending handoffs. Two independent policy-store/service stacks prove duplicate convergence at the shared local canonical transaction boundary.

**Why:** The second-remediation reviewer found that exact pre-write comparisons did not protect mutable caller values reused after `await`, reproduced a transaction that committed after policy and reservation expiry during `transitionWith`, identified the equivalent replay return-time gap, and demonstrated that a receipt could not reveal early canonical reservation release. The reviewer also showed that a Promise test through one policy store serialized before the canonical database boundary. Removing caller facts is stronger than expanding time-of-check comparisons; final clock samples make crossed expiry abort the atomic transaction; a historical label avoids inventing current truth; separate stores establish the local concurrency claim.

**Alternatives rejected:** Freeze or shallow-copy selected caller fields; add another caller-vs-binding comparison before each write; treat a pre-transition clock sample as a commit-time guarantee; return replay after long evidence reads without a final time sample; infer current pending state from nominal receipt expiry; call same-store queued Promises database concurrency evidence; claim multi-process PostgreSQL behavior from local PGlite evidence; alter any prior negative review.

**Trade-off:** Reconstructing the exact write bundle in the canonical module duplicates some receipt-to-persistence mapping but eliminates a mutable confused-deputy surface. Clock validity is proven through the final transaction callback, not an external database commit timestamp. Receipt-only UI is deliberately less live until an authenticated current-state projection exists. The local separate-store test still does not prove independent process or hosted PostgreSQL behavior.

**Reevaluate:** A new independent reviewer, different from every prior reviewer, must attack the exact third-remediation commit and re-run all `REV`, `RR`, and `SRR` findings. AUTO-040 and all real policy custody, current-state projection ingress, handoff consumption, scheduling, claims, leases, agent/provider/GitHub contact, deployment, and effects remain separate gates.

## ADR-103 — Transaction-owner pre-commit checks and post-transaction ambiguity close the timing claim

**Decision:** The rejected third remediation is not accepted. Its fourth remediation adds a mandatory `transactionWithPreCommitCheck` operation to the canonical database abstraction. Both PostgreSQL and PGlite adapters run the trusted-time predicate after the complete application callback and before returning control to their transaction manager for commit initiation. Canonical ready promotion and replay also resample time after the transaction promise settles and before returning. Expiry through the abort-capable pre-commit boundary rolls the transaction back; expiry detected only after a successful commit produces explicit canonical ambiguity and never a current new/replay success result.

**Why:** The third-remediation reviewer held the real database transaction after the canonical callback's final check, advanced time beyond policy and reservation expiry, and then allowed commit. The same boundary let replay return current success after expiry. Application-callback checks could not cover a later awaited transaction-owner delay. Moving the predicate into the adapter makes it run after that delay while rollback is still available. The post-transaction sample handles the distinct case where time advances only after commit, when rollback is impossible but a current-success claim can still be denied honestly.

**Alternatives rejected:** Continue adding checks inside the canonical callback; claim that callback completion is database commit; treat a post-commit expired result as current; attempt to roll back after the transaction promise has resolved; hide the residual physical database commit timestamp limitation; use a database wrapper that can omit the predicate; weaken the atomic bundle or historical projection; alter any negative report.

**Trade-off:** The process clock still cannot prove the external database's physical commit timestamp. The adapter predicate is the last abort-capable boundary and contains no awaited application seam before commit initiation. A rare expiry after successful commit but before service return is explicit ambiguity backed by durable idempotency lineage, not a success result. Production database-clock custody and reconciliation remain later gates.

**Reevaluate:** A new independent reviewer, different from every prior reviewer, must reproduce both `TRR` probes against the exact fourth-remediation commit and re-run all earlier findings. AUTO-040 and real hosted PostgreSQL, protected clock/policy custody, ambiguity reconciliation, handoff consumption, scheduling, agent/provider/GitHub contact, deployment, and effects remain separate gates.

## ADR-104 — AUTO-030 is accepted only as the exact effect-free snapshot

**Decision:** Exact commit `adf0804a52a13d544192afc90506c3e989254ffd` is accepted for the repository-only ready-promotion and dedicated internal-handoff claim. A fresh reviewer, different from every prior reviewer, independently closed all `REV`, `RR`, `SRR`, and `TRR` attacks and returned `ACCEPTED_EFFECT_FREE_REPOSITORY_SNAPSHOT`. Its unchanged report is bound by SHA-256 `18df9e9611c5f9053962b776b8261304512b98244ba7b627fd99f4821a79fa2`. The four earlier negative reports remain negative immutable evidence. Acceptance covers the token-only hidden binding, policy lifetime through database completion, mandatory transaction-owner pre-commit freshness predicate, post-transaction ambiguity, atomic reservation/ready/handoff/request bundle, exact replay, local independent-store concurrency, historical projection, generic delivery/claim isolation, and zero-control/effect boundary.

**Why:** The fifth review reproduced the formerly failing callback-to-commit seam against the fourth remediation and observed complete rollback, then crossed expiry after successful transaction completion and observed ambiguity instead of new or replay success. It also independently repeated the full hostile matrix and repository gates. This supplies the missing independent evidence without broadening the claim beyond what the repository proves.

**Alternatives rejected:** Discard or rewrite earlier negative reports; call the phase accepted at an earlier rejected commit; infer live PostgreSQL or physical commit-timestamp proof from PGlite and dependency-source evidence; interpret an authenticated historical receipt as current handoff truth; treat acceptance as authority to consume the handoff, create GitHub work, contact an agent/provider, claim, lease, dispatch, execute, or activate production policy.

**Trade-off:** AUTO-030 deliberately ends with a pending dedicated handoff and no consumer. Multi-process hosted PostgreSQL, protected production policy/clock/key/checkpoint custody, current-state ingress, and cross-service ambiguity reconciliation remain unproved. The accepted snapshot is therefore a safe repository bridge, not an operational scheduler.

**Reevaluate:** AUTO-040 may compose the accepted repository modules through an injected fake no-relay consumer and durable reconciliation ledger, and may generate a separately digest-bound protected activation packet. AUTO-040 must remain effect-free, must not activate itself, and needs a fresh independent review. Any real policy enrollment, consumer, GitHub/agent/provider contact, scheduling, claim, lease, dispatch, execution, recurrence, hosting, deployment, or production effect remains separately owner-authorized.

## ADR-105 — No-relay evidence terminates at an exact fixed fake and cannot activate production

**Decision:** CR11B-AUTO-040 composes the accepted proposal, materialization, and ready-promotion modules only through one privately registered exact in-memory fake. The coordinator captures the fake's base method, rejects subclasses and caller-selected ports, writes a durable delivery marker before contact, and permits one attempt. A matched acknowledgement inside the authenticated delivery window is terminal success; thrown, malformed, early, late, or restart-unsettled delivery is terminal ambiguity with no retry. A private HMAC-authenticated SQLite ledger plus external rollback checkpoint preserves exact terminal replay and detects state rollback. The operator projection is sanitized and non-authorizing. A separately keyed activation packet binds the exact simulation run and accepted AUTO-030 evidence, enumerates every missing production gate, and always remains blocked with every effect permission false.

**Why:** The product needs to prove that work can travel through the full internal repository path without the owner relaying messages, while preventing a successful simulation from becoming an accidental production switch. A fixed fake removes arbitrary callback and consumer behavior from the proof. The pre-contact marker and fail-ambiguous restart rule prevent an uncertain delivery from being repeated. A separate activation packet makes remaining production work explicit without conflating evidence with authority.

**Alternatives rejected:** Accept an arbitrary injected delivery callback; dispatch through generic outbox or agent/GitHub clients; retry after a post-marker exception; accept an acknowledgement outside its start/deadline window; infer current state from an unauthenticated receipt; expose authentication or handoff payloads in the UI; let a simulation success flip a production flag; omit hosted database, multi-process, clock, policy, credential, consumer, reconciliation, owner, or independent-review gates from activation evidence.

**Trade-off:** The repository now proves one complete no-owner-relay simulation, but the fixed fake is deliberately not a production consumer. The local ledger and injected clocks/keys/checkpoints do not prove hosted multi-process operation or protected custody. Terminal ambiguity requires later reconciliation rather than automatic retry. The production activation packet is useful planning evidence but grants no capability.

**Reevaluate:** A fresh independent reviewer must attack the exact AUTO-040 candidate before the repository snapshot can be accepted. Any real consumer channel, policy enrollment, hosted PostgreSQL, protected clock/key/checkpoint or credential custody, agent/provider/GitHub contact, scheduling, claim, lease, dispatch, execution, recurrence, hosting, deployment, or external effect requires a later contract, production proof, fresh owner approval, and any required independent review.

## ADR-106 — AUTO-040 composition uses runtime-private capabilities, not caller assertions

**Decision:** The rejected AUTO-040 candidate is not accepted. Its first remediation captures exact registered materialization,
promotion, store, fake, and fixed repository-clock implementations in ECMAScript-private slots or closures, freezes their
instances and prototype surfaces, and invokes captured base methods. Ledger mutation requires a module-private capability
held only by that coordinator. A packet can be built only from the exact frozen acknowledged run object returned by the
composed operation. Start state, start/deadline chronology, and complete terminal-row capacity are durable facts, and the
complete packet input is snapshotted once without executing caller behavior.

**Why:** Separate reviewers proved that TypeScript `private readonly` fields were writable runtime properties, a Proxy
replacement could execute after the marker and produce acknowledged success, activation time could change between reads,
the public store could authenticate fabricated success, replay ignored changed start state, deadline state could be false,
and a completion could exceed the configured row ceiling. These were structural failures even though every original test
passed. Runtime-private bindings and capabilities remove the alternate mutation path; frozen eligible-run identity prevents
a valid HMAC-shaped clone from becoming composed-path evidence; preflight capacity prevents partial canonical progress.

**Alternatives rejected:** Treat TypeScript privacy or source-string scans as runtime isolation; expose the store mutation
token; accept any HMAC-valid run as coordinator evidence; re-read hostile input after validation; validate chronology only
in the coordinator; reserve only marker capacity; rewrite either negative report; interpret the blocked packet as authority.

**Trade-off:** The repository fixed clock is deterministic and cannot represent a production clock. Activation eligibility
is intentionally process-local and must be re-established by an exact coordinator replay after restart. The local SQLite
ledger, in-memory checkpoint, and same-process capacity preflight still do not prove hosted multi-process convergence.

**Reevaluate:** Different independent reviewers must reproduce all `AUTO040-SAR` and `AUTO040-DR` findings against the
exact remediation commit. Any remaining finding keeps AUTO-040 open. Production consumer, reconciliation, database,
clock/key/checkpoint/policy custody, credential brokerage, owner approval, deployment, and effects remain later gates.

## ADR-107 — AUTO-040 binds the complete collaborator graph, not only the coordinator surface

**Decision:** The first AUTO-040 remediation remains rejected for security acceptance despite its accepted durability
re-review. Its second remediation makes every collaborator admitted to the repository-only composed path a registered exact
runtime object whose mutable state is ECMAScript-private and whose instance, prototype, database operations, and accepted
base operation are captured before use. Materialization and promotion retain only exact evaluation, policy-guard,
canonical-write, and clock closures. The no-relay promotion binder accepts only a promotion service constructed with the
registered fixed repository clock. Generic AUTO-030 clocks remain available to the earlier isolated contract but cannot
enter AUTO-040. The canonical database adapter captures raw query and transaction functions once and freezes its exposed
client, preventing later caller replacement from entering the captured canonical path.

**Why:** The first security re-review replaced neither the frozen coordinator nor either frozen service. Instead it added
an own `evaluation` method to the still externally held simulation store after the whole composition existed. Both services
dynamically dispatched through that alias, executed the hostile callback twice, contacted the fake, and returned an
acknowledged run. Top-level privacy therefore did not close the dependency graph. Capturing only the exact complete graph,
including policy stores, canonical persistence, and promotion time, removes the arbitrary-callback seam before any marker
or canonical mutation can occur.

**Alternatives rejected:** Treat a frozen coordinator as proof that nested objects are immutable; capture only the public
evaluation method while leaving database, verification, or guard helpers runtime-public; trust a caller-held canonical
store or clock because its TypeScript type is narrow; repair only the exact reproduced method name; discard the accepted
durability report or rewrite the negative security report; infer security acceptance from producer tests.

**Trade-off:** Repository store and canonical instances are intentionally frozen, so test instrumentation must occur at the
captured database or clock boundary rather than by replacing accepted repository methods. This is a stronger local runtime
boundary but still does not establish hostile-process isolation, protected production clock/key/checkpoint custody, hosted
multi-process PostgreSQL convergence, or a qualified real consumer.

**Reevaluate:** A fresh reviewer different from all implementation and earlier review agents must reproduce the nested
alias attack and probe assignment, deletion, `defineProperty`, Proxy, subclass, own-method, and prototype replacement for
evaluation, both policy stores, canonical persistence, and both clock uses on the exact second-remediation commit. Any
remaining callback or alternate consumer/effect seam keeps AUTO-040 open. Production activation remains separately gated.

## ADR-108 — AUTO-040 repository provenance is exact; structural persistence ports are not authority

**Decision:** The second AUTO-040 remediation remains rejected. Its third remediation separates generic persistence from
repository-simulation provenance. Only a client created and privately registered by the module-owned test-only PGlite
factory can mark a `CanonicalStore` as eligible for the no-relay composition; generic PGlite adapters, inherited wrappers,
ordinary ducks, and the networked PostgreSQL client remain usable elsewhere but cannot bind the AUTO-040 materialization or
promotion services. The raw PGlite receiver remains inside the factory closure. Each of the four frontier SQLite stores
accepts rollback-checkpoint operations only through a binder for the exact registered in-memory reference implementation,
and that binder invokes captured base methods over ECMAScript-private state. Canonical database-method discovery uses data
descriptors and rejects accessor or Proxy behavior without invoking it.

**Why:** The second-remediation reviewer changed only caller-owned delegate state beneath already captured database and
checkpoint method identities. Those methods still consulted their mutable receivers, executed arbitrary callbacks, and
then allowed an acknowledged repository simulation. The same structural canonical boundary admitted a client backed by
networked PostgreSQL. Freezing and branding outer objects therefore did not prove the behavior or provenance of their
nested ports. Private factory state and captured exact checkpoint implementations remove the receiver-alias path rather
than adding another surface assertion.

**Alternatives rejected:** Treat captured function identity as captured behavior; allow any object satisfying
`DatabaseClient` or `RollbackCheckpointStoreV1` into AUTO-040; brand every `adaptPglite` result; identify PGlite by a
caller-visible constructor check while retaining the raw receiver; freeze a caller-owned receiver without controlling its
closure state; remove generic PostgreSQL support from unrelated contracts; alter the negative review report.

**Trade-off:** AUTO-040 now uses a test-only module-private PGlite factory and the in-memory checkpoint reference, so it
still does not prove hosted PostgreSQL, durable protected checkpoint custody, multi-process convergence, or production
runtime isolation. Those are explicit later gates. The exact factory is loaded only when the repository simulation calls
it and is not bundled into the production application.

**Reevaluate:** A fresh reviewer different from every implementation and prior review agent must attack the exact
third-remediation commit. It must reproduce `AUTO040-SSRR-001`, test mutable receiver and closure state, ordinary ducks,
network-capable clients, accessors, Proxies, subclasses, and inherited wrappers across the database and all four checkpoint
seams, and repeat every earlier `SAR` path. Any callback, network-capable alternate path, false acknowledgement, or other
consumer/effect seam keeps AUTO-040 open. Production activation remains separately gated.

## ADR-109 — AUTO-040 pins dependency implementation provenance before constructing a trusted receiver

**Decision:** The third AUTO-040 remediation remains rejected. Its fourth remediation treats exact pinned dependency
implementation identity as part of the repository-simulation authority boundary. Before constructing a PGlite receiver,
the factory verifies the PGlite 0.3.14 constructor, both prototype levels, every executable method/getter descriptor,
descriptor flags, and function-source SHA-256 against an in-repository manifest. Drift fails before construction. The
complete verified executable surface is then installed as non-writable, non-configurable own descriptors on the withheld
receiver. The exposed frozen client binds only verified operations, and only that client can receive the private
repository-simulation brand.

**Why:** The third-remediation reviewer changed the shared PGlite `transaction` prototype before calling the private
factory. Factory ownership alone then branded the changed method, which ran twice during an otherwise acknowledged
simulation. Withholding and freezing the returned client did not prove the implementation from which its captured
operation came. A pinned manifest rejects earlier drift, while a sealed private receiver prevents later shared-prototype
changes from affecting dynamic internal dispatch.

**Alternatives rejected:** Treat a module-private factory as sufficient provenance; validate only `query`, `transaction`,
and `exec` while leaving their dynamically dispatched helpers mutable; freeze the shared third-party prototypes globally;
bundle PGlite into the production application solely to capture early references; accept package-lock identity without
runtime implementation validation; alter the immutable third-remediation report.

**Trade-off:** The manifest deliberately binds this repository-only fixture to exact PGlite 0.3.14 executable source.
Updating that development dependency requires an explicit manifest review and new evidence. This remains local test
database evidence; it does not prove hosted PostgreSQL, process isolation, durable protected checkpoint custody, or a
qualified production consumer.

**Reevaluate:** A fresh reviewer different from the implementation author and all earlier AUTO-040 reviewers must
reproduce `AUTO040-STRR-001`, vary every accepted PGlite executable descriptor before construction and after receiver
creation, and repeat all `SAR` and `SSRR` paths plus ordinary completion, replay, ambiguity, rollback, blocked activation,
and negative-authority checks. Any admitted changed behavior, alternate consumer/effect seam, or false acknowledgement
keeps AUTO-040 open. Production activation remains separately gated.

## ADR-110 — AUTO-040 closes only on exact independent evidence and remains non-production

**Decision:** Exact fourth-remediation commit `fb549ebbcf5a2cbd9ca3d3cbef6842578e280074` is accepted for the local,
single-process, effect-free AUTO-040 repository simulation. The accepting independent report is immutable at SHA-256
`bc1b02f52b68ad9ce836253eb890c4df561513eed158b8a7875de4c7200cde07`. Its acceptance closes `SAR-001`, `SAR-002`,
`DR-001` through `DR-004`, `SSRR-001`, and `STRR-001` only for that exact snapshot.

**Why:** The fresh reviewer independently varied all 34 executable PGlite descriptors before factory construction and
together after private receiver creation, repeated alternate database and four-checkpoint matrices, re-ran complete
completion/replay/ambiguity/rollback/activation evidence, and found no concrete defect or alternate effect path. Producer
tests alone did not close the phase; the exact different-reviewer evidence did.

**Trade-off:** Source and descriptor pinning intentionally couples the repository fixture to PGlite 0.3.14. The accepted
simulation still does not prove hosted PostgreSQL, protected clock/key/checkpoint/policy custody, multi-process convergence,
a real consumer, credential brokerage, cross-service ambiguity reconciliation, or production isolation.

**Reevaluate:** Any PGlite change, dependency-manifest change, accepted receiver-surface change, real consumer, hosted
database, protected policy enrollment, or activation design requires a new bounded contract and proportionate fresh
review. Private GitHub transfer may preserve the accepted bytes, but merge still requires owner approval and cannot grant
production authority.

## ADR-111 — AUTO-050 describes every production proof but cannot mint production readiness

**Decision:** CR11B-AUTO-050 consumes an authenticated AUTO-040 activation packet and converts its nine blockers into
exact ordered production-proof requirements. Each requirement fixes one evidence class, proof authority, complete binding
set, freshness rule, and independence rule, but repository output is always `unobserved` with no evidence digest and no
authority. The plan fixes a separate-service-principal, mutually authenticated consumer, transactional single-owner
handoff claim, hosted PostgreSQL, node-local protected-reference broker, protected clock, owner-signed policy high-water,
and destination-evidence ambiguity model without implementing any of them. Assessment is always `blocked_design_only`;
the only disposition is disabled before consumer construction. A pure reconciliation table makes every post-marker
unknown non-retriable and performs no action.

**Why:** AUTO-040 made the remaining production work visible but left only names for nine gates. The next safe step is to
define exactly what each gate must bind and who may prove it, while preventing caller booleans, repository fixtures, or a
successful simulation from becoming production readiness. Separating design truth from proof ingestion also prevents a
future verifier from being smuggled into this candidate as an arbitrary callback or structural port.

**Alternatives rejected:** Accept caller-supplied `qualified` states or evidence digests; let repository tests satisfy a
production gate; treat independent review as owner approval; build a consumer or database client before the proof
contract; embed protected configuration or reference values; allow destination absence immediately after a marker to
authorize retry; expose an activation method or operational UI control; treat the accepted AUTO-040 packet as authority;
merge or activate based on producer tests.

**Trade-off:** AUTO-050 provides a complete, testable production-boundary blueprint but deliberately leaves all nine gates
unproved. A later proof-ingress service must verify external attestations under protected custody and will require its own
contract, storage, rollback, identity, and concurrency review. A later consumer remains a separate owner-authorized block.

**Reevaluate:** A fresh independent reviewer must attack the exact committed AUTO-050 candidate, all nine gate mappings,
packet and chronology binding, qualified-evidence forgery, reconciliation transitions, secret-safe projection, and source
absence of effect clients. Any real verifier, evidence store, hosted database, process, consumer, broker, network,
destination contact, policy enrollment, owner-decision ingress, deployment, or activation code reopens security review and
requires explicit owner authority.

**First-review amendment:** Independent review of `f046ccee689fc41ed91c7827f885a255f9eb8024` rejected the candidate
because public digest rewriting could discard authenticated packet chronology and could alias disposition plan/assessment
IDs across artifacts. The first remediation therefore adds keyed plan provenance, repeats its verification and full
chronology at downstream assessment boundaries, enforces the deterministic disposition ID, and checks every shared
identity and chronology before projection. The negative report remains immutable. Only a different reviewer may accept an
exact remediation commit, and that acceptance still cannot satisfy any of the nine production gates.

**Acceptance amendment:** A different reviewer independently reproduced both defects on the rejected snapshot and accepted
exact default-disabled remediation commit `2a47f57c3b1015b279ee51e95690d10d147b112a`. Accepted report SHA-256 is
`fa6580952fff46798bf10e9562bd824db3507571d4bec1001eb5c10d6886a611`. This closes AUTO-050 design integrity only; all
nine production proofs remain unobserved and no production verifier, consumer, deployment, or external effect is accepted.

## ADR-112 — AUTO-060 authenticates fixture proof observations without qualifying production

**Decision:** CR11B-AUTO-060 accepts only owner-, issuer-, and where required independent-verifier-signed Ed25519 proof
envelopes under literal `repository_fixture_only` trust. Each proof binds the complete authenticated AUTO-050 plan,
assessment, gate requirement, ordered binding digests, evidence aggregate, identity/key, trust revision, and chronology.
The private local SQLite ledger authenticates every row and whole state with keys held outside the database and compares a
separate rollback checkpoint. Trust revisions are linear; exact replay is inert; expiry, revocation, and later trust
revision remain visible. Every observation is `observed_unqualified`; even nine current observations retain all nine
blockers and zero qualified proofs.

**Why:** AUTO-050 named exact proof requirements but intentionally had no verifier or evidence store. The next safe seam is
to make cryptographic and persistence attacks testable without letting repository-generated keys, fixtures, or booleans
mint production readiness. Binding trust mode and negative authority into every artifact prevents successful fixture
verification from being relabelled as protected custody.

**Alternatives rejected:** Accept a caller `qualified` flag; let a proof digest satisfy a gate without every ordered
binding; accept a verifier sharing issuer identity, key, or signed independence domain; trust an unchained or rolled-back
bundle; store raw evidence or private keys; keep rollback truth inside the protected database; let nine fixture proofs
unlock owner approval or activation; add a consumer, protected-reference resolver, hosted database, network client, or
effect path to proof intake.

**Trade-off:** The root and rollback checkpoint are repository-fixture/test references, SQLite is local and
single-process, and no production clock, key, revocation, database, or evidence custody is proved. A trust update
supersedes earlier observations even when the same key remains active, deliberately requiring renewed evidence. This is
safer but more operationally expensive.

**Reevaluate:** A different independent reviewer must attack the exact frozen candidate before acceptance. Any production
root, durable protected checkpoint, hosted multi-process ledger, real evidence collection, owner approval issuance,
consumer, activation, deployment, or external effect is a new owner-authorized block with fresh security review. AUTO-060
fixture observations can never be migrated or relabelled into production qualification.

**First-review amendment:** Independent review rejected exact candidate
`f77108fc3c556970bff4cc94c4b952a0336a8cac` in immutable report SHA-256
`fc22ddd3ee62f432eeaee5d5cbc0aca6715872fa7733e095979ac1ea3457f9cf`. Canonical signatures, store-only chronological
assessment, irreversible full-chain identity revocation, trust-advance-safe exact replay, and per-operation private-file
and exact-schema checks remediate its five findings. The original negative report remains unchanged. A different reviewer
must accept an exact remediation commit; no producer test or remediation itself closes AUTO-060.

**Second-review amendment:** A new different reviewer rejected exact first-remediation commit
`fb2f0a3dd4e2e128ae6076daadad10938fec1438` in immutable report SHA-256
`1aa0119e9eb8504d471586c88d62ab44b533f16190d2c9c57fbe58cad30e9dc2`. Although the direct raw-observation assessor was
gone, a caller could still modify store-derived gate status, recompute the public assessment digest, and obtain a forged
observed-status projection through exported parsers. The second remediation removes every public digest-only assessment
or projection trust consumer and the public raw-assessment method. The only trusted view is now built and deep-frozen
inside one authenticated store operation after complete ledger, checkpoint, trust, and AUTO-050 chain verification.
Public digests remain content identity only. A third different reviewer must accept the new exact commit; negative
authority stayed intact throughout both rejections.

**Third-review amendment:** A third different reviewer rejected exact second-remediation commit
`0d7287fbdc06af3f8c220dad8227f0f99855b64a` in immutable report SHA-256
`303133e1297cb28a475b14bc51e0a77d20436a93cf4c23b410ebb544f2624323`. The public assessment and projection path was
closed, but the verifier still consulted a mutable schema object exported by the direct proof-schema module. Own-method
substitution made it authenticate one valid package while the ledger stored another changed envelope; restoration exposed
the mismatch as an integrity failure. The third remediation deletes that module, moves proof and ledger schemas plus their
primitive dependencies behind module-private state, and captures original parser operations into frozen closures. AUTO-050
boundary schemas now use private primitives and expose only frozen captured parser closures, so public schema aliases,
own-method replacement, deletion, and prototype drift are non-authoritative. A fourth different reviewer was required to
accept the exact third-remediation commit. No rejection or remediation grants production proof, approval, activation, consumer,
network, dispatch, deployment, or effect authority.

**Acceptance amendment:** A fourth different reviewer accepted exact third-remediation commit
`be01058e2edeeddb7bbd2655eaf668ed86b9d0e2`, tree `f8b16104082ade92812c82792c04611a1c40073e`, in immutable report
SHA-256 `8651708829f346e26ea60afec18418bd150844b063aa8d07e2afdd1f5bd6d61e`. It independently mutated public schema
methods and a shared prototype before and after store construction, attempted change, deletion, and prototype replacement
on every exported frozen production parser, retried the prior changed-binding envelope, and verified zero append plus clean
restart integrity. All `IR`, `FRR`, and `SRR` findings are closed only for that exact effect-free snapshot. AUTO-060 is
complete, but every fixture proof remains unqualified and all protected custody, hosted database, policy, consumer,
activation, deployment, and effect gates remain blocked.

## ADR-113 — AUTO-070 qualifies the qualification machinery, never the production environment

**Decision:** CR11B-AUTO-070 carries the complete authenticated AUTO-050 assessment and accepted AUTO-060 identities into
an HMAC-bound, one-hour repository-fake qualification plan. Three distinct single-purpose logical service identities and
eight canonical scenarios model policy high-water, database-boundary time, terminal revocation convergence, serializable
claim uniqueness, external checkpoint CAS, restore rollback detection, and post-marker ambiguity. The private in-process
fake accepts no collaborator ports. Its authenticated report is re-derived on every parse, exposes only transcript
digests, and always retains all nine blockers and zero qualified proofs. The public projection omits authentication,
identity, evidence, protected material, and controls and makes every production capability false.

**Why:** AUTO-060 can authenticate fixture evidence but cannot safely jump straight to a hosted environment. The next
boundary must first make the distributed-state and custody claims precise and make their negative paths reproducible.
Calling this output a fake qualification, and cryptographically binding that mode into every artifact, prevents a green
repository rehearsal from being mistaken for production proof.

**Alternatives rejected:** Connect to a caller-selected database; accept caller-supplied clock, checkpoint, process, or
adapter callbacks; treat local PGlite or SQLite as hosted PostgreSQL; let a successful rehearsal remove blockers; expose
raw transcripts or identity details; trust a report after only digest/HMAC recomputation; perform a disposable live run
without a separate controlled-effect packet; construct the production consumer in the qualification block.

**Trade-off:** The foundation proves contract completeness and deterministic failure classification, not real process
isolation, hosted database semantics, availability, custody, backup/restore, or operational readiness. A later live
qualification remains a separately owner-authorized controlled effect and must retain sanitized evidence and exact
cleanup. The fake produces no artifact that can be promoted into AUTO-060 production proof.

**Reevaluate:** A fresh independent reviewer must attack the exact committed candidate before acceptance. Any live
database/provider contact, process or worker start, production key or policy enrollment, protected clock/checkpoint read,
credential-store access, live evidence collection, consumer, owner approval, activation, deployment, or effect requires a
new bounded contract and explicit authority.

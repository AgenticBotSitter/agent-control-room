# CR-3 security and trust architecture

**Status:** Accepted 2026-08-22; security requirements are implementation gates
**Security premise:** The repository, schemas, endpoints, and algorithms may all be public.

## Security objective

A person who reads the public repository must not gain authority over a private Control Room installation. Knowing how to form an API request, job envelope, WebSocket message, MCP call, or adapter event is harmless without a valid, scoped, unrevoked identity and an operation permitted independently by central and node-local policy.

Security is layered because no single mechanism—Cloudflare, Tailscale, a password manager, Docker, a signature, or an AI permission prompt—is sufficient.

## Trust zones

| Zone | Examples | Default trust |
|---|---|---|
| Public internet | arbitrary clients, scanners, forged webhooks | none |
| Edge access | Cloudflare Tunnel, Access, rate limits | authenticated transport/front-door signal only |
| Control plane | dashboard/API/scheduler on VPS | trusted to coordinate within policy; assumed compromiseable |
| Data authority | PostgreSQL and backup system | high-value restricted service |
| Node bridge | enrolled Mac/Windows/Linux/VPS service | trusted only to its registered ceilings |
| Harness/executor | Hermes, Codex, Claude, FFmpeg, scripts | job-scoped and potentially prompt-influenced |
| Project/source | Content Blooms, Wayfarer, websites, GitHub | authoritative only for declared domains |
| Artifact/content | webpages, prompts, repos, media, model output | untrusted data |
| Owner authority | authenticated owner session and strong approval factor | highest human authority, still scoped and audited |

## Minimize entry points

### Internet-facing paths permitted in v1

1. Dashboard/API/MCP through Cloudflare Tunnel on HTTPS.
2. Explicit webhook routes with provider-specific verification and narrow verbs.
3. No direct PostgreSQL, Docker daemon, Hermes dashboard, SSH, node bridge, or worker tool ports.

The Hostinger firewall and Ubuntu firewall default-deny inbound traffic. If Cloudflare Tunnel is used, Control Room does not require a public origin port. SSH administration should be key-based and restricted through the chosen management path; it is not part of the Control Room application protocol.

### Outbound-only workers

Nodes connect to the protected Control Room endpoint. The server never dials arbitrary node ports. This:

- works behind home NAT;
- avoids opening Mac or Windows firewalls;
- reduces VPN conflicts;
- avoids exposing harness dashboards;
- gives one revocable server-side connection registry.

Tailscale can protect native-console access and emergency administration, but tailnet membership never grants a Control Room role. A node can operate without Tailscale if outbound HTTPS works.

## Identity planes

The following identities are deliberately separate:

- human owner;
- owner approval credential;
- Control Room server/service;
- node/device;
- node runtime/worker slot;
- harness installation;
- agent profile;
- project adapter;
- external service account;
- secret-provider credential.

Editable names are labels. Authorization uses immutable IDs and versioned grants.

## Owner authentication

### Ordinary access

- Cloudflare Access authenticates the human at the edge.
- The application validates the Access JWT issuer, audience, signature, expiry, and identity rather than trusting the presence of a header.
- The application creates a short session with CSRF protection, secure cookies, origin checks, and role/scope lookup.

### Consequential approval

Publishing, spending, deploying production code, rotating secrets, enrolling nodes, expanding policy, and destructive operations require step-up confirmation. The approval record includes:

- exact operation digest;
- target and environment;
- cost/destructive/external-effect classification;
- expiry and single-use nonce;
- requesting actor and workflow lineage;
- approving actor and strong-factor evidence.

The ordinary online Control Room dispatch key cannot create this evidence. The implementation must support a separately protected owner approval factor, such as WebAuthn/passkey-backed confirmation. Telegram may notify and deep-link to the approval but is not the sole factor for high-risk actions.

### Recovery

- Break-glass instructions are offline and tested.
- Recovery material is stored separately from the VPS.
- Break-glass use rotates sessions and relevant credentials and creates a critical audit event.

## Node enrollment and authentication

1. Owner creates a 15-minute, single-use enrollment token constrained to a node class.
2. The node generates its private/public key pair locally.
3. It sends the token, public key, platform facts, and attestation metadata over TLS.
4. Control Room registers the immutable node ID and returns its initial grant and server trust material.
5. The enrollment token is irreversibly consumed.
6. The private key remains in the OS keystore or a comparably protected node store.

Every application message carries a version, node ID, message ID, timestamp, nonce, and body digest and is authenticated by the enrolled node. The server rejects expired timestamps, repeated nonces/message IDs, unknown versions, revoked keys, invalid signatures, oversized frames, and rate-limit violations.

Cloudflare service tokens may add an outer machine-authentication layer. They do not replace Control Room node identity because they are symmetric credentials and may be shared accidentally.

## Job authority envelope

Every accepted job has an immutable envelope:

```yaml
job_id: opaque-id
project_id: opaque-id
workflow_version: immutable-version
operation: media.ffmpeg.assemble
allowed_targets: [artifact-prefix]
allowed_tools: [ffmpeg]
credential_refs: [youtube.staging-uploader]
network_policy: destination-allowlist
filesystem_policy: worktree-and-scratch-only
resource_budget: {cpu: 4, gpu_slots: 0, memory_mb: 8192, scratch_mb: 50000}
time_budget_seconds: 7200
cost_budget_usd: 0
approval_requirement: production-publish
expires_at: timestamp
parent_authority_digest: digest
```

The node rejects any field above its local ceiling. Child jobs receive the intersection of parent authority, project policy, node policy, and explicit child policy. Authority can narrow but never expand through delegation.

## Compromised Control Room containment

Signing server-issued work proves origin but does not protect against compromise of that server's signing key. The real containment controls are:

- node-local immutable maximum scopes;
- local tool, path, destination, spend, and environment allowlists;
- local denial of untrusted risk classes;
- job expiry, nonces, and replay rejection;
- separately protected owner approval for consequential effects;
- destination-level permissions and idempotency;
- rapid node quarantine and credential revocation.

A compromised server may still observe metadata and request actions within existing ceilings. The architecture promises blast-radius containment, not magical safety after total compromise.

## Secret handling

Control Room stores only logical credential references and safe policy metadata.

```text
central job contains credential_ref
  -> authorized node broker resolves it just in time
  -> secret enters only the child process environment/stdin/native API
  -> child exits
  -> value is discarded and redacted from output
```

Requirements:

- Bitwarden and 1Password implement a common node-local broker interface.
- The ordinary central API has no plaintext secret-return endpoint.
- Secret values never appear in prompts, command arguments, URLs, logs, database rows, audit metadata, Telegram, or artifacts.
- Per-node/provider credentials are distinct, least-privilege, expiring when practical, and independently revocable.
- Redaction runs before persistence and again before transport.
- Rotation and provider failure are observable service states.

## Harness and executor safety

### Risk classes

| Class | Example | Minimum posture |
|---|---|---|
| R0 read-only | inspect repo/status | scoped filesystem, no secret, restricted network |
| R1 bounded write | edit isolated worktree, render scratch output | worktree/scratch only, resource limits, artifact validation |
| R2 external reversible | create branch, staging deploy, upload draft | destination-scoped credential, idempotency, audit |
| R3 consequential | production deploy/publish, spend, delete, rotate | strong owner approval and deterministic preflight |
| R4 untrusted code | third-party executable/plugin | hardened isolated executor or reject/reroute |

Mac and Windows initially accept trusted first-party R0–R3 work subject to policy. R4 routes only to a proven hardened Linux executor or an approved hosted sandbox.

### No general remote shell

The node bridge exposes typed executors. An administrator may use SSH/Tailscale separately for maintenance, but Control Room jobs cannot turn a typed executor into arbitrary shell execution unless a deliberately enabled, tightly scoped shell executor exists for that node and risk class.

### Prompt injection

Webpages, repository instructions, files, emails, comments, media metadata, tool output, and agent messages are untrusted. They may suggest work but cannot grant tools, credentials, policy changes, approvals, or new destinations. Deterministic policy checks occur outside the model context.

## Adapter and plugin security

- Adapters run under dedicated service identities with least privilege.
- Manifest capabilities are declarations, not proof; conformance tests and benchmarks establish verification.
- Unsupported protocol versions fail closed.
- Browser plugins cannot receive central device credentials or inject arbitrary JavaScript in v1.
- User-installed adapter packages require an allowlisted source, pinned version/digest, license record, and explicit enablement.
- Adapter crashes are isolated from the scheduler and recorded as safe failure codes.
- Project adapters can act only within their declared authority mode.

## API and webhook defenses

- TLS everywhere outside loopback/private container networks.
- Request body and frame size limits.
- Strict schema validation and unknown-field policy.
- Per-identity rate limits and connection quotas.
- Idempotency keys on every mutation.
- Optimistic expected versions for state transitions.
- Nonces and bounded replay windows for signed node messages.
- CSRF protection for browser mutations.
- SSRF protection: adapters cannot request arbitrary URLs; destinations are resolved through allowlisted connectors.
- Webhook-specific signature/secret verification before parsing business content.
- No secrets or signed artifact URLs in query strings.
- Safe error codes externally; detailed errors remain local and redacted.

## Data and audit controls

- Separate database roles for migrations, application writes, read-only operations, and backup.
- PostgreSQL is not internet-accessible.
- Tenant/workspace/project scope is included in every query contract; row-level security is a defense-in-depth target before multi-user hosting.
- Append-only audit and command/event records reject ordinary updates/deletes.
- Audit rows form a hash chain by tenant/time partition; periodic signed heads are stored outside the database for tamper evidence.
- Backups and WAL archives are encrypted, access-scoped, integrity-checked, and restored in drills.
- Retention policies distinguish metadata, logs, metrics, artifacts, and backups.

## Supply-chain controls

- Exact dependency versions and lockfiles.
- Automated vulnerability, secret, license, and SBOM checks.
- Pinned container image digests for production.
- Minimal base images and non-root application users where compatible.
- No public Docker daemon socket; Docker socket access is root-equivalent and unavailable to agent jobs.
- Signed releases and upgrade manifests before public distribution.
- Upgrade rings: disposable/test node, one canary node, then broader fleet.
- Adapter protocol fixtures rerun on harness upgrades.

## Revocation and incident response

The owner can independently:

- drain or quarantine a node;
- revoke its node key and Cloudflare service token;
- revoke its password-manager machine/service account;
- stop new leases while preserving evidence;
- invalidate sessions and approval nonces;
- quarantine artifacts by producer/time window;
- disable an adapter, executor, project, schedule, or destination;
- rotate server and external credentials.

Quarantine is preferable to deletion during an incident. Recovery requires reconciliation of leased jobs and ambiguous external effects.

## Security acceptance gates

Before any live integration:

- threat-model review completed;
- public endpoint inventory contains only approved paths;
- Access JWT validation and application authorization tests pass;
- forged, replayed, expired, oversized, cross-tenant, and revoked-node requests fail;
- node refuses authority beyond its local ceiling;
- child authority cannot exceed parent;
- high-risk action cannot proceed with Telegram identity alone;
- secret canary never appears in database, logs, events, prompts, or artifacts;
- database and Docker ports are unreachable from the internet;
- backup restore and node reconciliation succeed;
- dependency/SBOM/license/security scans pass;
- documented rollback and kill-switch drills pass.

## Security non-goals for v1

- Byzantine consensus among mutually hostile nodes.
- Running arbitrary hostile code safely on personal Mac/Windows machines.
- High-availability automatic database failover.
- Multi-tenant public SaaS operation.
- Replacing the security models of Hermes, Codex, Claude Code, GitHub, Cloudflare, or password managers.

The interfaces preserve future improvements without pretending they already exist.

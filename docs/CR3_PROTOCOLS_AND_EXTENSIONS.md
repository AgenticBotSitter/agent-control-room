# CR-3 protocols and extension architecture

**Status:** Proposed  
**Goal:** Make projects, harnesses, machines, providers, and user interfaces replaceable without weakening lifecycle or security guarantees.

## Contract-first rule

Control Room owns canonical lifecycle contracts. An adapter translates a foreign system into those contracts; it does not redefine the global lifecycle. All contracts are versioned, schema-validated, capability-negotiated, idempotent where mutating, and accompanied by conformance fixtures.

## Protocol families

| Protocol | Direction | Purpose | Not used for |
|---|---|---|---|
| Owner HTTP/UI | owner ↔ Control Room | administration, review, approval, settings | worker execution transport |
| Northbound MCP | coding/agent client ↔ Control Room | request creation, delegation, inspection, artifact/result retrieval | leases, secrets, raw database access |
| Node HTTPS/WSS | node bridge ↔ Control Room | enrollment, heartbeat, claim, lifecycle events, cancellation, reconciliation | general remote shell |
| Project adapter HTTP | source project ↔ Control Room | sanitized projections and scoped source commands | harness lifecycle |
| Harness adapter local API | node bridge ↔ harness | start, stream, steer, pause, resume, cancel, usage | global project truth |
| Infrastructure adapters | Control Room/node ↔ provider | artifacts, notifications, secrets, monitors, Git | global scheduling authority |

## Standard envelope

Every cross-boundary message has the equivalent of:

```json
{
  "protocol": "control-room-node/v1",
  "messageId": "opaque-unique-id",
  "correlationId": "opaque-trace-id",
  "causationId": "prior-message-id",
  "actorId": "immutable-id",
  "tenantId": "immutable-id",
  "sentAt": "RFC3339 timestamp",
  "expiresAt": "RFC3339 timestamp",
  "nonce": "unique-random-value",
  "type": "job.event",
  "bodyDigest": "sha256:...",
  "body": {},
  "signature": "provider-specific-authentication"
}
```

Private payload fields never become audit metadata. Unknown required versions fail closed; additive optional fields may be ignored only when the negotiated contract permits it.

## Node protocol

### Connection sequence

1. Resolve the configured Control Room HTTPS endpoint.
2. Establish TLS and the optional Cloudflare service-auth layer.
3. Authenticate the enrolled node through challenge/response.
4. Negotiate protocol versions, features, maximum frame size, compression, and heartbeat interval.
5. Submit the last acknowledged server sequence and unresolved attempt summaries.
6. Reconcile before the node becomes schedulable.
7. Maintain heartbeats with resources, capacity, and safe health state.

### Commands from server to node

- `node.policy.apply`
- `node.discovery.request`
- `capability.probe.request`
- `benchmark.request`
- `job.offer`
- `job.cancel`
- `job.steer`
- `approval.resolved`
- `node.drain`
- `node.quarantine`
- `adapter.upgrade.offer`

### Events from node to server

- `node.heartbeat`
- `node.inventory.observed`
- `capability.observed`
- `benchmark.completed`
- `job.offer.accepted|rejected`
- `job.started|progress|checkpointed|waiting|completed|failed|cancelled`
- `artifact.declared|uploaded|verified`
- `effect.intent.started|confirmed|ambiguous`
- `policy.denied`
- `node.incident`
- `node.reconciliation.report`

Job offers are not assignments until the node atomically accepts a lease. A rejection includes safe reason codes such as capacity, policy, version, storage, credential-unresolvable, maintenance, or benchmark-expired.

### Delivery semantics

- At-least-once message delivery.
- Idempotent mutation by message/idempotency key.
- Monotonic per-connection sequence plus durable message IDs across reconnect.
- Lease epoch prevents an old owner from completing a reassigned attempt silently.
- Progress events may be sampled; lifecycle transitions and effect receipts are durable.
- Backpressure is explicit. Nodes may drop nonessential telemetry only according to policy.

## Node capability discovery

Discovery is layered:

1. **Static facts:** OS, architecture, CPU, physical RAM, GPU/VRAM, volumes, network class.
2. **Dynamic facts:** free RAM, free scratch, load, thermals where available, battery/power, GPU utilization, connectivity.
3. **Software facts:** executables, versions, harness profiles, runtime libraries, container/WSL availability.
4. **Declared capabilities:** adapter/executor says what it could perform.
5. **Verified capabilities:** a versioned probe or benchmark proves the route.
6. **Observed performance:** production-safe history updates duration, reliability, quality, and cost estimates.

Hardware discovery never grants authority. A capable node may remain ineligible because its software, benchmark, credential, policy, trust, availability, or resources do not satisfy the job.

Discovery runs on enrollment, bridge upgrade, material hardware/software fingerprint change, operator request, and anomaly trigger. Dynamic telemetry runs periodically with bounded retention.

## Harness adapter contract

Each harness adapter implements only supported lifecycle verbs:

```ts
interface HarnessAdapter {
  manifest(): HarnessManifest;
  discoverProfiles(): Promise<ProfileSummary[]>;
  start(input: StartTurn): Promise<TurnHandle>;
  events(handle: TurnHandle, cursor?: string): AsyncIterable<HarnessEvent>;
  steer?(handle: TurnHandle, input: SteerInput): Promise<Receipt>;
  answer?(handle: TurnHandle, input: AnswerInput): Promise<Receipt>;
  cancel(handle: TurnHandle): Promise<Receipt>;
  resume?(session: SessionReference): Promise<TurnHandle>;
  usage(handle: TurnHandle): Promise<UsageSummary>;
  health(): Promise<AdapterHealth>;
}
```

The manifest declares:

- adapter and harness version;
- supported OS/runtime versions;
- supported lifecycle verbs;
- event schema version;
- approval capabilities;
- isolation expectations;
- credential resolution modes;
- required local permissions;
- supported output/artifact forms;
- license and distribution status.

Unsupported verbs are explicit, never simulated deceptively.

### Hermes v1 seam

- Spawn a pinned Hermes process and speak `tui_gateway` newline-delimited JSON-RPC over stdio for the execution lifecycle.
- Read normalized machine/profile/session/cron/usage information from the authenticated read-only `hermes serve` routes.
- Treat event WebSockets as live observability, not the audit authority.
- Store protocol fixtures by supported Hermes commit/version and run them during upgrades.
- Keep Kanban local to Hermes and expose only projections or scoped commands.

### Codex v1 seam

- Begin with the tested `codex exec --json` wrapper for the first conformance slice.
- Preserve thread ID, working directory/worktree, configured sandbox, structured events, usage, final output, file changes, tests, and patch/commit reference.
- Evaluate the TypeScript SDK as the normal seam only after lifecycle equivalence tests prove an advantage.
- Keep app-server experimental and version-gated.
- A separate northbound MCP connection lets a user-driven Codex task delegate through Control Room.

### Claude Code v1 seam

- Use the pinned CLI `stream-json --verbose` subprocess seam first.
- Do not enable the adapter until an authenticated lifecycle acceptance test passes.
- Treat the Python/TypeScript SDKs as optional secondary seams for SDK-only hooks or permission callbacks.
- Require users to install/license the Claude Code runtime; do not redistribute it.

## Deterministic executor contract

Executors describe typed operations rather than accepting arbitrary shell strings:

```ts
interface ExecutorAdapter {
  manifest(): ExecutorManifest;
  validate(input: unknown, envelope: AuthorityEnvelope): ValidationResult;
  estimate(input: unknown, node: ResourceSnapshot): Promise<Estimate>;
  run(input: unknown, context: ScopedRunContext): AsyncIterable<ExecutorEvent>;
  cancel(attemptId: string): Promise<Receipt>;
  verify(output: ArtifactManifest[]): Promise<VerificationResult>;
}
```

Initial executors include Git/worktree, test command, HTTP health check, checksum/artifact transfer, FFmpeg/media probe, and safe script templates. Unreal and other heavy project-specific executors plug in later.

## Project adapter contract

The existing `control-room-project-adapter/v1` remains valid for projections and source commands. CR-3 adds optional project-pack interfaces for Control Room-native work:

- request schemas and templates;
- workflow definition/version compilation;
- domain-specific job types;
- dependency and review rules;
- required capabilities and benchmark standards;
- artifact schemas and retention;
- safe preview renderers;
- project-specific verification and completion criteria.

A project pack never receives core database access or silently expands node policy. Its workflow output is validated before activation.

## Northbound MCP contract

Initial tools should remain small and typed:

- `projects.list`
- `workers.list`
- `requests.create`
- `requests.get`
- `workflow.propose`
- `workflow.activate` (approval/policy controlled)
- `jobs.delegate`
- `jobs.status`
- `attention.list`
- `approval.request`
- `artifact.get_manifest`
- `result.get`

MCP responses contain sanitized operational data and artifact references, not secret values or unrestricted storage paths. A client receives an identity and scope; the MCP model itself does not decide authorization.

## Secret-provider contract

The central interface manages references and resolvability:

```ts
interface CredentialCatalog {
  describe(ref: CredentialRef): Promise<SafeCredentialMetadata>;
  eligibleNodes(ref: CredentialRef): Promise<NodeId[]>;
}
```

Only the node-local broker may resolve/inject:

```ts
interface NodeSecretBroker {
  canResolve(ref: CredentialRef, job: AuthorityEnvelope): Promise<boolean>;
  runInjected(refs: CredentialRef[], invocation: TypedInvocation): Promise<ProcessHandle>;
}
```

There is intentionally no central `getSecret()` contract.

## Artifact contract

The database stores a manifest:

- artifact ID, project/workflow/job/attempt lineage;
- content hash and size;
- MIME/media properties;
- logical role and schema version;
- producer and verification status;
- storage class and opaque locator;
- retention and quarantine state;
- safe preview reference generated on demand.

Large bytes move directly between the authorized node and local/R2 storage using short-lived, object-scoped transfers. Signed URLs are never persisted or logged.

## Notification and review contract

Notifications separate event urgency from delivery preferences:

- informational digest;
- action requested;
- job blocked;
- security/availability incident;
- emergency.

Preferences define channels, quiet hours, escalation, grouping, and allowed Telegram actions. A button contains an opaque single-use action token bound to the recipient, attention item, allowed decision, expiry, and operation digest.

Review items support still images, video/audio previews, diffs, test reports, AI reviewer comments, owner decisions, and revision notes. AI review is evidence; it cannot impersonate owner approval.

## Adapter conformance kit

Every adapter type ships with:

- JSON Schemas and generated types;
- golden sanitized fixtures;
- lifecycle simulator;
- replay/idempotency tests;
- disconnect/cancel/restart tests;
- forbidden-content/redaction tests;
- version negotiation tests;
- capability and unsupported-operation tests;
- security and scope tests;
- license/SBOM manifest requirements.

The public project can accept community adapters without making their code part of the trusted core. Certification levels are `unverified`, `community-tested`, and `core-certified`.

## Versioning and compatibility

- Protocol names include a major version.
- Additive fields require explicit optional semantics.
- Breaking changes get a new major contract or compatibility adapter.
- The server publishes supported and deprecated ranges.
- Nodes reject a server below their minimum secure version.
- Security revocations can disable a specific adapter/runtime version immediately.
- Upgrade canaries and fixture replays precede fleet rollout.

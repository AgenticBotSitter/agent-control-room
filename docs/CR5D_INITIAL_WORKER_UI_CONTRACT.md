# CR-5D initial worker and evidence UI contract

**Status:** Architect-frozen for bounded implementation  
**Decision date:** 2026-08-26  
**Scope:** Effect-free, presentational CR-5D components for artifact evidence, synthetic execution events, and worker operations  
**Authority:** These components display server-resolved state and can request an operation through a callback. They do not decide authority, mutate canonical state, execute an operation, or claim independent verification.

## Outcome

The initial worker UI is split into three independent components so qualified workers can implement them in parallel without touching the dashboard, backend, security policy, or one another's files. Codex will integrate the accepted components after the executor and evidence modules pass.

All components are client-safe presentational React components. They must render supplied values as text, must not use `dangerouslySetInnerHTML`, and must not read storage, network, environment variables, credentials, timers, random values, or wall time.

## 1. Artifact evidence card

Implement `app/components/artifact-evidence-card.tsx` and export:

```ts
interface ArtifactEvidenceCardModelV1 {
  schema: "control-room.artifact-evidence-card/v1";
  artifactId: string;
  logicalRole: string;
  state: "declared" | "available" | "verified" | "rejected" | "expired";
  mimeType: string;
  byteSize: number;
  contentHash: string;
  createdAt: string;
  locatorAvailable: boolean;
  producerClaim: {
    claimId: string;
    producerId: string;
    claim: "content_hash_matches_exact_bytes";
    contentHash: string;
    manifestDigest: string;
    claimDigest: string;
    createdAt: string;
  };
  independentVerification:
    | { state: "not_run" }
    | { state: "passed" | "failed" | "blocked" | "inconclusive"; verifierId: string; observedAt: string };
}

function ArtifactEvidenceCard(props: { model: ArtifactEvidenceCardModelV1 }): React.JSX.Element;
```

The card must:

- label three distinct sections `Artifact manifest`, `Producer claim`, and `Independent verification`;
- show the logical role, artifact ID, state, MIME type, exact byte count, content hash, created time, producer, claim ID, claim type, manifest digest, and claim digest;
- show only `Locator recorded` or `No locator recorded`, never an opaque locator;
- render `Not run` when independent verification has not occurred;
- never use the words `verified`, `accepted`, or `approved` to characterize the producer claim;
- use semantic headings, definition lists, and a status element that is understandable without color; and
- remain deterministic for identical props.

The component does not recompute hashes, fetch content, inspect a locator, or promote any artifact state.

## 2. Synthetic execution timeline

Implement `app/components/synthetic-execution-timeline.tsx` and export:

```ts
interface SyntheticExecutionTimelineEventV1 {
  sequence: number;
  occurredAt: string;
  event: "started" | "progress" | "checkpointed" | "completed" | "cancelled";
  completedSteps?: number;
  totalSteps?: number;
  progressPercent?: number;
  checkpointId?: string;
  safeReasonCode?: "cancelled";
}

interface SyntheticExecutionTimelineModelV1 {
  schema: "control-room.synthetic-execution-timeline/v1";
  jobId: string;
  attemptId: string;
  events: readonly SyntheticExecutionTimelineEventV1[];
}

function SyntheticExecutionTimeline(props: { model: SyntheticExecutionTimelineModelV1 }): React.JSX.Element;
```

The timeline must:

- render events in the supplied order without sorting or inventing missing events;
- show sequence, event label, occurred time, and the fields applicable to that event;
- distinguish a checkpoint from completion and cancellation from failure;
- show `No execution events recorded` for an empty array;
- use an ordered list with an accessible heading and text status; and
- perform no lifecycle transition, retry, cancellation, polling, or time calculation.

## 3. Worker operation request panel

Implement `app/components/worker-operation-panel.tsx` and export:

```ts
type WorkerOperationRequestV1 = "request_drain" | "request_resume" | "request_quarantine";

interface WorkerOperationPanelModelV1 {
  schema: "control-room.worker-operation-panel/v1";
  workerId: string;
  displayName: string;
  platform: "macos" | "windows" | "linux" | "cloud";
  state: "online" | "idle" | "busy" | "draining" | "degraded" | "offline" | "maintenance" | "quarantined" | "revoked";
  stateReason?: string;
  lastHeartbeatAt: string;
  requests: readonly {
    operation: WorkerOperationRequestV1;
    enabled: boolean;
    reason: string;
  }[];
}

function WorkerOperationPanel(props: {
  model: WorkerOperationPanelModelV1;
  onRequest(operation: WorkerOperationRequestV1): void;
}): React.JSX.Element;
```

The panel must:

- display worker identity, platform, canonical state, state reason, and last heartbeat exactly as supplied;
- label buttons `Request drain`, `Request resume`, and `Request quarantine`;
- render only operations present in `requests`, respect `enabled`, and expose each supplied reason as visible text;
- call `onRequest` exactly once with the named operation when an enabled button is activated;
- never optimistically change displayed state or render a success confirmation; and
- state that requests remain subject to server authority and confirmation.

The server-resolved model, not this component, determines which requests are legal. The callback is an intent boundary only. Backend command construction, approval, idempotency, authentication, audit, and state mutation are Codex-owned integration work.

## Acceptance

- Focused render tests use `react-dom/server` and prove required labels, values, empty/not-run states, disabled operation states, and safe text escaping.
- TypeScript passes without a new dependency.
- Each implementation changes only its named component and focused test.
- No CSS, dashboard integration, backend route, domain state, policy, protocol, persistence, package, workflow, or architecture file is changed by a worker.

# CR-5D synthetic executor and artifact-evidence contract

**Status:** Architect-frozen for bounded implementation  
**Decision date:** 2026-08-26  
**Scope:** Effect-free synthetic execution, deterministic checkpoints, cancellation, crash simulation, text artifact manifests, and claim-bound verification evidence  
**Authority:** This contract controls the first CR-5D implementation wave. It does not complete CR-5D or authorize a live node, service, credential, deployment, or external effect.

## Outcome

CR-5D begins the first executable vertical slice. The initial implementation has two independent modules:

1. a deterministic synthetic executor that sleeps only through an injected port, emits ordered lifecycle/checkpoint events, accepts cancellation, and can simulate a crash; and
2. an artifact/evidence builder that hashes exact UTF-8 bytes, creates the existing canonical `ArtifactManifestRecord`, and produces a separate claim bound to that manifest and content.

The modules do not choose policy, read a lease, touch the bridge journal, send protocol frames, or perform I/O. Codex integrates them with admission, the bridge, persistence, and UI after their contracts pass independently.

## 1. Synthetic executor

Implement `src/node-executor/synthetic-executor.ts` with these public shapes:

```ts
interface SyntheticExecutionSpecV1 {
  schema: "control-room.synthetic-execution/v1";
  jobId: string;
  attemptId: string;
  steps: number;
  checkpointEverySteps: number;
  stepDelayMilliseconds: number;
  artifactText: string;
  crashAfterStep?: number;
}

interface SyntheticExecutionPortsV1 {
  signal: AbortSignal;
  now(): string;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  emit(event: SyntheticExecutionEventV1): void | Promise<void>;
}

type SyntheticExecutionEventV1 = {
  schema: "control-room.synthetic-execution-event/v1";
  jobId: string;
  attemptId: string;
  sequence: number;
  occurredAt: string;
} & (
  | { event: "started" }
  | { event: "progress"; completedSteps: number; totalSteps: number; progressPercent: number }
  | { event: "checkpointed"; completedSteps: number; checkpointId: string }
  | { event: "completed"; completedSteps: number }
  | { event: "cancelled"; completedSteps: number; safeReasonCode: "cancelled" }
);

type SyntheticExecutionResultV1 =
  | { state: "succeeded"; completedSteps: number; artifactBytes: Uint8Array; checkpointIds: string[] }
  | { state: "cancelled"; completedSteps: number; checkpointIds: string[]; safeReasonCode: "cancelled" };

class SyntheticExecutorCrash extends Error {
  readonly safeFailureCode = "synthetic_crash";
  readonly completedSteps: number;
}

function runSyntheticExecution(
  spec: SyntheticExecutionSpecV1,
  ports: SyntheticExecutionPortsV1,
): Promise<SyntheticExecutionResultV1>;
```

### Validation

- Unknown or missing schema denies.
- `jobId` and `attemptId` are non-empty, at most 200 characters, and contain no whitespace or control characters.
- `steps` is an integer from 1 through 100.
- `checkpointEverySteps` is an integer from 1 through `steps`.
- `stepDelayMilliseconds` is an integer from 0 through 60,000.
- `artifactText` encodes to at most 65,536 UTF-8 bytes and passes the repository secret-material guard.
- `crashAfterStep`, when present, is an integer from 1 through `steps`.
- Invalid input throws before calling any injected port.

### Execution

- Check `signal.aborted` before `started`, before each sleep, and immediately after each sleep.
- Cancellation emits one terminal `cancelled` event and returns no artifact.
- Emit `started` first, then one `progress` event after each completed step.
- `progressPercent` is the integer floor of `(completedSteps * 100) / steps`; the final value is 100.
- Emit a checkpoint after every exact multiple of `checkpointEverySteps` and after the final step if it was not already checkpointed.
- Checkpoint IDs are exactly `checkpoint:<attemptId>:<completedSteps>` and are returned in emission order.
- Event sequence begins at 1 and increases by one across every emitted event.
- Call `now()` once per emitted event; never read wall time directly.
- If `crashAfterStep` equals the completed step, throw `SyntheticExecutorCrash` after its progress event and before a checkpoint or artifact is produced.
- On success, emit `completed` after the final checkpoint and return `Buffer.from(artifactText, "utf8")` as `artifactBytes`.
- Do not catch or relabel failures from `sleep`, `now`, or `emit`; the integration layer owns failure classification.

The executor may not access filesystem, network, environment variables, subprocesses, credentials, timers, random identifiers, platform APIs, or persistent state.

## 2. Text artifact and verification claim

Implement `src/node-executor/artifact-evidence.ts` with:

```ts
interface TextArtifactBundleInputV1 {
  artifactId: string;
  claimId: string;
  tenantId: string;
  projectId: string;
  workflowId?: string;
  jobId: string;
  attemptId: string;
  producerId: string;
  logicalRole: string;
  schemaVersion: string;
  storageClass: "local" | "r2" | "repository" | "external";
  retentionClass: string;
  opaqueLocator?: string;
  text: string;
  createdAt: string;
}

interface ArtifactVerificationClaimV1 {
  schema: "control-room.artifact-verification-claim/v1";
  claimId: string;
  artifactId: string;
  tenantId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  producerId: string;
  claim: "content_hash_matches_exact_bytes";
  contentHash: string;
  manifestDigest: string;
  createdAt: string;
  claimDigest: string;
}

interface TextArtifactBundleV1 {
  bytes: Uint8Array;
  manifest: ArtifactManifestRecord;
  verificationClaim: ArtifactVerificationClaimV1;
}

function buildTextArtifactBundle(input: TextArtifactBundleInputV1): TextArtifactBundleV1;
```

### Construction

- Validate every required identifier as non-empty, at most 200 characters, and free of whitespace/control characters.
- Validate `createdAt` as a canonical RFC 3339 UTC string that round-trips through `new Date(value).toISOString()`.
- Reject text larger than 65,536 UTF-8 bytes.
- Reject an empty logical role, schema version, or retention class.
- `opaqueLocator`, when supplied, is non-empty and passes the secret-material guard; it is never copied into the verification claim.
- `bytes` is the exact UTF-8 encoding of `text`.
- `contentHash` is `sha256:<lowercase hex>` over the exact bytes, not canonical JSON.
- The manifest uses the existing `control-room-domain/v1` `ArtifactManifestRecord`, version 0, state `declared`, MIME type `text/plain; charset=utf-8`, exact byte length, and identical created/updated timestamps.
- `manifestDigest` is the repository canonical `sha256Digest(manifest)`.
- `claimDigest` is `sha256Digest()` over every claim field except `claimDigest` itself.
- The claim is producer evidence, not an independent verification pass. It never contains `verified`, `accepted`, or an approval field.
- Manifest and claim pass the repository secret-material guard before return.

This module performs no storage upload, file write, network request, database mutation, signing, approval, or verification decision.

## 3. Integration boundary

The next Codex-owned integration slice will:

- resolve the typed spec after local admission;
- map synthetic lifecycle events to `JobEventBody` under the active lease identity;
- persist checkpoints and attempt state in the bridge journal;
- store bytes through an explicit artifact storage adapter;
- publish the manifest ID separately from the verification claim;
- request safe cancellation on lease/authority expiry; and
- simulate restart recovery without claiming exactly-once execution.

Neither worker module may implement those responsibilities early.

## Acceptance

- Deterministic unit tests cover validation, ordered events, progress, checkpoint cadence, cancellation before start and during sleep, exact crash boundary, success bytes, hashes, manifest/claim separation, secret rejection, and input immutability.
- Tests use injected ports and temporary in-memory data only.
- TypeScript and focused tests pass.
- No effect, install, download, service, native platform operation, credential access, or production mutation occurs.

import {
  PUBLIC_OBSERVATION_CONTRACT_V1,
  PUBLIC_OBSERVATION_EVENT_V1,
  observationEventSchemaV1,
  sha256DigestV1,
  type ObservationEventV1,
} from "@control-room/public-core";
import {
  OBSERVATION_ADAPTER_SDK_VERSION_V1,
  defineObservationAdapterV1,
  type ObservationAdapterV1,
  type ObservationFixtureV1,
} from "@control-room/observation-adapter-sdk";
import { type ObservationConformanceCaseV1 } from "@control-room/conformance-kit";

type SyntheticFrame = { readonly kind: string; readonly count?: number; readonly inputTokens?: number; readonly outputTokens?: number; };

function event(adapterId: string, frame: SyntheticFrame, context: { tenantId: string; runId: string; sequence: number; occurredAt: string }): ObservationEventV1 {
  const payload = frame.kind.endsWith("usage")
    ? { category: "usage" as const, inputTokens: frame.inputTokens ?? 0, outputTokens: frame.outputTokens ?? 0, cachedInputTokens: 0, reasoningTokens: 0 }
    : frame.kind.endsWith("checkpoint")
      ? { category: "activity" as const, activity: "checkpoint" as const, phase: "observed" as const, count: frame.count ?? 0 }
      : { category: "transport" as const, state: "connected" as const };
  return observationEventSchemaV1.parse({ schemaVersion: PUBLIC_OBSERVATION_EVENT_V1, tenantId: context.tenantId, runId: context.runId,
    sequence: context.sequence, occurredAt: context.occurredAt, source: "adapter", sourceEventKeyDigest: sha256DigestV1({ adapterId, runId: context.runId, sequence: context.sequence, kind: frame.kind }), payload });
}

function syntheticAdapter(adapterId: string, harness: "hermes" | "codex" | "example", acceptedKinds: readonly string[]): ObservationAdapterV1 {
  return defineObservationAdapterV1({
    sdkVersion: OBSERVATION_ADAPTER_SDK_VERSION_V1,
    manifest: {
      schemaVersion: PUBLIC_OBSERVATION_CONTRACT_V1, adapterId, adapterVersion: "0.1.0", harness, harnessVersion: "0.0.0-synthetic",
      harnessRevision: "0000000000000000000000000000000000000000", runtime: { name: "synthetic", minimumVersion: "0.1.0", supportedPlatforms: ["linux", "macos", "windows"] },
      observationKinds: ["discover", "stream", "usage"], eventSchemaVersion: PUBLIC_OBSERVATION_EVENT_V1, effectAuthority: "none", accessMode: "none",
      outputForms: ["structured_events", "usage"], license: "Apache-2.0", distribution: "redistributable",
    },
    evaluateCompatibility: (evidence) => ({ compatible: Boolean(evidence && typeof evidence === "object" && (evidence as { synthetic?: unknown }).synthetic === true), reasons: evidence && typeof evidence === "object" && (evidence as { synthetic?: unknown }).synthetic === true ? [] : ["synthetic_only"] }),
    normalizeObservation: (frame, context) => {
      if (!frame || typeof frame !== "object" || Array.isArray(frame) || !acceptedKinds.includes((frame as SyntheticFrame).kind)) throw new TypeError("synthetic frame invalid");
      return { events: [event(adapterId, frame as SyntheticFrame, context)] };
    },
  });
}

/** Fabricated Hermes-shaped frames, deliberately disconnected from any installation. */
export const syntheticHermesObservationAdapterV1 = syntheticAdapter("adapter.reference.hermes.synthetic.v1", "hermes", ["synthetic.hermes.ready", "synthetic.hermes.checkpoint", "synthetic.hermes.usage"]);
/** Fabricated Codex-shaped frames, deliberately disconnected from any installation. */
export const syntheticCodexObservationAdapterV1 = syntheticAdapter("adapter.reference.codex.synthetic.v1", "codex", ["synthetic.codex.ready", "synthetic.codex.checkpoint", "synthetic.codex.usage"]);
/** A generic example for downstream authors. */
export const syntheticExampleObservationAdapterV1 = syntheticAdapter("adapter.reference.example.synthetic.v1", "example", ["synthetic.example.ready", "synthetic.example.checkpoint", "synthetic.example.usage"]);

const context = { tenantId: "tenant.synthetic.v1", runId: "run.synthetic.v1", sequence: 1, occurredAt: "2026-01-01T00:00:00.000Z" } as const;
function fixture(name: string, kind: string, sequence = 1): ObservationFixtureV1 { return { name, frame: { kind }, context: { ...context, sequence }, expectedEventCount: 1 }; }

export const syntheticReferenceConformanceCasesV1: readonly ObservationConformanceCaseV1[] = Object.freeze([
  { caseId: "reference.hermes.synthetic.v1", adapter: syntheticHermesObservationAdapterV1, compatibilityEvidence: { synthetic: true }, fixtures: [fixture("hermes ready", "synthetic.hermes.ready"), fixture("hermes checkpoint", "synthetic.hermes.checkpoint", 2)] },
  { caseId: "reference.codex.synthetic.v1", adapter: syntheticCodexObservationAdapterV1, compatibilityEvidence: { synthetic: true }, fixtures: [fixture("codex ready", "synthetic.codex.ready"), fixture("codex usage", "synthetic.codex.usage", 2)] },
  { caseId: "reference.example.synthetic.v1", adapter: syntheticExampleObservationAdapterV1, compatibilityEvidence: { synthetic: true }, fixtures: [fixture("example ready", "synthetic.example.ready")] },
]);

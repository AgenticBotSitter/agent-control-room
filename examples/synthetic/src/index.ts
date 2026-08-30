import { runObservationConformanceKitV1 } from "@control-room/conformance-kit";
import { syntheticReferenceConformanceCasesV1 } from "@control-room/synthetic-reference-adapters";

export const SYNTHETIC_EXAMPLE_VERSION_V1 = "control-room-synthetic-example/v1" as const;

/** Runs only repository-defined fabricated fixtures and returns a non-authorizing summary. */
export function runSyntheticControlRoomExampleV1() {
  const conformance = runObservationConformanceKitV1(syntheticReferenceConformanceCasesV1);
  return Object.freeze({
    exampleVersion: SYNTHETIC_EXAMPLE_VERSION_V1,
    tenantId: "tenant.synthetic.public.v1",
    projectId: "project.synthetic.public.v1",
    runId: "run.synthetic.public.v1",
    dataProfile: "fabricated_only" as const,
    storageMode: "memory_only" as const,
    networkMode: "disabled" as const,
    effectAuthority: "none" as const,
    conformance,
    installedHarnessContacted: false as const,
    providerContacted: false as const,
    grantsOperationAuthority: false as const,
  });
}

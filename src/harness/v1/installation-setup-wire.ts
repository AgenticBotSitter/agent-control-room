import { z } from "zod";
import type { InstallationGuidanceStepV1 } from "./installation-guidance";
import type { InstallationProofStateV1 } from "./installation-readiness";
import type { LocalHarnessCapabilityV1 } from "./local-harness-capabilities";
import type { InstallationTransitionSummaryV1 } from "./installation-transition-summary";

// Browser-safe parsing only: no runtime imports from private projection builders.
type Proof = "local_owner_qualification" | "local_runner_bridge" | "remote_enrollment" | "two_computer_delivery" | "backup_restore";
type Overall = "not_ready" | "blocked" | "ready_for_owner_enablement";
const text = z.string().min(1).max(1_000);
const proof = z.enum(["local_owner_qualification", "local_runner_bridge", "remote_enrollment", "two_computer_delivery", "backup_restore"]);
const state = z.enum(["not_started", "passed", "failed", "unavailable"]);
const operation = z.enum(["supported", "unsupported", "unknown"]);
const capability = z.object({ id: z.enum(["hermes", "claude", "codex"]), label: text,
  state: z.enum(["setup_required", "setup_needs_attention", "owner_enablement_required", "not_available"]), stateLabel: text,
  summary: text, firstSupportedWork: text, safeNow: text, sourceOnly: text, remainingSetupCategory: text, nextStep: text,
  operations: z.object({ submit: operation, result: operation, cancel: operation, read: operation }).strict() }).strict();
const guidance = z.object({ proof: proof.optional(), state: z.enum(["next", "complete", "blocked"]), title: text, detail: text }).strict();
const transition = z.object({ state: z.enum(["not_started", "prepared", "admission_paused", "drained", "proofs_verified", "committed", "failed", "rollback_ready", "rolled_back"]),
  affectedWorkerCount: z.number().int().min(0).max(200), ownerMessage: text, nextStep: text,
  canEnableWorkers: z.literal(false), canRelocateAuthority: z.literal(false) }).strict();

export type InstallationSetupViewV1 = Readonly<{
  mode: "this_computer" | "several_computers";
  overallState: Overall;
  nextProof?: Proof;
  backupEvidencePending: boolean;
  proofs: readonly Readonly<{ proof: Proof; state: InstallationProofStateV1 }>[];
  guidance: readonly InstallationGuidanceStepV1[];
  localCapabilities?: readonly LocalHarnessCapabilityV1[];
  localService?: Readonly<{ state: "not_started" | "readiness_recorded" | "blocked";
    proofs: readonly Readonly<{ proof: "private_configuration_custody" | "restricted_launch_definition" | "restart_and_drain_procedure" | "upgrade_and_rollback_procedure"; state: InstallationProofStateV1 }>[] }>;
  transition: InstallationTransitionSummaryV1;
}>;

const setupSchema = z.object({ mode: z.enum(["this_computer", "several_computers"]), overallState: z.enum(["not_ready", "blocked", "ready_for_owner_enablement"]),
  nextProof: proof.optional(), backupEvidencePending: z.boolean(), proofs: z.array(z.object({ proof, state }).strict()).max(5),
  guidance: z.array(guidance).max(5), localCapabilities: z.array(capability).length(3).optional(),
  localService: z.object({ state: z.enum(["not_started", "readiness_recorded", "blocked"]),
    proofs: z.array(z.object({ proof: z.enum(["private_configuration_custody", "restricted_launch_definition", "restart_and_drain_procedure", "upgrade_and_rollback_procedure"]), state }).strict()).length(4) }).strict().optional(),
  transition }).strict();

/** Parses the deliberately redacted browser payload. Raw plan IDs, route
 * digests, readiness fingerprints and worker-proof records are never valid
 * in this shape. */
export function parseInstallationSetupViewV1(value: unknown): InstallationSetupViewV1 {
  const parsed = setupSchema.parse(value);
  return Object.freeze({ ...parsed, proofs: Object.freeze(parsed.proofs.map(item => Object.freeze({ ...item }))),
    guidance: Object.freeze(parsed.guidance.map(item => Object.freeze({ ...item }))),
    ...(parsed.localCapabilities ? { localCapabilities: Object.freeze(parsed.localCapabilities.map(item => Object.freeze({ ...item, operations: Object.freeze({ ...item.operations }) }))) } : {}),
    ...(parsed.localService ? { localService: Object.freeze({ ...parsed.localService,
      proofs: Object.freeze(parsed.localService.proofs.map(item => Object.freeze({ ...item }))) }) } : {}),
    transition: Object.freeze({ ...parsed.transition }) });
}

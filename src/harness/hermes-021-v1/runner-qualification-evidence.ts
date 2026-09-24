import { z } from "zod";
import { types } from "node:util";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationTopologyPlanV1 } from "../v1/installation-topology";
import { HERMES_021_SOURCE_REVISION_V1, HERMES_021_VERSION_V1 } from "./connector-profile";
import { hermes021MacosLocalBindingSchemaV1 } from "./macos-local-worker";
import { captureHermes021MacosSubprocessHostConfigurationV1 } from "./subprocess-stream-json-host";

export const HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1 =
  "control-room.hermes-021-macos-local-runner-qualification-report/v1" as const;
export const HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_EVIDENCE_V1 =
  "control-room.hermes-021-macos-local-runner-qualification-evidence/v1" as const;
export const HERMES_021_MACOS_INSTALLATION_BOUND_RUNNER_QUALIFICATION_EVIDENCE_V1 =
  "control-room.hermes-021-macos-installation-bound-runner-qualification-evidence/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const installationId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u);

/** Sanitized output of the owner-run fixed-argument runner check. */
export const hermes021MacosLocalRunnerQualificationReportSchemaV1 = z.object({
  schema: z.literal(HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1),
  qualified: z.boolean(),
  terminalResultObserved: z.boolean(),
  sessionDigest: digest.nullable(),
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  totalTokens: count.nullable(),
  durationMs: count.nullable(),
  failureReason: z.enum(["none", "owner_configuration_invalid", "runner_bridge_unavailable", "terminal_result_unexpected"]),
  retryRequiresFreshOwnerAuthorization: z.boolean(),
}).strict();

const successfulReport = hermes021MacosLocalRunnerQualificationReportSchemaV1.superRefine((value, context) => {
  if (!value.qualified || !value.terminalResultObserved || !value.sessionDigest || value.inputTokens === null
    || value.outputTokens === null || value.totalTokens === null || value.durationMs === null
    || value.totalTokens < value.inputTokens + value.outputTokens || value.failureReason !== "none"
    || value.retryRequiresFreshOwnerAuthorization) context.addIssue({ code: "custom", message: "runner qualification did not pass" });
});

/** Converts the successful sanitized bridge report into a plan-safe fingerprint. */
export function createHermes021MacosLocalRunnerQualificationEvidenceV1(value: unknown) {
  const report = successfulReport.parse(value);
  return Object.freeze({ schema: HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_EVIDENCE_V1,
    evidenceDigest: sha256Digest({ schema: HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_EVIDENCE_V1, report }) });
}

const installationBoundEvidenceSchema = z.object({
  schema: z.literal(HERMES_021_MACOS_INSTALLATION_BOUND_RUNNER_QUALIFICATION_EVIDENCE_V1),
  installationId,
  releaseDigest: digest,
  topologyPlanDigest: digest,
  workerBindingDigest: digest,
  runnerConfigurationDigest: digest,
  runnerQualificationDigest: digest,
  evidenceDigest: digest,
  startsHermes: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict();

export type Hermes021MacosInstallationBoundRunnerQualificationEvidenceV1 =
  Readonly<z.infer<typeof installationBoundEvidenceSchema>>;

type InstallationBoundEvidenceInput = Readonly<{
  installationId: string;
  releaseDigest: string;
  topologyPlan: unknown;
  workerBinding: unknown;
  runnerConfiguration: unknown;
  runnerQualificationReport: unknown;
}>;

const boundUnavailable = (): never => {
  const error = new Error("hermes_021_macos_installation_bound_runner_qualification_evidence_unavailable");
  error.stack = undefined;
  throw error;
};

function exactBoundInput(value: unknown): InstallationBoundEvidenceInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return boundUnavailable();
  const names = ["installationId", "releaseDigest", "topologyPlan", "workerBinding", "runnerConfiguration",
    "runnerQualificationReport"] as const;
  const actual = Object.getOwnPropertyNames(value);
  if (actual.length !== names.length || actual.some(name => !names.includes(name as typeof names[number]))) return boundUnavailable();
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return boundUnavailable();
  }
  return value as InstallationBoundEvidenceInput;
}

export function hermes021MacosRunnerConfigurationDigestV1(value: unknown): string {
  try {
    return sha256Digest({ purpose: "hermes-021-protected-runner-configuration/v1",
      configuration: captureHermes021MacosSubprocessHostConfigurationV1(value) });
  } catch { return boundUnavailable(); }
}

/**
 * Creates the qualification evidence retained by the protected owner host.
 * Unlike the public-safe report fingerprint, this evidence binds the exact
 * installation, release, topology, worker and runner configuration observed
 * for the attended check. It still contains no path, profile, model, provider,
 * workspace, session or callable execution port.
 */
export function createHermes021MacosInstallationBoundRunnerQualificationEvidenceV1(inputValue: unknown):
Hermes021MacosInstallationBoundRunnerQualificationEvidenceV1 {
  try {
    const input = exactBoundInput(inputValue);
    const plan = verifyInstallationTopologyPlanV1(input.topologyPlan);
    const binding = hermes021MacosLocalBindingSchemaV1.parse(input.workerBinding);
    if (binding.expectedVersion !== HERMES_021_VERSION_V1
      || binding.sourceRevision !== HERMES_021_SOURCE_REVISION_V1) return boundUnavailable();
    const qualification = createHermes021MacosLocalRunnerQualificationEvidenceV1(input.runnerQualificationReport);
    const material = { schema: HERMES_021_MACOS_INSTALLATION_BOUND_RUNNER_QUALIFICATION_EVIDENCE_V1,
      installationId: installationId.parse(input.installationId), releaseDigest: digest.parse(input.releaseDigest),
      topologyPlanDigest: plan.planDigest, workerBindingDigest: sha256Digest(binding),
      runnerConfigurationDigest: hermes021MacosRunnerConfigurationDigestV1(input.runnerConfiguration),
      runnerQualificationDigest: qualification.evidenceDigest,
      startsHermes: false as const, grantsExecutionAuthority: false as const };
    return Object.freeze(installationBoundEvidenceSchema.parse({ ...material,
      evidenceDigest: sha256Digest({ purpose: "hermes-021-installation-bound-runner-qualification/v1",
        evidence: material }) }));
  } catch { return boundUnavailable(); }
}

export function verifyHermes021MacosInstallationBoundRunnerQualificationEvidenceV1(value: unknown,
  currentInput: unknown): Hermes021MacosInstallationBoundRunnerQualificationEvidenceV1 {
  try {
    const parsed = installationBoundEvidenceSchema.parse(value);
    const expected = createHermes021MacosInstallationBoundRunnerQualificationEvidenceV1(currentInput);
    if (canonicalJson(parsed) !== canonicalJson(expected)) return boundUnavailable();
    return expected;
  } catch { return boundUnavailable(); }
}

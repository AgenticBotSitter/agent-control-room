import { z } from "zod";
import { types } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationTopologyPlanV1 } from "../v1/installation-topology";
import { HERMES_021_SOURCE_REVISION_V1, HERMES_021_VERSION_V1 } from "./connector-profile";
import { hermes021MacosLocalBindingSchemaV1, hermes021MacosTerminalResultSchemaV1 } from "./macos-local-worker";
import { captureHermes021MacosSubprocessHostConfigurationV1,
  consumeHermes021MacosOwnerQualificationHostV1,
  createHermes021MacosOwnerAuthorizedLocalOnlyRunnerV1 } from "./subprocess-stream-json-host";
import { captureHermes021MacosReviewedExecutableIdentityV1,
  hermes021MacosReviewedExecutableIdentityDigestV1 } from "./reviewed-executable-identity";

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
  reviewedExecutableIdentityDigest: digest,
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
  reviewedExecutableIdentity: unknown;
  runnerQualificationReport: unknown;
}>;

type OwnerAttendedQualificationInput = Omit<InstallationBoundEvidenceInput, "runnerQualificationReport">;

const installationBoundEvidenceProvenance = new WeakMap<object, Readonly<{
  evidence: Hermes021MacosInstallationBoundRunnerQualificationEvidenceV1;
  report: z.infer<typeof hermes021MacosLocalRunnerQualificationReportSchemaV1>;
}>>();
const qualifiedRunnerCapabilities = new WeakMap<object, Readonly<{
  installationId: string;
  releaseDigest: string;
  topologyPlan: unknown;
  workerBinding: unknown;
  runnerConfiguration: unknown;
  reviewedExecutableIdentity: unknown;
  evidence: Hermes021MacosInstallationBoundRunnerQualificationEvidenceV1;
}>>();

const boundUnavailable = (): never => {
  const error = new Error("hermes_021_macos_installation_bound_runner_qualification_evidence_unavailable");
  error.stack = undefined;
  throw error;
};

function exactBoundInput(value: unknown): InstallationBoundEvidenceInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return boundUnavailable();
  const names = ["installationId", "releaseDigest", "topologyPlan", "workerBinding", "runnerConfiguration",
    "reviewedExecutableIdentity", "runnerQualificationReport"] as const;
  const actual = Object.getOwnPropertyNames(value);
  if (actual.length !== names.length || actual.some(name => !names.includes(name as typeof names[number]))) return boundUnavailable();
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return boundUnavailable();
  }
  return value as InstallationBoundEvidenceInput;
}

function exactProcedureInput(value: unknown): OwnerAttendedQualificationInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return boundUnavailable();
  const names = ["installationId", "releaseDigest", "topologyPlan", "workerBinding", "runnerConfiguration",
    "reviewedExecutableIdentity"] as const;
  const actual = Object.getOwnPropertyNames(value);
  if (actual.length !== names.length || actual.some(name => !names.includes(name as typeof names[number]))) return boundUnavailable();
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return boundUnavailable();
  }
  return value as OwnerAttendedQualificationInput;
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
function materialFor(inputValue: unknown) {
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
    reviewedExecutableIdentityDigest: hermes021MacosReviewedExecutableIdentityDigestV1(input.reviewedExecutableIdentity),
    runnerQualificationDigest: qualification.evidenceDigest,
    startsHermes: false as const, grantsExecutionAuthority: false as const };
  return Object.freeze({ input, material });
}

function sanitizedSuccessfulReport(terminalValue: unknown, expectedText: string) {
  const terminal = hermes021MacosTerminalResultSchemaV1.parse(terminalValue);
  if (terminal.exit_code !== 0 || terminal.text !== expectedText
    || terminal.tokens.total < terminal.tokens.input + terminal.tokens.output) return boundUnavailable();
  return Object.freeze({ schema: HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1,
    qualified: true as const, terminalResultObserved: true as const,
    sessionDigest: `sha256:${createHash("sha256").update(terminal.session_id).digest("hex")}`,
    inputTokens: terminal.tokens.input, outputTokens: terminal.tokens.output, totalTokens: terminal.tokens.total,
    durationMs: terminal.duration_ms, failureReason: "none" as const,
    retryRequiresFreshOwnerAuthorization: false as const });
}

/**
 * The only source boundary that can mint installation-bound qualification
 * evidence. It parses and captures the exact runner and worker before calling
 * the owner-attended execution port, creates the sanitized report itself from
 * the returned terminal record, and retains process-local provenance. A saved
 * report or a structurally identical evidence object cannot be rebound later.
 */
export async function runHermes021MacosInstallationBoundRunnerQualificationV1(inputValue: unknown,
  ownerQualificationHostValue: unknown): Promise<Readonly<{ report: z.infer<typeof hermes021MacosLocalRunnerQualificationReportSchemaV1>;
    evidence: Hermes021MacosInstallationBoundRunnerQualificationEvidenceV1;
    runnerCapability: object }>> {
  try {
    const input = exactProcedureInput(inputValue);
    const plan = verifyInstallationTopologyPlanV1(input.topologyPlan);
    const binding = hermes021MacosLocalBindingSchemaV1.parse(input.workerBinding);
    if (binding.expectedVersion !== HERMES_021_VERSION_V1
      || binding.sourceRevision !== HERMES_021_SOURCE_REVISION_V1) return boundUnavailable();
    const configuration = captureHermes021MacosSubprocessHostConfigurationV1(input.runnerConfiguration);
    const reviewedExecutableIdentity = captureHermes021MacosReviewedExecutableIdentityV1(
      input.reviewedExecutableIdentity);
    const host = consumeHermes021MacosOwnerQualificationHostV1(ownerQualificationHostValue);
    if (canonicalJson(host.configuration) !== canonicalJson(configuration)
      || canonicalJson(host.reviewedExecutableIdentity) !== canonicalJson(reviewedExecutableIdentity)) return boundUnavailable();
    const expectedText = `CONTROL_ROOM_HERMES_RUNNER_${randomBytes(16).toString("hex")}`;
    const lines = await host.qualify(expectedText);
    const terminals = lines.map(value => hermes021MacosTerminalResultSchemaV1.safeParse(value))
      .filter(result => result.success).map(result => result.data);
    if (terminals.length !== 1) return boundUnavailable();
    const terminal = terminals[0];
    const report = sanitizedSuccessfulReport(terminal, expectedText);
    const bound = materialFor({ installationId: input.installationId, releaseDigest: input.releaseDigest,
      topologyPlan: plan, workerBinding: binding, runnerConfiguration: configuration,
      reviewedExecutableIdentity,
      runnerQualificationReport: report });
    const evidence = Object.freeze(installationBoundEvidenceSchema.parse({ ...bound.material,
      evidenceDigest: sha256Digest({ purpose: "hermes-021-installation-bound-runner-qualification/v1",
        evidence: bound.material }) }));
    installationBoundEvidenceProvenance.set(evidence, Object.freeze({ evidence, report }));
    const runnerCapability = Object.freeze({ schema: "control-room.hermes-021-macos-qualified-runner-capability/v1" });
    qualifiedRunnerCapabilities.set(runnerCapability, Object.freeze({ installationId: input.installationId,
      releaseDigest: input.releaseDigest, topologyPlan: plan, workerBinding: binding,
      runnerConfiguration: configuration, reviewedExecutableIdentity, evidence }));
    return Object.freeze({ report, evidence, runnerCapability });
  } catch { return boundUnavailable(); }
}

/**
 * Converts the one-use, process-local result of an owner-attended
 * qualification into the bounded local runner used by installed delivery.
 * It deliberately needs the current installation-plan digest and revision:
 * a qualification from an earlier installation state cannot be carried into
 * a changed controller.  The capability is not serializable and is consumed
 * once, so a restart requires a fresh owner-attended qualification.
 */
export function consumeHermes021MacosQualifiedOwnerRunnerV1(inputValue: unknown): object {
  try {
    const input = exactRunnerEnablementInput(inputValue);
    const capability = input.runnerCapability as object;
    const captured = qualifiedRunnerCapabilities.get(capability);
    if (!captured || !qualifiedRunnerCapabilities.delete(capability)) return boundUnavailable();
    const topology = verifyInstallationTopologyPlanV1(input.topologyPlan);
    const workerBinding = hermes021MacosLocalBindingSchemaV1.parse(input.workerBinding);
    const configuration = captureHermes021MacosSubprocessHostConfigurationV1(input.runnerConfiguration);
    if (input.installationId !== captured.installationId || input.releaseDigest !== captured.releaseDigest
      || canonicalJson(topology) !== canonicalJson(captured.topologyPlan)
      || canonicalJson(workerBinding) !== canonicalJson(captured.workerBinding)
      || canonicalJson(configuration) !== canonicalJson(captured.runnerConfiguration)) return boundUnavailable();
    const evidence = verifyHermes021MacosInstallationBoundRunnerQualificationEvidenceV1(input.evidence, {
      installationId: input.installationId, releaseDigest: input.releaseDigest, topologyPlan: topology,
      workerBinding, runnerConfiguration: configuration,
      reviewedExecutableIdentity: captured.reviewedExecutableIdentity,
      runnerQualificationReport: installationBoundEvidenceProvenance.get(captured.evidence)?.report,
    });
    if (canonicalJson(evidence) !== canonicalJson(captured.evidence)) return boundUnavailable();
    return createHermes021MacosOwnerAuthorizedLocalOnlyRunnerV1({ installationId: input.installationId,
      installationPlanDigest: input.installationPlanDigest, installationPlanRevision: input.installationPlanRevision,
      topologyPlanDigest: topology.planDigest, releaseDigest: input.releaseDigest, workerBinding,
      runnerConfiguration: configuration, reviewedExecutableIdentity: captured.reviewedExecutableIdentity });
  } catch { return boundUnavailable(); }
}

function exactRunnerEnablementInput(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return boundUnavailable();
  const names = ["runnerCapability", "installationId", "installationPlanDigest", "installationPlanRevision",
    "releaseDigest", "topologyPlan", "workerBinding", "runnerConfiguration", "evidence"] as const;
  const actual = Object.getOwnPropertyNames(value);
  if (actual.length !== names.length || actual.some(name => !names.includes(name as typeof names[number]))) return boundUnavailable();
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return boundUnavailable();
  }
  if (typeof (value as Record<string, unknown>).installationId !== "string"
    || typeof (value as Record<string, unknown>).installationPlanDigest !== "string"
    || !Number.isSafeInteger((value as Record<string, unknown>).installationPlanRevision)
    || (value as Record<string, unknown>).installationPlanRevision as number < 0
    || typeof (value as Record<string, unknown>).releaseDigest !== "string") return boundUnavailable();
  return value as Readonly<Record<string, unknown>>;
}

export function verifyHermes021MacosInstallationBoundRunnerQualificationEvidenceV1(value: unknown,
  currentInput: unknown): Hermes021MacosInstallationBoundRunnerQualificationEvidenceV1 {
  try {
    const parsed = installationBoundEvidenceSchema.parse(value);
    const provenance = value && typeof value === "object" && !types.isProxy(value)
      ? installationBoundEvidenceProvenance.get(value) : undefined;
    const supplied = exactBoundInput(currentInput);
    if (!provenance || supplied.runnerQualificationReport !== provenance.report
      || canonicalJson(parsed) !== canonicalJson(provenance.evidence)) return boundUnavailable();
    const expected = materialFor(supplied);
    const expectedEvidence = installationBoundEvidenceSchema.parse({ ...expected.material,
      evidenceDigest: sha256Digest({ purpose: "hermes-021-installation-bound-runner-qualification/v1",
        evidence: expected.material }) });
    if (canonicalJson(parsed) !== canonicalJson(expectedEvidence)) return boundUnavailable();
    return provenance.evidence;
  } catch { return boundUnavailable(); }
}

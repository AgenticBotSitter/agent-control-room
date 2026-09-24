import { verifyInstallationTopologyPlanV1 } from "../../harness/v1/installation-topology";
import { hermes021MacosLocalBindingSchemaV1 } from "../../harness/hermes-021-v1/macos-local-worker";
import { consumeHermes021MacosQualifiedOwnerRunnerV1,
  runHermes021MacosInstallationBoundRunnerQualificationV1 } from "../../harness/hermes-021-v1/runner-qualification-evidence";
import { reviewHermes021MacosExecutableV1 } from "../../harness/hermes-021-v1/reviewed-executable-identity";
import { createHermes021MacosOwnerAuthorizedUnsealedQualificationHostV1,
  captureHermes021MacosSubprocessHostConfigurationV1 } from "../../harness/hermes-021-v1/subprocess-stream-json-host";
import type { PrivateLocalHermesAdmissionRunnerContextV1 } from "./private-local-hermes-admission-runner";

/**
 * Builds the owner-host-only qualification operation from already-captured
 * installed data. Construction is inert. The one native Hermes qualification
 * occurs only when the existing attended setup stage calls `qualify`.
 */
export const PRIVATE_LOCAL_HERMES_OWNER_QUALIFICATION_RUNTIME_V1 =
  "control-room.private-local-hermes-owner-qualification-runtime/v1" as const;

const refused = (): never => {
  const error = new Error("private_local_hermes_owner_qualification_runtime_refused");
  error.stack = undefined; throw error;
};
const digest = /^sha256:[a-f0-9]{64}$/u;
const qualificationRuntimes = new WeakMap<object, Readonly<{
  qualify(context: PrivateLocalHermesAdmissionRunnerContextV1): Promise<object>;
}>>();

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key)) || names.some(name => !keys.includes(name))) return refused();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
  }
  return value as Readonly<Record<string, unknown>>;
}

/** The returned closure retains private runner information and yields only an
 * opaque qualified runner. It never exposes the command, profile, model,
 * provider, working folder, or executable fingerprint. */
export function createPrivateLocalHermesOwnerQualificationRuntimeV1(value: unknown): Readonly<{
  schema: typeof PRIVATE_LOCAL_HERMES_OWNER_QUALIFICATION_RUNTIME_V1;
  qualify(context: PrivateLocalHermesAdmissionRunnerContextV1): Promise<object>;
}> {
  const input = exact(value, ["installationId", "installationPlanDigest", "installationPlanRevision", "releaseDigest",
    "topologyPlan", "workerBinding", "runnerConfiguration", "reviewedExecutableSha256"]);
  if (typeof input.installationId !== "string" || typeof input.installationPlanRevision !== "number"
    || !Number.isSafeInteger(input.installationPlanRevision) || input.installationPlanRevision < 0
    || [input.installationPlanDigest, input.releaseDigest, input.reviewedExecutableSha256]
      .some(item => typeof item !== "string" || !digest.test(item))) return refused();
  const topology = verifyInstallationTopologyPlanV1(input.topologyPlan);
  const workerBinding = hermes021MacosLocalBindingSchemaV1.parse(input.workerBinding);
  const runnerConfiguration = captureHermes021MacosSubprocessHostConfigurationV1(input.runnerConfiguration);
  let spent = false;
  const runtime = Object.freeze({ schema: PRIVATE_LOCAL_HERMES_OWNER_QUALIFICATION_RUNTIME_V1,
    async qualify(context: PrivateLocalHermesAdmissionRunnerContextV1): Promise<object> {
      if (spent || context.signal.aborted || context.installationId !== input.installationId
        || context.installationPlanDigest !== input.installationPlanDigest
        || context.installationPlanRevision !== input.installationPlanRevision
        || context.releaseDigest !== input.releaseDigest || context.topologyPlanDigest !== topology.planDigest) return refused();
      // Burn before native work. A missing response is uncertainty to the
      // caller, never an invitation to send another qualification turn.
      spent = true;
      const review = await reviewHermes021MacosExecutableV1({ executablePath: runnerConfiguration.executablePath,
        executableSha256: input.reviewedExecutableSha256 });
      const host = await createHermes021MacosOwnerAuthorizedUnsealedQualificationHostV1(runnerConfiguration, review.capability);
      const qualified = await runHermes021MacosInstallationBoundRunnerQualificationV1({ installationId: input.installationId,
        releaseDigest: input.releaseDigest, topologyPlan: topology, workerBinding, runnerConfiguration,
        reviewedExecutableIdentity: review.record }, host);
      return consumeHermes021MacosQualifiedOwnerRunnerV1({ runnerCapability: qualified.runnerCapability,
        installationId: input.installationId, installationPlanDigest: input.installationPlanDigest,
        installationPlanRevision: input.installationPlanRevision, releaseDigest: input.releaseDigest,
        topologyPlan: topology, workerBinding, runnerConfiguration, evidence: qualified.evidence });
    } });
  qualificationRuntimes.set(runtime, Object.freeze({ qualify: runtime.qualify }));
  return runtime;
}

/** Only the owner-host runtime minted above can perform qualification. A
 * copied lookalike or arbitrary callback never reaches the native turn. */
export function qualifyPrivateLocalHermesOwnerQualificationRuntimeV1(runtime: unknown,
  context: PrivateLocalHermesAdmissionRunnerContextV1): Promise<object> {
  if (!runtime || typeof runtime !== "object") return Promise.reject(refused());
  const captured = qualificationRuntimes.get(runtime);
  if (!captured) return Promise.reject(refused());
  return captured.qualify(context);
}

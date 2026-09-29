import { types } from "node:util";
import { sha256Digest } from "../../security/canonical-digest";
import { consumePrivateInstalledConfigurationV3PostWriteActivationEvidenceV1 } from
  "./private-installed-configuration-v3-owner-writer";
import { privatePostgresRouteReadinessAggregateFingerprintV1,
  verifyPrivatePostgresRouteReadinessSourceAssessmentV1 } from
  "./private-postgres-route-readiness-aggregate";

/**
 * Protected composition for the future owner-attended database-route probe.
 *
 * It consumes only the opaque post-write installation capability and the
 * process-local route aggregate. It accepts no endpoint, certificate, role,
 * credential, path, callback, command, or evidence digest. The concrete
 * native route observer does not exist yet, so an authentic composition stays
 * explicitly blocked and its owner boundary cannot mint readiness.
 */
export const PRIVATE_POSTGRES_ROUTE_OWNER_RUNNER_COMPOSITION_V1 =
  "control-room.private-postgres-route-owner-runner-composition/v1" as const;
export const PRIVATE_POSTGRES_ROUTE_OWNER_RUNNER_REQUEST_V1 =
  "control-room.private-postgres-route-owner-runner-request/v1" as const;
export const PRIVATE_POSTGRES_ROUTE_OWNER_RUNNER_REPORT_V1 =
  "control-room.private-postgres-route-owner-runner-report/v1" as const;

export type PrivatePostgresRouteOwnerRunnerReportV1 = Readonly<{
  schema: typeof PRIVATE_POSTGRES_ROUTE_OWNER_RUNNER_REPORT_V1;
  status: "blocked";
  blocker: "protected_postgres_route_native_host_missing";
  sourceBindingDigest: string;
  capabilityMinted: false;
  retryRequiresFreshOwnerAuthorization: true;
  containsCredentialValue: false;
  containsPrivatePath: false;
  containsEndpoint: false;
  containsCertificate: false;
  readsProtectedConfiguration: false;
  opensDatabase: false;
  usesNetwork: false;
  changesRoute: false;
  changesCertificate: false;
  startsService: false;
}>;

export type PrivatePostgresRouteOwnerRunnerV1 = Readonly<{
  schema: typeof PRIVATE_POSTGRES_ROUTE_OWNER_RUNNER_COMPOSITION_V1;
  status: "blocked";
  blocker: "protected_postgres_route_native_host_missing";
  oneUse: true;
  acceptsEndpoint: false;
  acceptsCertificate: false;
  acceptsRole: false;
  acceptsCredential: false;
  acceptsCallback: false;
  performsEffectOnConstruction: false;
  run(request: Readonly<{
    schema: typeof PRIVATE_POSTGRES_ROUTE_OWNER_RUNNER_REQUEST_V1;
    ownerAttended: true;
    signal: AbortSignal;
    deadlineUnixMs: number;
  }>): Promise<PrivatePostgresRouteOwnerRunnerReportV1>;
}>;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;

function refused(): never {
  const error = new Error("private_postgres_route_owner_runner_composition_refused");
  error.stack = undefined;
  throw error;
}

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) refused();
  const record = value as Readonly<Record<string, unknown>>, keys = Object.getOwnPropertyNames(record);
  if (keys.length !== names.length || keys.some(key => !names.includes(key)) || names.some(name => !keys.includes(name))) refused();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) refused();
  }
  return record;
}

function request(value: unknown) {
  const input = exact(value, ["schema", "ownerAttended", "signal", "deadlineUnixMs"]);
  if (input.schema !== PRIVATE_POSTGRES_ROUTE_OWNER_RUNNER_REQUEST_V1 || input.ownerAttended !== true
    || !(input.signal instanceof AbortSignal) || input.signal.aborted || !Number.isSafeInteger(input.deadlineUnixMs)) refused();
  const remaining = (input.deadlineUnixMs as number) - Date.now();
  if (remaining <= 0 || remaining > 30_000) refused();
}

/**
 * Consumes authentic installed-configuration evidence before exposing the
 * explicit owner boundary. A structural capability cannot reach even this
 * blocked runner. The route observer will be wired only after its reviewed
 * native custody exists.
 */
export function createPrivatePostgresRouteOwnerRunnerV1(inputValue: unknown): PrivatePostgresRouteOwnerRunnerV1 {
  const input = exact(inputValue, ["schema", "aggregate", "sourceAssessment",
    "installedConfigurationActivationEvidence"]);
  if (input.schema !== PRIVATE_POSTGRES_ROUTE_OWNER_RUNNER_COMPOSITION_V1) refused();
  const assessment = verifyPrivatePostgresRouteReadinessSourceAssessmentV1(input.aggregate, input.sourceAssessment);
  const installed = consumePrivateInstalledConfigurationV3PostWriteActivationEvidenceV1(
    input.installedConfigurationActivationEvidence);
  if (assessment.installationId !== installed.installationId || assessment.releaseDigest !== installed.releaseDigest
    || assessment.topologyPlanDigest !== installed.topologyPlanDigest) refused();
  for (const name of ["planDigest", "publicationEvidenceDigest", "configurationSha256", "manifestSha256"] as const)
    if (typeof installed[name] !== "string" || !digestPattern.test(installed[name])) refused();
  const sourceBindingDigest = sha256Digest({ purpose: "private-postgres-route-owner-runner-source-binding/v1",
    aggregateFingerprint: privatePostgresRouteReadinessAggregateFingerprintV1(input.aggregate),
    installationId: installed.installationId, releaseDigest: installed.releaseDigest,
    topologyPlanDigest: installed.topologyPlanDigest, planDigest: installed.planDigest,
    publicationEvidenceDigest: installed.publicationEvidenceDigest,
    configurationSha256: installed.configurationSha256, manifestSha256: installed.manifestSha256 });
  let spent = false;
  return Object.freeze({ schema: PRIVATE_POSTGRES_ROUTE_OWNER_RUNNER_COMPOSITION_V1,
    status: "blocked" as const, blocker: "protected_postgres_route_native_host_missing" as const,
    oneUse: true as const, acceptsEndpoint: false as const, acceptsCertificate: false as const,
    acceptsRole: false as const, acceptsCredential: false as const, acceptsCallback: false as const,
    performsEffectOnConstruction: false as const,
    async run(value: unknown) {
      if (spent) refused();
      request(value); spent = true;
      return Object.freeze({ schema: PRIVATE_POSTGRES_ROUTE_OWNER_RUNNER_REPORT_V1,
        status: "blocked" as const, blocker: "protected_postgres_route_native_host_missing" as const,
        sourceBindingDigest, capabilityMinted: false as const, retryRequiresFreshOwnerAuthorization: true as const,
        containsCredentialValue: false as const, containsPrivatePath: false as const, containsEndpoint: false as const,
        containsCertificate: false as const, readsProtectedConfiguration: false as const, opensDatabase: false as const,
        usesNetwork: false as const, changesRoute: false as const, changesCertificate: false as const,
        startsService: false as const });
    } });
}

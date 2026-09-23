import assert from "node:assert/strict";
import test from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2,
  PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1 } from
  "../src/installer/v1/private-installed-configuration-custody";
import { composePrivateInstalledConfigurationPublicationV1,
  privateInstalledPostgresEndpointFingerprintV1,
  preparePrivateInstalledConfigurationV1,
  preflightPrivateInstalledConfigurationPreparationV1,
  PRIVATE_INSTALLED_CONFIGURATION_PREPARATION_V1,
  PRIVATE_INSTALLED_CONFIGURATION_PUBLICATION_V1 } from
  "../src/installer/v1/private-installed-configuration-preparation";
import { PRIVATE_INSTALLED_LOCAL_HERMES_CONFIGURATION_V1 } from
  "../src/installer/v1/private-installed-local-hermes-runtime-composer";
import { preflightPrivateInstalledOwnerHostInputCompositionV1,
  PRIVATE_INSTALLED_OWNER_HOST_INPUT_COMPOSITION_V1 } from
  "../src/installer/v1/private-installed-owner-host-input-composition";
import { sha256Digest } from "../src/security/canonical-digest";

const d = (value: unknown) => sha256Digest(value);
const root = "/Users/example-owner/Library/Application Support/Agent Control Room/Protected";

function source() {
  const databaseEndpoint = { host: "private-authority.invalid", port: 5432,
    database: "control_room" as const, majorVersion: 17 as const };
  const databaseAuthority = {
    provider: "postgresql" as const, majorVersion: 17 as const, database: "control_room" as const,
    networkClass: "private_network" as const, databaseAuthorityDigest: d("database-authority"),
    targetIdentityDigest: d("database-target"), endpointFingerprint: privateInstalledPostgresEndpointFingerprintV1(databaseEndpoint),
    credentialReferenceFingerprint: d("owner-secret-reference"),
    privateRouteEvidenceDigest: d("reviewed-private-route"),
  };
  const topologyPlan = planInstallationTopologyV1({ databaseAuthorityDigest: databaseAuthority.databaseAuthorityDigest,
    schedulerAuthorityDigest: d("scheduler"), currentRoutes: [], requestedRoutes: [] });
  const releaseDigest = d("release");
  const nativeSidecar = {
    schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1,
    releaseVersion: "0.1.0", portableReleaseManifestSha256: releaseDigest,
    outerLauncherManifestSha256: d("outer"), sidecarManifestSha256: d("sidecar"),
    archiveSha256: d("archive"), artifactManifestSha256: d("artifact"), executableSha256: d("executable"),
    platform: "darwin" as const, protocol: "ACRJNL1" as const, architecture: "arm64" as const,
  };
  const privateConfigurationData = {
    schema: PRIVATE_INSTALLED_LOCAL_HERMES_CONFIGURATION_V1,
    installationId: "local-control-room", releaseDigest,
    installedManifestBindingDigest: d("installed-binding"), runtimeIdentityDigest: d("runtime"),
    prerequisiteInput: { installationId: "local-control-room", topologyPlan, releaseDigest,
      releasePreflight: { evidenceDigest: d("release-preflight") },
      privatePlacement: { evidenceDigest: d("private-placement") } },
    settledInstallationPlan: { schema: "control-room.installation-plan/v1", digest: d("plan") },
    hermes: { runnerConfiguration: { executablePath: "/private/owner-held/hermes",
      workingDirectory: "/private/owner-held/workspace", profile: "cr", model: "owner-selected-model",
      provider: "owner-selected-provider" }, taskPolicy: { taskClass: "text_review", tools: "none" } },
    operator: { port: 3210, templateId: "template:hermes-text-review" },
    database: { ...databaseEndpoint,
      roles: { web: "control_room_web", coordinator: "control_room_coordinator", results: "control_room_results",
        evidence: "control_room_evidence", queueWorker: "control_room_queue_worker" }, queueConcurrency: 1 },
    artifactStorage: { local: { rootPath: "/private/owner-held/results" },
      inventory: { storageNamespaceDigest: d("storage") } },
    setupSources: { database_authority: { targetIdentityDigest: databaseAuthority.targetIdentityDigest },
      agent_readiness: { schema: "control-room.private-installed-local-hermes-agent-source/v1" } },
  };
  return { schema: PRIVATE_INSTALLED_CONFIGURATION_PREPARATION_V1, installationId: "local-control-room",
    releaseDigest, standardProtectedRootPath: root, expectedOwnerUid: 501, privateConfigurationData,
    nativeSidecar, databaseAuthority, verificationDeadlineMs: 5_000 };
}

test("prepares one redacted standard-mac plan for the existing configuration and private database authority", () => {
  const input = source(), preflight = preflightPrivateInstalledConfigurationPreparationV1(input);
  assert.deepEqual(preflight, { schema: PRIVATE_INSTALLED_CONFIGURATION_PREPARATION_V1, status: "ready",
    performsEffect: false, writesProtectedFiles: false, readsProtectedFiles: false, opensDatabase: false,
    usesNetwork: false, startsService: false, startsWorker: false });
  const plan = preparePrivateInstalledConfigurationV1(input);
  assert.equal(plan.status, "configuration_plan_ready");
  assert.equal(plan.protectedPlacement.kind, "macos_standard_protected_root");
  assert.equal(plan.configuration.schema, PRIVATE_INSTALLED_LOCAL_HERMES_CONFIGURATION_V1);
  assert.equal(plan.manifest.schema, PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2);
  assert.equal(plan.databaseAuthority.databaseAuthorityDigest, input.databaseAuthority.databaseAuthorityDigest);
  assert.equal(plan.databaseAuthority.networkClass, "private_network");
  assert.equal(plan.performsEffect, false); assert.equal(plan.writesProtectedFiles, false);
  const text = JSON.stringify(plan);
  assert.doesNotMatch(text, /example-owner|private-authority|owner-held|credential:test|postgres(?:ql)?:\/\//iu);
  assert.doesNotMatch(text, /not-allowed|run-me|raw-secret-value|postgres(?:ql)?:\/\//iu);
});

test("private publication returns the exact existing custody input without invoking a port or writing", () => {
  const input = source(), plan = preparePrivateInstalledConfigurationV1(input); let nativeCalls = 0;
  const publication = composePrivateInstalledConfigurationPublicationV1(plan, { native: {
    async verifyProtectedPath() { nativeCalls += 1; return {}; },
  } });
  assert.equal(publication.schema, PRIVATE_INSTALLED_CONFIGURATION_PUBLICATION_V1);
  assert.equal(publication.status, "custody_input_ready");
  assert.equal(publication.performsEffect, false); assert.equal(publication.writesProtectedFiles, false);
  assert.equal(publication.readsProtectedFiles, false); assert.equal(publication.opensDatabase, false);
  assert.equal(publication.usesNetwork, false); assert.equal(publication.invokesNativeVerifier, false);
  assert.equal(nativeCalls, 0);
  assert.equal(publication.manifestPath, `${root}/installed-manifest.json`);
  assert.equal(publication.configurationPath, `${root}/operator.json`);
  assert.equal(publication.journalPath, `${root}/installation-journal`);
  assert.equal(publication.installedConfigurationCustodyInput.schema, PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2);
  assert.equal(publication.installedConfigurationCustodyInput.manifestPath, publication.manifestPath);
  assert.equal(publication.installedConfigurationCustodyInput.expectedOwnerUid, 501);
  const ownerHostPreflight = preflightPrivateInstalledOwnerHostInputCompositionV1({
    schema: PRIVATE_INSTALLED_OWNER_HOST_INPUT_COMPOSITION_V1,
    installedConfigurationCustodyInput: publication.installedConfigurationCustodyInput,
  });
  assert.equal(ownerHostPreflight.status, "blocked");
  assert.equal(ownerHostPreflight.blocker, "staged_journal_sidecar_missing",
    "the prepared input must clear the first owner-host blocker without opening custody");
  assert.deepEqual(JSON.parse(Buffer.from(publication.configurationBytes).toString("utf8")), input.privateConfigurationData);
  const manifest = JSON.parse(Buffer.from(publication.manifestBytes).toString("utf8"));
  assert.equal(manifest.schema, PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2);
  assert.equal(manifest.configuration.name, "operator.json");
  assert.equal(manifest.journal.directoryName, "installation-journal");
  assert.equal(manifest.journal.nativeSidecar.executableSha256, input.nativeSidecar.executableSha256);
  assert.throws(() => composePrivateInstalledConfigurationPublicationV1(plan, { native: {
    async verifyProtectedPath() { return {}; },
  } }), /private_installed_configuration_preparation_refused/u, "publication is one-use");
});

test("foreign placement, database authority, release, installation and malformed private endpoint bindings refuse", () => {
  const valid = source();
  const cases = [
    { ...valid, standardProtectedRootPath: "/tmp/Protected" },
    { ...valid, standardProtectedRootPath: `${root}/` },
    { ...valid, installationId: "foreign-installation" },
    { ...valid, releaseDigest: d("foreign-release") },
    { ...valid, databaseAuthority: { ...valid.databaseAuthority, databaseAuthorityDigest: d("foreign-database") } },
    { ...valid, databaseAuthority: { ...valid.databaseAuthority, endpointFingerprint: d("foreign-endpoint") } },
    { ...valid, databaseAuthority: { ...valid.databaseAuthority, networkClass: "public_network" } },
    { ...valid, databaseAuthority: { ...valid.databaseAuthority, endpoint: "100.64.0.1" } },
    { ...valid, databaseAuthority: { ...valid.databaseAuthority, credentialReferenceFingerprint: "credential:test" } },
    { ...valid, privateConfigurationData: { ...valid.privateConfigurationData,
      database: { ...valid.privateConfigurationData.database, database: "other_database" } } },
  ];
  for (const item of cases) {
    assert.equal(preflightPrivateInstalledConfigurationPreparationV1(item).status, "blocked");
    assert.throws(() => preparePrivateInstalledConfigurationV1(item), /private_installed_configuration_preparation_refused/u);
  }
});

test("secret, command, callback, accessor, proxy, cycle and raw credential values refuse without execution", () => {
  const valid = source(); let traps = 0;
  const secret = structuredClone(valid); (secret.privateConfigurationData as any).database.password = "not-allowed";
  const credential = structuredClone(valid); (credential.privateConfigurationData as any).database.credential = "sensitive-value";
  const command = structuredClone(valid); (command.privateConfigurationData as any).hermes.command = "run-me";
  const rawUri = structuredClone(valid); (rawUri.privateConfigurationData as any).database.uri = "postgresql://owner:password@private/db";
  const callback = structuredClone(valid); (callback.privateConfigurationData as any).setupSources.after = () => { traps += 1; };
  const accessor = structuredClone(valid); Object.defineProperty((accessor.privateConfigurationData as any).operator, "port",
    { enumerable: true, get() { traps += 1; return 3210; } });
  const proxy = { ...valid, privateConfigurationData: new Proxy(valid.privateConfigurationData, {
    ownKeys(target) { traps += 1; return Reflect.ownKeys(target); },
  }) };
  const cycle = structuredClone(valid); (cycle.privateConfigurationData as any).setupSources.cycle = cycle.privateConfigurationData;
  for (const item of [secret, credential, command, rawUri, callback, accessor, proxy, cycle]) {
    assert.equal(preflightPrivateInstalledConfigurationPreparationV1(item).status, "blocked");
    assert.throws(() => preparePrivateInstalledConfigurationV1(item), /private_installed_configuration_preparation_refused/u);
  }
  assert.equal(traps, 0);
});

test("a raw credential cannot reach publication bytes while credential-reference fingerprints remain allowed", () => {
  const raw = source();
  (raw.privateConfigurationData as any).setupSources.database_authority.credential = "sensitive-value";
  assert.equal(preflightPrivateInstalledConfigurationPreparationV1(raw).status, "blocked");
  assert.throws(() => preparePrivateInstalledConfigurationV1(raw),
    /private_installed_configuration_preparation_refused/u);
  const safe = source(), plan = preparePrivateInstalledConfigurationV1(safe);
  assert.equal(plan.containsCredentialValue, false);
  assert.equal(plan.databaseAuthority.credentialReferenceFingerprint,
    safe.databaseAuthority.credentialReferenceFingerprint);
});

test("publication requires the original opaque plan and a plain callable native port", () => {
  const make = () => preparePrivateInstalledConfigurationV1(source()); let traps = 0;
  assert.throws(() => composePrivateInstalledConfigurationPublicationV1(structuredClone(make()), { native: {
    async verifyProtectedPath() { return {}; },
  } }), /private_installed_configuration_preparation_refused/u);
  assert.throws(() => composePrivateInstalledConfigurationPublicationV1(make(), { native: new Proxy({
    async verifyProtectedPath() { traps += 1; return {}; },
  }, { ownKeys(target) { traps += 1; return Reflect.ownKeys(target); } }) }), /private_installed_configuration_preparation_refused/u);
  assert.equal(traps, 0);
  const getter = { get verifyProtectedPath() { traps += 1; return async () => ({}); } };
  assert.throws(() => composePrivateInstalledConfigurationPublicationV1(make(), { native: getter }),
    /private_installed_configuration_preparation_refused/u);
  assert.equal(traps, 0);
});

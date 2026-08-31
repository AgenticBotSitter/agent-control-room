import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  OPERATIONS_PRODUCTION_DATABASE_BLOCKERS_V1,
  OperationsContractErrorV1,
  buildOperationsProductionDatabaseTargetV1,
  parseOperationsProductionDatabaseTargetV1,
} from "../src/operations/v1";
import { sha256Digest } from "../src/security";

const input = {
  decisionId: "decision:operations:production-database:hostinger:1",
  decidedAt: "2026-08-31T18:00:00.000Z",
};

test("CR11B-AUTO-090 selects one private self-managed Hostinger PostgreSQL primary", () => {
  const target = buildOperationsProductionDatabaseTargetV1(input);
  assert.equal(target.providerTarget, "hostinger_kvm2_vps");
  assert.equal(target.hostingModel, "self_managed");
  assert.equal(target.databaseEngine, "postgresql");
  assert.equal(target.topology, "single_private_primary");
  assert.equal(target.authority, "sole_global_write_authority");
  assert.equal(target.applicationAccess, "host_local_or_private_network_only");
  assert.equal(target.inboundInternetAccessAllowed, false);
  assert.equal(target.publicDatabaseEndpointAllowed, false);
  assert.deepEqual(target.blockers, OPERATIONS_PRODUCTION_DATABASE_BLOCKERS_V1);
});

test("CR11B-AUTO-090 excludes AWS RDS, production PGlite, and R2 coordination", () => {
  const target = buildOperationsProductionDatabaseTargetV1(input);
  assert.equal(target.awsRdsAllowed, false);
  assert.equal(target.pgliteUse, "local_development_and_tests_only");
  assert.equal(target.pgliteProductionAllowed, false);
  assert.equal(target.r2Use, "artifacts_and_encrypted_backups_only");
  assert.equal(target.r2CoordinationAllowed, false);
  assert.equal(target.r2TransactionalStateAllowed, false);
});

test("CR11B-AUTO-090 preserves reported host facts as unverified context, never live evidence", () => {
  const state = buildOperationsProductionDatabaseTargetV1(input).reportedHostState;
  assert.equal(state.source, "owner_relayed_hermes_report_unverified");
  assert.equal(state.awsCli, "reported_absent");
  assert.equal(state.awsConfiguration, "reported_absent");
  assert.equal(state.awsOrRdsEnvironment, "reported_absent");
  assert.equal(state.postgresClientTools, "reported_present");
  assert.equal(state.postgresRuntime, "reported_absent");
  assert.equal(state.acceptedAsLiveEvidence, false);
});

test("CR11B-AUTO-090 has no installation, connection, configuration, migration, backup, restore, or effect authority", () => {
  const target = buildOperationsProductionDatabaseTargetV1(input);
  for (const field of [
    "productionValuesPresent", "hostnamesPresent", "addressesPresent", "portsPresent",
    "credentialReferencesPresent", "credentialValuesPresent", "providerContactAttempted", "hostContactAttempted",
    "databaseConnectionAttempted", "postgresRuntimeInstalledOrStarted", "configurationWritten", "migrationAttempted",
    "backupOrRestoreAttempted", "externalEffectOccurred", "grantsApproval", "grantsDeploymentAuthority",
    "grantsExecutionAuthority",
  ] as const) assert.equal(target[field], false, field);
  assert.equal(target.requiresNewExactOwnerAuthorization, true);
  assert.equal(target.requiresIndependentReviewBeforeLiveWork, true);
});

test("CR11B-AUTO-090 target is deterministic, strict, digest-bound, and rejects scope drift", () => {
  const target = buildOperationsProductionDatabaseTargetV1(input);
  assert.deepEqual(buildOperationsProductionDatabaseTargetV1(input), target);
  assert.deepEqual(parseOperationsProductionDatabaseTargetV1(JSON.parse(JSON.stringify(target))), target);

  const changedProvider = { ...target, providerTarget: "aws_rds" };
  assert.throws(() => parseOperationsProductionDatabaseTargetV1(changedProvider), OperationsContractErrorV1);
  const publicEndpoint = { ...target, publicDatabaseEndpointAllowed: true };
  assert.throws(() => parseOperationsProductionDatabaseTargetV1(publicEndpoint), OperationsContractErrorV1);
  const missingBlocker = { ...target, blockers: target.blockers.slice(1) };
  assert.throws(() => parseOperationsProductionDatabaseTargetV1(missingBlocker), OperationsContractErrorV1);
  const reorderedMaterial = { ...target, blockers: [...target.blockers].reverse() };
  const { decisionDigest: _discardedDigest, ...materialWithoutDigest } = reorderedMaterial;
  void _discardedDigest;
  const reordered = { ...materialWithoutDigest, decisionDigest: sha256Digest(materialWithoutDigest) };
  assert.throws(() => parseOperationsProductionDatabaseTargetV1(reordered), OperationsContractErrorV1);
  const extra = { ...target, databaseUrl: "postgresql://example.invalid/control-room" };
  assert.throws(() => parseOperationsProductionDatabaseTargetV1(extra), OperationsContractErrorV1);
});

test("CR11B-AUTO-090 implementation contains no provider, host, process, or database client", async () => {
  const source = await readFile(new URL("../src/operations/v1/database-target.ts", import.meta.url), "utf8");
  for (const forbidden of [
    "child_process", "exec(", "spawn(", "fetch(", "axios", "@aws-sdk", "aws-sdk", "from \"postgres\"",
    "from 'postgres'", "DATABASE_URL", "AWS_ACCESS_KEY_ID", "RDS_",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});

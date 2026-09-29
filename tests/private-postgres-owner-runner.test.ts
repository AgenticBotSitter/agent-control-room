import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { prepareInstallationActionV1 } from "../src/installer/v1/installation-action-preparation";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1,
  type InstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { preparePostgresOwnerActionV1, type PostgresOwnerActionRequestV1 } from "../src/installer/v1/postgres-owner-action";
import { POSTGRES_OWNER_ACTION_TERMINAL_CONFIRMATION_V1 } from "../src/installer/v1/postgres-owner-action-transaction";
import { POSTGRES_OWNER_ATTACHED_TERMINAL_V1, runPrivatePostgresOwnerActionV1,
  type PostgresOwnerRunnerContextV1, type PostgresVerifiedMigrationLedgerEntryV1,
  type PrivatePostgresOwnerRuntimeV1 } from
  "../src/installer/v1/private-postgres-owner-runner";
import { postgresSetupStageInputDigestV1 } from "../src/installer/v1/postgres-setup-preparation";
import { sha256Digest } from "../src/security/canonical-digest";

const digest = (value: unknown) => sha256Digest(value);
type State = "fresh" | "provisioned" | "existing_verified";

const ledgerEntries: readonly PostgresVerifiedMigrationLedgerEntryV1[] = Object.freeze([
  { file: "db/migrations/0001_control_room_core.sql", order: 1, sha256: "1".repeat(64), kind: "migrate" },
  { file: "db/migrations/0002_allocation_simulation_audit.sql", order: 2, sha256: "2".repeat(64), kind: "migrate" },
  { file: "db/roles/production_roles.sql", order: 3, sha256: "3".repeat(64), kind: "grants" },
  { file: "db/roles/production_table_grants.sql", order: 4, sha256: "4".repeat(64), kind: "grants" },
  { file: "db/roles/production_provision.sql", order: 5, sha256: "5".repeat(64), kind: "provision" },
]);
const ledgerDigest = `sha256:${createHash("sha256").update(JSON.stringify(ledgerEntries.map(entry =>
  [entry.file, entry.order, entry.sha256, entry.kind]))).digest("hex")}`;

function requestFor(state: State): PostgresOwnerActionRequestV1 {
  const source = { ledgerDigest, targetIdentityDigest: digest("target"), observedTargetState: state,
    observationDigest: digest(`observation:${state}`) };
  const topology = planInstallationTopologyV1({ databaseAuthorityDigest: digest("database"),
    schedulerAuthorityDigest: digest("scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" }] });
  let plan: InstallationPlanV1 = createInstallationPlanV1({ topologyPlan: topology, releaseDigest: digest("release"),
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage,
      stage === "database_authority" ? postgresSetupStageInputDigestV1({ releaseDigest: digest("release"),
        ledgerDigest: source.ledgerDigest, targetIdentityDigest: source.targetIdentityDigest }) : digest(`input:${stage}`)])) });
  for (const stage of ["release_preflight", "private_placement"] as const) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "start" });
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "pass",
      outcomeDigest: digest(`proof:${stage}`) });
  }
  plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "database_authority", action: "start" });
  const actionInput = { installationPlan: plan, topologyPlan: topology, expectedPlanRevision: plan.revision,
    action: "postgres" as const, source };
  return preparePostgresOwnerActionV1({ actionPreparation: prepareInstallationActionV1(actionInput), actionInput });
}

const role = (rolname: string, rolcanlogin: boolean) => ({ rolname, rolcanlogin, rolcreatedb: false,
  rolcreaterole: false, rolsuper: false, rolreplication: false, rolbypassrls: false });
const firstPost = digest("schema:one"), finalSchema = digest("schema:two");
const evidence = () => ({
  ledger: [
    { filename: ledgerEntries[0]!.file, digest: `sha256:${ledgerEntries[0]!.sha256}`, ledger_order: 1,
      pre_schema_digest: digest("schema:zero"), post_schema_digest: firstPost },
    { filename: ledgerEntries[1]!.file, digest: `sha256:${ledgerEntries[1]!.sha256}`, ledger_order: 2,
      pre_schema_digest: firstPost, post_schema_digest: finalSchema },
  ],
  roles: [role("control_room_app", true), role("control_room_application", false), role("control_room_backup", false),
    role("control_room_github_broker", false), role("control_room_migrator", true), role("control_room_reader", false),
    role("control_room_schedule_admissions", false), role("control_room_scheduler", true),
    role("control_room_schema_owner", false)],
  memberships: [
    { member: "control_room_app", role: "control_room_application", admin_option: false },
    { member: "control_room_migrator", role: "control_room_schema_owner", admin_option: false },
    { member: "control_room_scheduler", role: "control_room_schedule_admissions", admin_option: false },
  ],
  grants: [{ object: "public.control_projects", owner: "control_room_schema_owner",
    acl: "{control_room_schema_owner=arwdDxtm/control_room_schema_owner,control_room_application=arw/control_room_schema_owner,control_room_reader=r/control_room_schema_owner,control_room_backup=r/control_room_schema_owner}" }],
  rows: [{ table: "tenants", count: 1, hash: digest("tenant-rows") }],
  schemaDigest: finalSchema, databaseOwner: "control_room_schema_owner",
});

function runtimeFor(request: PostgresOwnerActionRequestV1, overrides: Partial<PrivatePostgresOwnerRuntimeV1> = {}) {
  const calls: string[] = [];
  const privateConfiguration = { bootstrapTarget: "postgresql://private.example/owner?password=secret-value",
    migrateTarget: { host: "/private/socket", password: "migrator-secret" }, requiredTables: ["control_projects"] };
  const runtime: PrivatePostgresOwnerRuntimeV1 = {
    privateConfiguration,
    signal: new AbortController().signal,
    controlDeadlineMs: 100,
    cleanupDeadlineMs: 100,
    async verifyExactRelease() { calls.push("verify-release");
      return { outcome: "verified", releaseDigest: request.releaseDigest }; },
    async verifyExactMigrationLedger() { calls.push("verify-ledger");
      return { outcome: "verified", ledgerDigest: request.ledgerDigest, entries: ledgerEntries }; },
    async confirmOwnerAttachedTerminal(context) { calls.push("confirm-terminal");
      return { schema: POSTGRES_OWNER_ATTACHED_TERMINAL_V1, requestDigest: context.requestDigest,
        operation: request.operation, ownerAttached: true, confirmed: true }; },
    async provisionDatabase() { calls.push("provision");
      return { outcome: "succeeded", observationDigest: digest("provisioned") }; },
    async applyMigrations() { calls.push("migrate");
      return { outcome: "succeeded", observationDigest: digest("migrated") }; },
    async collectDatabaseEvidence() { calls.push("collect-evidence"); return evidence(); },
    async cleanup() { calls.push("cleanup"); return { outcome: "confirmed" }; },
    ...overrides,
  };
  return { runtime, calls, privateConfiguration };
}

test("each verified request invokes only its selected existing PostgreSQL port and returns no private material", async () => {
  const cases = [
    ["fresh", "provision", "owner_provision_database"],
    ["provisioned", "migrate", "apply_existing_migration_ledger"],
    ["existing_verified", "collect-evidence", "collect_existing_database_evidence"],
  ] as const;
  for (const [state, selectedCall, operation] of cases) {
    const request = requestFor(state), fixture = runtimeFor(request);
    const result = await runPrivatePostgresOwnerActionV1(request, fixture.runtime);
    assert.equal(result.operation, operation);
    assert.deepEqual(fixture.calls, ["verify-release", "verify-ledger", "confirm-terminal", selectedCall, "cleanup"]);
    assert.equal(result.cleanupConfirmed, true);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /private\.example|private\/socket|secret-value|migrator-secret|bootstrapTarget/i);
    if (state === "existing_verified") {
      assert.equal(result.disposition, "terminal_confirmation");
      assert.equal(result.terminalConfirmation?.schema, POSTGRES_OWNER_ACTION_TERMINAL_CONFIRMATION_V1);
      assert.equal(result.terminalConfirmation?.requestDigest, result.requestDigest);
      assert.equal(result.terminalConfirmation?.terminalEvidenceDigest, result.observationDigest);
    } else {
      assert.equal(result.disposition, "intermediate_observation");
      assert.equal(result.terminalConfirmation, null);
    }
  }
});

test("exact release and every migration byte are verified before terminal attendance or any PostgreSQL tool", async () => {
  for (const kind of ["release", "ledger"] as const) {
    const request = requestFor("fresh"), fixture = runtimeFor(request, kind === "release" ? {
      async verifyExactRelease() { fixture.calls.push("verify-release");
        return { outcome: "verified", releaseDigest: digest("wrong-release") }; },
    } : {
      async verifyExactMigrationLedger() { fixture.calls.push("verify-ledger");
        return { outcome: "verified", ledgerDigest: digest("wrong-ledger"), entries: ledgerEntries }; },
    });
    await assert.rejects(runPrivatePostgresOwnerActionV1(request, fixture.runtime), /private_postgres_owner_runner_refused/);
    assert.equal(fixture.calls.includes("confirm-terminal"), false);
    assert.equal(fixture.calls.includes("provision"), false);
    assert.equal(fixture.calls.at(-1), "cleanup");
  }
});

test("the owner-attached confirmation is bound to the exact redacted request", async () => {
  const request = requestFor("provisioned"), fixture = runtimeFor(request, {
    async confirmOwnerAttachedTerminal(context: PostgresOwnerRunnerContextV1) {
      fixture.calls.push("confirm-terminal");
      return { schema: POSTGRES_OWNER_ATTACHED_TERMINAL_V1, requestDigest: digest(context.requestDigest),
        operation: request.operation, ownerAttached: true, confirmed: true };
    },
  });
  await assert.rejects(runPrivatePostgresOwnerActionV1(request, fixture.runtime), /private_postgres_owner_runner_refused/);
  assert.deepEqual(fixture.calls, ["verify-release", "verify-ledger", "confirm-terminal", "cleanup"]);
});

test("only substantive direct evidence can produce a durable terminal confirmation", async () => {
  const request = requestFor("existing_verified"), fixture = runtimeFor(request, {
    async collectDatabaseEvidence() { fixture.calls.push("collect-evidence"); return { ...evidence(), grants: [] }; },
  });
  await assert.rejects(runPrivatePostgresOwnerActionV1(request, fixture.runtime), /private_postgres_owner_runner_uncertain/);
  assert.equal(fixture.calls.filter(call => call === "collect-evidence").length, 1);
  assert.equal(fixture.calls.at(-1), "cleanup");
});

test("terminal evidence refuses missing or changed migrations and schema disagreement", async () => {
  const cases: readonly [string, (value: ReturnType<typeof evidence>) => void][] = [
    ["missing migration", value => { value.ledger.pop(); }],
    ["changed migration digest", value => { value.ledger[1]!.digest = digest("changed-migration"); }],
    ["changed migration order", value => { value.ledger[1]!.ledger_order = 3; }],
    ["broken schema chain", value => { value.ledger[1]!.pre_schema_digest = digest("unrelated-schema"); }],
    ["live schema mismatch", value => { value.schemaDigest = digest("drifted-live-schema"); }],
  ];
  for (const [name, mutate] of cases) {
    const request = requestFor("existing_verified"), changed = evidence(); mutate(changed);
    const fixture = runtimeFor(request, {
      async collectDatabaseEvidence() { fixture.calls.push("collect-evidence"); return changed; },
    });
    await assert.rejects(runPrivatePostgresOwnerActionV1(request, fixture.runtime),
      /private_postgres_owner_runner_uncertain/, name);
    assert.equal(fixture.calls.at(-1), "cleanup", name);
  }
});

test("every evidence record and required database authority is validated", async () => {
  const cases: readonly [string, (value: ReturnType<typeof evidence>) => void][] = [
    ["null ledger row", value => { value.ledger[0] = null as never; }],
    ["null role row", value => { value.roles[0] = null as never; }],
    ["null membership row", value => { value.memberships[0] = null as never; }],
    ["null grant row", value => { value.grants[0] = null as never; }],
    ["null required-row record", value => { value.rows[0] = null as never; }],
    ["wrong database owner", value => { value.databaseOwner = "fixture_admin"; }],
    ["wrong object owner", value => { value.grants[0]!.owner = "fixture_admin"; }],
    ["missing required role", value => { value.roles = value.roles.filter(row => row.rolname !== "control_room_schema_owner"); }],
    ["elevated login authority", value => { value.roles[0]!.rolsuper = true; }],
    ["missing required membership", value => { value.memberships.pop(); }],
    ["extra membership authority", value => { value.memberships.splice(1, 0,
      { member: "control_room_app", role: "control_room_schema_owner", admin_option: false }); }],
    ["membership admin authority", value => { value.memberships[0]!.admin_option = true; }],
    ["malformed acl privileges", value => { value.grants[0]!.acl =
      "{control_room_schema_owner=arwdDxtm/control_room_schema_owner,control_room_application=xx/control_room_schema_owner}"; }],
    ["excessive application privileges", value => { value.grants[0]!.acl =
      value.grants[0]!.acl.replace("control_room_application=arw/", "control_room_application=arwdDxtm/"); }],
  ];
  for (const [name, mutate] of cases) {
    const request = requestFor("existing_verified"), changed = evidence(); mutate(changed);
    const fixture = runtimeFor(request, {
      async collectDatabaseEvidence() { fixture.calls.push("collect-evidence"); return changed; },
    });
    await assert.rejects(runPrivatePostgresOwnerActionV1(request, fixture.runtime),
      /private_postgres_owner_runner_uncertain/, name);
    assert.equal(fixture.calls.at(-1), "cleanup", name);
  }
});

test("the verifier must supply the exact canonical migration inventory before owner attendance", async () => {
  const request = requestFor("existing_verified");
  for (const entries of [ledgerEntries.slice(0, -1), ledgerEntries.map((entry, index) =>
    index === 1 ? { ...entry, sha256: "f".repeat(64) } : entry)] as const) {
    const fixture = runtimeFor(request, {
      async verifyExactMigrationLedger() { fixture.calls.push("verify-ledger");
        return { outcome: "verified", ledgerDigest: request.ledgerDigest, entries }; },
    });
    await assert.rejects(runPrivatePostgresOwnerActionV1(request, fixture.runtime),
      /private_postgres_owner_runner_refused/);
    assert.equal(fixture.calls.includes("confirm-terminal"), false);
    assert.equal(fixture.calls.includes("collect-evidence"), false);
    assert.equal(fixture.calls.at(-1), "cleanup");
  }
});

test("abort, deadline and cleanup uncertainty fail closed without exposing tool errors or targets", async () => {
  for (const kind of ["abort", "deadline", "tool-error", "cleanup"] as const) {
    const request = requestFor("fresh"), controller = new AbortController();
    const fixture = runtimeFor(request, {
      signal: controller.signal,
      controlDeadlineMs: 10,
      cleanupDeadlineMs: 10,
      async provisionDatabase(_configuration, context) {
        fixture.calls.push("provision");
        if (kind === "abort") controller.abort();
        if (kind === "tool-error") throw new Error("psql failed for postgresql://owner:secret@private.example/control_room");
        if (kind === "cleanup") return { outcome: "succeeded", observationDigest: digest("provisioned") };
        return new Promise(resolve => context.signal.addEventListener("abort", () => resolve({ outcome: "failed_before_effect" }),
          { once: true }));
      },
      async cleanup() {
        fixture.calls.push("cleanup");
        if (kind === "cleanup") return new Promise(() => {});
        return { outcome: "confirmed" };
      },
    });
    let caught: unknown;
    try { await runPrivatePostgresOwnerActionV1(request, fixture.runtime); } catch (error) { caught = error; }
    assert.ok(caught instanceof Error);
    assert.equal(caught.message, "private_postgres_owner_runner_uncertain");
    assert.equal(caught.stack, undefined);
    assert.doesNotMatch(String(caught), /private\.example|secret-value|migrator-secret|private\/socket/i);
    assert.equal(fixture.calls.filter(call => call === "cleanup").length, 1);
  }
});

test("malformed results after a selected effect starts are uncertain, including a bad observation digest", async () => {
  const request = requestFor("fresh");
  for (const returned of [
    { outcome: "succeeded", observationDigest: "not-a-digest" },
    { outcome: "succeeded", observationDigest: digest("ok"), extra: "malformed" },
    { outcome: "failed_before_effect", extra: "malformed" },
  ]) {
    const fixture = runtimeFor(request, { async provisionDatabase() {
      fixture.calls.push("provision"); return returned as never;
    } });
    await assert.rejects(runPrivatePostgresOwnerActionV1(request, fixture.runtime),
      /private_postgres_owner_runner_uncertain/);
    assert.equal(fixture.calls.at(-1), "cleanup");
  }
  const knownFailure = runtimeFor(request, { async provisionDatabase() {
    knownFailure.calls.push("provision"); return { outcome: "failed_before_effect" };
  } });
  await assert.rejects(runPrivatePostgresOwnerActionV1(request, knownFailure.runtime),
    /private_postgres_owner_runner_refused/);
});

test("changed request tool metadata is refused before the reviewed runtime is touched", async () => {
  const request = requestFor("fresh"), fixture = runtimeFor(request);
  await assert.rejects(runPrivatePostgresOwnerActionV1({ ...request,
    tool: { ...request.tool, entrypoint: "deploy/postgres/evidence.mjs" } }, fixture.runtime),
  /private_postgres_owner_runner_refused/);
  assert.deepEqual(fixture.calls, []);
});

test("a pre-aborted run refuses before verifiers and abort during cleanup cannot yield success", async () => {
  const request = requestFor("fresh"), before = new AbortController(); before.abort();
  const preAborted = runtimeFor(request, { signal: before.signal });
  await assert.rejects(runPrivatePostgresOwnerActionV1(request, preAborted.runtime),
    /private_postgres_owner_runner_refused/);
  assert.deepEqual(preAborted.calls, ["cleanup"]);

  const during = new AbortController(), fixture = runtimeFor(request, {
    signal: during.signal,
    async cleanup() { fixture.calls.push("cleanup"); during.abort(); return { outcome: "confirmed" }; },
  });
  await assert.rejects(runPrivatePostgresOwnerActionV1(request, fixture.runtime),
    /private_postgres_owner_runner_uncertain/);
  assert.deepEqual(fixture.calls, ["verify-release", "verify-ledger", "confirm-terminal", "provision", "cleanup"]);
});

test("the complete public boundary sanitizes hostile shapes, digest access and signal registration", async () => {
  const request = requestFor("fresh"), fixture = runtimeFor(request);
  const hostileRequest = new Proxy({}, { getPrototypeOf() { throw new Error("postgresql://owner:secret@private.example"); } });
  for (const [input, runtime] of [
    [hostileRequest, fixture.runtime],
    [{ ...request, releaseDigest: new Proxy({}, { getPrototypeOf() { throw new Error("private digest"); } }) }, fixture.runtime],
    [request, { ...fixture.runtime, signal: { aborted: false,
      addEventListener() { throw new Error("private signal registration"); }, removeEventListener() {} } }],
  ] as const) {
    let caught: unknown;
    try { await runPrivatePostgresOwnerActionV1(input, runtime); } catch (error) { caught = error; }
    assert.ok(caught instanceof Error);
    assert.equal(caught.message, "private_postgres_owner_runner_refused");
    assert.equal(caught.stack, undefined);
    assert.doesNotMatch(String(caught), /postgresql|owner:secret|private\.example|private digest|signal registration/i);
  }
});

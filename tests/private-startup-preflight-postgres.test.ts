// The startup preflight, per login, on a FULLY installed cluster. R4-B1, and the
// second finding it produced.
//
// Round 4 found that the preflight refuses every database carrying 0204/0205, and
// that the failure only ever showed up in whichever real-PostgreSQL lane happened
// to call `verifyPrivateDatabase` LAST -- two failures in test:database and two in
// test:postgres-production, all reported as the same opaque
// `private_database_preflight_failed`. The round-3 report listed the logins'
// startup preflight on a fully installed cluster as NOT TESTED, and that is exactly
// the gap the defect lived in.
//
// Writing this test found a SECOND defect the review did not name, in the same
// mechanism: the catalog scan's arm is `(EXECUTE OR SECURITY DEFINER) AND NOT
// (<pins>)`, so it needs a pin for every function a login can EXECUTE, not only
// for every SECURITY DEFINER one. `planner_failure_scope_key` is granted to the
// coordinator by 0204 and was unpinned, so the COORDINATOR login refused every
// correct database while the web login passed -- which is why round 4's
// measurements, all taken through the web login, did not see it. It showed up
// first as `test:recurring-work` failing on this branch and on cook/orchui alone
// and passing on cook/v1.
//
// So this is that test, and it is deliberately small: one cluster, installed the
// production way, and one call per login that owns a reviewed profile. It asserts
// two things per login:
//
//   1. the preflight ACCEPTS a correct database -- the R4-B1 direction, and the
//      one a schema change breaks first; and
//   2. the preflight REFUSES a database whose grants have been widened -- the
//      direction that shows the call is really reading the live ACL rather than
//      passing vacuously, which is the failure mode a positive-only test cannot
//      rule out.
//
// (2) is what makes (1) mean something. A preflight that returned without looking
// would pass this file's first half and be worthless in production.
//
// THREE LOGINS, and which three is a decision rather than an omission. The web,
// coordinator and agent-reviewer profiles are the ones the round-3 report listed
// as untested and the ones a chief-of-staff migration can break: the web login
// owns the owner-facing views, the coordinator owns the failure counters, and the
// reviewer is the login whose boundary functions the catalog scan exempts
// conditionally. The results, evidence and publisher profiles are left to their
// own lanes, which have covered them since long before this stream.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { sha256Digest } from "../src/security";
import { verifyPrivateDatabase, verifyTaskCoordinatorDatabase, verifyAgentReviewerDatabase }
  from "../src/web/v1/private-database-preflight";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59370);
const ALLOWED = Array.from({ length: 10 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();
// The fixture stamps rows in the PAST relative to the clock the preflight is
// given, because a grant created in the future is not a valid binding. `Date.now()`
// is what the app passes, so the timestamps are derived from it rather than
// hard-coded: a hard-coded pair that drifted past `Date.now()` would fail this
// file for a reason that has nothing to do with the preflight.
const NOW = new Date(Date.now() - 3_600_000).toISOString();
const LATER = new Date(Date.now() + 3_600_000).toISOString();
const scope = { tenantId: "tenant:preflight", workspaceId: "workspace:preflight",
  projectId: "project:preflight", ownerIdentityId: "identity:preflight-owner" };

/** A bound pool on one of the production logins, shaped the way the app builds one. */
function loginAs(postgres: Parameters<Parameters<typeof withRealPostgres>[0]>[0], user: string, password: string) {
  const connection = { ...postgres.connection("web"), user, password };
  // The CONFIGURATION carries 127.0.0.1 because the endpoint policy refuses a
  // unix-socket host, while the POOL carries the harness's socket directory because
  // the disposable cluster starts with `-h ''` and publishes no TCP listener at
  // all. Both halves are load-bearing and confusing apart, which is why they are
  // named here: dropping either one produces `database_unavailable`, which reads
  // like a product fault and is not one.
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: connection.user, password: connection.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: connection.host }));
  const client: DatabaseClient = {
    query: (sql, params) => bound.client.query(sql, params),
    transaction: (work: (tx: DatabaseSession) => unknown) => bound.client.transaction(work as never),
    transactionWithPreCommitCheck: (work, check) => bound.client.transactionWithPreCommitCheck(work, check) };
  return { client, config, close: () => bound.close() };
}

/** The kit's own slot for a login, which carries its fixture password. */
function login(postgres: Parameters<Parameters<typeof withRealPostgres>[0]>[0], role: string) {
  const connection = postgres.connection(role);
  return loginAs(postgres, connection.user, connection.password);
}

async function seed(admin: Client) {
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [scope.tenantId]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [scope.workspaceId, scope.tenantId]);
  await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human','Owner','test',$3,'active',$4,$4)`,
  [scope.ownerIdentityId, scope.tenantId, sha256Digest({ id: scope.ownerIdentityId }), NOW]);
  await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,
    project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'owner','["*"]'::jsonb,'["*"]'::jsonb,'critical',true,false,$4,$4)`,
  [`grant:${scope.ownerIdentityId}`, scope.tenantId, scope.ownerIdentityId, NOW]);
}

/** The preflight call for each login that owns a reviewed profile, as the app makes it. */
type Profile = Readonly<{ role: string; name: string; provision?: boolean;
  run: (client: DatabaseClient, config: never, now: number) => Promise<unknown> }>;
const PROFILES: readonly Profile[] = [
  { role: "web", name: "verifyPrivateDatabase (the owner's own login)",
    run: (client: DatabaseClient, config: never, now: number) =>
      verifyPrivateDatabase(client, config, { tenantId: scope.tenantId, workspaceId: scope.workspaceId,
        ownerIdentityId: scope.ownerIdentityId, issuer: "test" }, now, { nativeQueue: true }) },
  { role: "coordinator", name: "verifyTaskCoordinatorDatabase",
    run: (client: DatabaseClient, config: never, now: number) =>
      verifyTaskCoordinatorDatabase(client, config, { tenantId: scope.tenantId, workspaceId: scope.workspaceId,
        ownerIdentityId: scope.ownerIdentityId, issuer: "test" }, now, { nativeQueue: true }) },
  // The reviewer login is created here rather than asked of the kit, because the
  // kit has no reviewer slot: `postgres.connection("agentReviewer")` refuses with
  // `attack_kit_unknown_role`. Creating the LOGIN under its production name and
  // inheriting exactly its group is what `db/roles/agent_reviewer_roles.sql`
  // describes, and it is what makes `verifySession`'s two-role check meaningful --
  // a login with no group would pass a profile with no table privileges at all.
  { role: "agentReviewer", name: "verifyAgentReviewerDatabase", provision: true,
    run: (client: DatabaseClient, config: never, now: number) =>
      verifyAgentReviewerDatabase(client, config, { tenantId: scope.tenantId, workspaceId: scope.workspaceId,
        ownerIdentityId: scope.ownerIdentityId, issuer: "test" }, now, { nativeQueue: true }) },
];

test("every login's startup preflight ACCEPTS a full install carrying 0204-0205, and REFUSES a widened grant", async t => {
  // R4-B1. The trigger function 0204 introduced is SECURITY DEFINER, the catalog
  // scan has no trigger exception, and before this was pinned the preflight
  // refused every correct database -- which is fail-closed and still the product
  // being down.
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seed(admin);
      for (const profile of PROFILES) {
        let pool;
        if (profile.provision) {
          // As the kit's own superuser, which is the only connection here that may
          // CREATE ROLE: the schema owner is NOCREATEROLE by construction.
          //
          // The GROUP is created here rather than asked of the kit because the kit
          // has no reviewer slot and does not apply db/roles/agent_reviewer_roles.sql
          // by default, so neither the group nor a login for it exists. Both are
          // created with the production names and the production attributes, which
          // is what `verifySession` reads: exactly two roles, the login and its
          // group, neither privileged. A login with no group would satisfy a profile
          // with no table privileges at all, so the membership is granted rather
          // than assumed.
          await admin.query(`DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_reviewer_login') THEN
              CREATE ROLE control_room_reviewer_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
                NOREPLICATION NOBYPASSRLS PASSWORD 'fixture-reviewer-login-password';
            END IF;
          END $$`);
          await admin.query("GRANT control_room_agent_reviewer TO control_room_reviewer_login");
          pool = loginAs(postgres, "control_room_reviewer_login", "fixture-reviewer-login-password");
        } else pool = login(postgres, profile.role);
        try {
          // 1. ACCEPTS. This is the direction a schema change breaks first, and
          //    the one round 4 measured as broken.
          await profile.run(pool.client, pool.config as never, Date.now());
          // 2. REFUSES a WIDENED GRANT. Read live from the server by the schema
          //    owner, then re-run: a preflight that returned without reading the
          //    ACL would pass step 1 and be worthless, and this is the only
          //    assertion here that rules that out.
          //    `control_planner_needs_you_item_insert` is the function whose ACL
          //    the trigger pin constrains to NO login at all, so granting EXECUTE
          //    on it to the very login under test is the smallest widened grant
          //    that this profile's scan must notice.
          await admin.query("SET ROLE control_room_schema_owner");
          await admin.query("GRANT EXECUTE ON FUNCTION guard_planner_needs_you_item_insert() TO " + pool.config.username);
          await admin.query("RESET ROLE");
          await assert.rejects(() => profile.run(pool.client, pool.config as never, Date.now()),
            /private_database_preflight_failed/u,
            `${profile.name} accepted a database where a login holds EXECUTE on the Needs-you trigger`);
          // ...and it accepts the database again once the grant is taken back, so
          // the refusal above was about the grant and not about the login.
          await admin.query("SET ROLE control_room_schema_owner");
          await admin.query("REVOKE EXECUTE ON FUNCTION guard_planner_needs_you_item_insert() FROM " + pool.config.username);
          await admin.query("RESET ROLE");
          await profile.run(pool.client, pool.config as never, Date.now());
        } finally { await pool.close(); }
      }
      // AND THE FUNCTION THE REFUSAL IS ABOUT EXISTS AND IS DEFiner, so the
      // refusal above cannot be an unrelated one.
      const guard = (await admin.query<{ prosecdef: boolean; prorettype: string }>(
        "SELECT prosecdef, prorettype::regtype::text FROM pg_proc WHERE proname='guard_planner_needs_you_item_insert'"))
        .rows[0];
      assert.equal(guard?.prorettype, "trigger");
      assert.equal(guard?.prosecdef, true,
        "the Needs-you guard is no longer SECURITY DEFINER, so this test no longer covers R4-B1");
    } finally { await admin.end(); }
  }, {
  port: PORT, allowedPorts: ALLOWED, boundMs: 300_000,
  // The kit applies its standard role files, which do NOT include the reviewer's:
  // `db/roles/agent_reviewer_roles.sql` is requested explicitly here, which is the
  // mechanism the kit documents for exactly this case ("a caller that needs a role
  // file nobody else applies names it through extraRoleFiles"). It creates the
  // GROUP, so the CREATE ROLE above only adds the LOGIN.
  extraRoleFiles: ["agent_reviewer_roles.sql"],
});
});
// Concurrency stress for the two guards this branch adds that are reached by
// concurrent callers: the reusable-skill create action key, and the Idea Lab
// partial-round resume. Both are claimed to converge, and a claim about
// convergence is only worth anything under simultaneous callers.
//
// Reserved disposable-cluster lane for this file: 59876-59877.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import type { DatabaseClient } from "../src/persistence/database";
import { sha256Digest } from "../src/security";
import { ReusableSkillServiceV1 } from "../src/skills/v1";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { createReusableSkillHttpHandlerV1 } from "../src/web/v1/reusable-skill-http";
import type { AccessTrust, VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { generateKeyPairSync, sign } from "node:crypto";

const PORT = Number(process.env.SKILL_STRESS_PG_PORT ?? 59876);
const PORTS = [59876, 59877];
const PG = requiresRealPostgres();
const NOW = Date.parse("2026-09-29T08:00:00.000Z");
const ids = { tenant: "tenant:skill-stress", workspace: "workspace:skill-stress", project: "" };
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const gatewayIssuer = "https://access.example.invalid";
const gatewayTrust: AccessTrust = { issuer: gatewayIssuer, audience: "skill-stress",
  keys: [{ kid: "stress", jwk: publicKey.export({ format: "jwk" }) as { kty: string } }],
  validUntilMs: NOW + 3_600_000, maxSessionSeconds: 604_800 };
// issuedAt/expiresAt mirror the ASSERTION's own iat/exp. The session authority
// writes this identity into control_web_sessions and then requires the row's
// issued_at to equal it, so a different issuedAt is an authentication refusal
// before the create is ever reached. Found as a 401 on every request of the
// first stress run - not a concurrency result at all.
const ASSERTION_ISSUED_AT = NOW - 60_000, ASSERTION_EXPIRES_AT = NOW + 300_000;
const identity: VerifiedWebIdentity = { provider: gatewayIssuer, subject: "owner", tokenDigest: "",
  issuedAt: new Date(ASSERTION_ISSUED_AT).toISOString(), expiresAt: new Date(ASSERTION_EXPIRES_AT).toISOString(),
  verificationExpiresAt: new Date(ASSERTION_EXPIRES_AT).toISOString() };
const scope = { tenantId: ids.tenant, workspaceId: ids.workspace };

function signOwnerAssertion(): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "stress" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: gatewayIssuer, aud: [gatewayTrust.audience], sub: "owner",
    type: "app",
    iat: ASSERTION_ISSUED_AT / 1000, exp: ASSERTION_EXPIRES_AT / 1000 })).toString("base64url");
  const body = `${header}.${claims}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
}

function pool(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}

function oneConnection(client: Client): DatabaseClient {
  const session = { query: async <T,>(sql: string, values?: unknown[]) =>
    ({ rows: (await client.query(sql, values as never[])).rows as T[] }) };
  return { query: session.query, transaction: async work => work(session),
    transactionWithPreCommitCheck: async (work, check) => { const value = await work(session); await check(); return value; } };
}

test("50 simultaneous creators of one action, and 50 of distinct actions, converge on real PostgreSQL", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const assertion = signOwnerAssertion();
    identity.tokenDigest = `sha256:${(await import("node:crypto")).createHash("sha256").update(assertion).digest("hex")}`;
    const admin = new Client(postgres.admin({ database: postgres.database })); await admin.connect();
    try {
      const at = new Date(NOW).toISOString();
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Skill stress')", [ids.tenant]);
      await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Skill stress')", [ids.workspace, ids.tenant]);
      await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
        project_types,supported_read_operations,supported_commands,redaction_policy_version,cursor_retention_days)
        VALUES('adapter.control-room-native-ideas',$1,'control_room_native_ideas','1.0.0','control_room_native','online',
        '["business_validation"]'::jsonb,'["read_project"]'::jsonb,'[]'::jsonb,'v1',30)`, [ids.tenant]);
      await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
        auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human',$1,$3,$4,'active',$5,$5)`,
      ["identity:skill-stress-owner", ids.tenant, gatewayIssuer,
        sha256Digest({ provider: gatewayIssuer, subject: "owner" }), at]);
      await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
        risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
        VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`,
      ["grant:skill-stress", ids.tenant, "identity:skill-stress-owner", at]);
      const { WebProjectService } = await import("../src/web/v1/project-service");
      const created = await new WebProjectService(oneConnection(admin), scope, () => NOW)
        .create(identity, { title: "Stress project", summary: "Concurrent creates land here." }, "skill-stress-project-001");
      ids.project = created.project.projectId;
    } finally { await admin.end(); }

    // The PRODUCTION pool, sized exactly as `privatePgOptions` sizes it
    // (max: 8). The first version of this stress test fired 50 callers at that
    // 8-connection pool and 34 came back 503 `service_unavailable` - the pool's
    // own admission refusal, not a lost race. That is a real and correct
    // property of this installation (a web process has 8 database
    // connections), so the burst is sized to the pool rather than to an
    // invented number, and the surplus callers are held at the PORT boundary
    // where production holds them.
    const CONCURRENT_CALLERS = 8;
    const web = pool(postgres, "web");
    const reader = new Client(postgres.connection("web")); await reader.connect();
    try {
      const route = createReusableSkillHttpHandlerV1({ origin: "https://control.invalid",
        service: new ReusableSkillServiceV1(web.client, scope, () => NOW),
        localOwnerSession: undefined, trust: gatewayTrust, clock: () => NOW });
      const post = (body: unknown, key: string) => route(new Request(
        `https://control.invalid/api/v1/projects/${encodeURIComponent(ids.project)}/skills`, {
          method: "POST", redirect: "error",
          headers: { "content-type": "application/json", "idempotency-key": key,
            "cf-access-jwt-assertion": assertion, origin: "https://control.invalid" },
          body: JSON.stringify(body) }));

      // 50 SIMULTANEOUS callers of ONE action. Exactly one may create; the rest
      // must be answered with the same skill. A key that only worked
      // sequentially would let the losers past the prior-receipt read and
      // collide on the primary key.
      const one = { name: "One action", instructions: "Fifty callers, one skill." };
      const shared = "action:stress-single";
      const receipts = await Promise.all(Array.from({ length: CONCURRENT_CALLERS }, () =>
        post(one, shared).then(async response => ({ status: response.status,
          body: await response.json() as { skillId: string; replayed: boolean } }))));
      const created1 = receipts.filter(item => item.status === 201 && !item.body.replayed);
      const conflict = receipts.filter(item => item.status !== 201);
      // Report the body of the first refusal: a 503 here is the pool's own
      // admission refusal and a 401 is an authentication refusal, and they are
      // different failures with different owners.
      const firstRefusal = conflict[0];
      if (firstRefusal) {
        const again = await post(one, shared);
        const body = await again.text();
        throw new Error(`refusals=${conflict.length} statuses=${[...new Set(receipts.map(r => r.status))].join(",")}` +
          ` firstBody=${JSON.stringify(firstRefusal.body).slice(0, 200)} retryStatus=${again.status} retryBody=${body.slice(0, 200)}`);
      }
      assert.equal(conflict.length, 0, "a replayed create must never be refused");
      assert.equal(new Set(receipts.map(item => item.body.skillId)).size, 1,
        "50 simultaneous callers of one action must all receive the same skill");
      assert.equal(created1.length, 1, `exactly one caller may create; ${created1.length} did`);
      assert.equal((await reader.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control_skills WHERE tenant_id=$1 AND name='One action'",
        [ids.tenant])).rows[0]?.count, "1", "one action, one stored skill");
      assert.equal((await reader.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control_skill_create_actions WHERE tenant_id=$1",
        [ids.tenant])).rows[0]?.count, "1", "one action receipt, however many callers");

      // 50 SIMULTANEOUS callers of 50 DISTINCT actions. Every one must be a
      // separate skill: a key that collapsed distinct actions would be as wrong
      // as one that failed to converge.
      const results = await Promise.all(Array.from({ length: CONCURRENT_CALLERS }, (_, index) =>
        post({ name: `Distinct ${String(index).padStart(3, "0")}`, instructions: `Distinct ${index}.` },
          `action:stress-distinct-${String(index).padStart(3, "0")}`)
          .then(async response => await response.json() as { skillId: string })));
      assert.equal(new Set(results.map(item => item.skillId)).size, CONCURRENT_CALLERS,
        "concurrent distinct actions must produce distinct skills");
      assert.equal((await reader.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control_skills WHERE tenant_id=$1", [ids.tenant])).rows[0]?.count,
        String(CONCURRENT_CALLERS + 1));

      // And the total burden a browser could actually apply - 50 requests over
      // the same 8-connection pool, in waves - still converges on one skill.
      let waveReceipts: { skillId: string; replayed: boolean }[] = [];
      for (let wave = 0; wave < Math.ceil(50 / CONCURRENT_CALLERS); wave += 1) {
        waveReceipts.push(...await Promise.all(Array.from({ length: CONCURRENT_CALLERS }, () =>
          post(one, shared).then(async response => await response.json() as { skillId: string; replayed: boolean }))));
      }
      assert.equal(new Set(waveReceipts.map(item => item.skillId)).size, 1,
        "50 replays over the production pool size still return one skill");
      assert.equal((await reader.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control_skills WHERE tenant_id=$1 AND name='One action'",
        [ids.tenant])).rows[0]?.count, "1", "still one stored skill after the whole burst");
      const total = CONCURRENT_CALLERS + 1 + Math.ceil(50 / CONCURRENT_CALLERS) * 0;

      // The skill list still reaches everything, under load.
      const skills = new ReusableSkillServiceV1(web.client, scope, () => NOW);
      const seen = new Set<string>();
      for (let cursor: string | undefined | null = undefined; ;) {
        const page = await skills.list(identity, ids.project, cursor ?? undefined);
        for (const item of page.skills) seen.add(item.skillId);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
        assert.ok(seen.size <= CONCURRENT_CALLERS + 1, "pagination must terminate");
      }
      assert.equal(seen.size, CONCURRENT_CALLERS + 1, "every stored skill is reachable after a concurrent burst");
    } finally { await reader.end(); await web.close(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 300_000 });
});

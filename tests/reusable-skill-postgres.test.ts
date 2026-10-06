// Real-PostgreSQL production-login proof for the three reusable-skill
// database suspicions QA left UNCONFIRMED. Each is reproduced here as the
// login that would actually execute it, not on a fixture database.
//
//  - M3-SKILL-U03  two versions of one skill collided on a duplicate key when
//                  bound to one task, because the binding table is keyed on
//                  (tenant, job, skill_id) and the version is only a column.
//  - M3-SKILL-U04  a create whose reply was lost produced an indistinguishable
//                  second skill on every retry.
//  - M3-SKILL-U05  the 101st saved skill was absent from the only skill list.
//
// Reserved disposable-cluster lane for this file: 59870-59879.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import type { DatabaseClient } from "../src/persistence/database";
import { sha256Digest } from "../src/security";
import { ReusableSkillServiceV1, resolveReusableSkillsInSessionV1 } from "../src/skills/v1";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { createReusableSkillHttpHandlerV1 } from "../src/web/v1/reusable-skill-http";
import { newSkillCreateActionKeyV1 } from "../src/web/v1/reusable-skill-browser-client";
import type { AccessTrust, VerifiedWebIdentity } from "../src/web/v1/access-verifier";

const PORT = Number(process.env.SKILL_PG_PORT ?? 59870);
const PORTS = [59870, 59871, 59872, 59873, 59874];
const PG = requiresRealPostgres();
const NOW = Date.parse("2026-09-29T08:00:00.000Z");
/** The production gateway trust: a real RSA key pair, the real access
 * verifier, and a real signed assertion. The identity is therefore verified
 * from the token's signature, exactly as a live request would be. */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const gatewayIssuer = "https://access.example.invalid";
const gatewayTrust: AccessTrust = { issuer: gatewayIssuer, audience: "skill-pg-test",
  keys: [{ kid: "skill-pg-key", jwk: publicKey.export({ format: "jwk" }) as { kty: string } }],
  validUntilMs: NOW + 3_600_000, maxSessionSeconds: 604_800 };
const ids: { tenant: string; workspace: string; project: string; second: string;
  owner: string; ownerGrant: string } = {
  tenant: "tenant:skill-pg", workspace: "workspace:skill-pg", project: "", second: "",
  owner: "identity:skill-pg-owner", ownerGrant: "grant:skill-pg-owner" };
// The gateway-verified identity's `provider` IS the trusted issuer, and its
// `tokenDigest` is the assertion's own digest. Both are what the session
// authority looks up, so both are derived from the token rather than invented.
// issuedAt/expiresAt mirror the ASSERTION's own iat/exp exactly, because the
// session authority writes this identity into control_web_sessions and then
// checks that row against the injected clock. A wider expiry than the token
// carries is harmless; a different issuedAt is not.
const ASSERTION_ISSUED_AT = NOW - 60_000, ASSERTION_EXPIRES_AT = NOW + 300_000;
const identity: VerifiedWebIdentity = { provider: gatewayIssuer, subject: "owner", tokenDigest: "",
  issuedAt: new Date(ASSERTION_ISSUED_AT).toISOString(), expiresAt: new Date(ASSERTION_EXPIRES_AT).toISOString(),
  verificationExpiresAt: new Date(ASSERTION_EXPIRES_AT).toISOString() };
const scope = { tenantId: ids.tenant, workspaceId: ids.workspace };

/** A signed Cloudflare-style access assertion for the seeded owner. */
function signOwnerAssertion(verified: VerifiedWebIdentity): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "skill-pg-key" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: gatewayTrust.issuer, aud: [gatewayTrust.audience],
    sub: verified.subject, type: "app",
    iat: ASSERTION_ISSUED_AT / 1000, exp: ASSERTION_EXPIRES_AT / 1000 })).toString("base64url");
  const body = `${header}.${claims}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
}

function pool(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  return { client: bound.client as DatabaseClient, config, close: () => bound.close() };
}

async function seed(admin: Client, assertion: string) {
  const at = new Date(NOW).toISOString();
  // The session row is NOT seeded here. `WebSessionAuthority.authenticated`
  // writes control_web_sessions itself from the verified identity's own token
  // digest, and seeding a row as well produced an empty digest that violated
  // control_web_sessions_token_digest_check. The digest is derived from the
  // assertion below instead, so the identity the service sees is the one the
  // real gateway verifier produced.
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Skill PG')", [ids.tenant]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Skill PG')", [ids.workspace, ids.tenant]);
  await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    project_types,supported_read_operations,supported_commands,redaction_policy_version,cursor_retention_days)
    VALUES('adapter.control-room-native-ideas',$1,'control_room_native_ideas','1.0.0','control_room_native','online',
    '["business_validation"]'::jsonb,'["read_project"]'::jsonb,'[]'::jsonb,'v1',30)`, [ids.tenant]);
  await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human',$1,$3,$4,'active',$5,$5)`,
  [ids.owner, ids.tenant, gatewayIssuer, sha256Digest({ provider: gatewayIssuer, subject: "owner" }), at]);
  await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`, [ids.ownerGrant, ids.tenant, ids.owner, at]);
  // The ordinary projects are created through the REAL project service, so
  // every column the project view reads is one the product itself wrote. A
  // hand-rolled INSERT would have to guess at the adapter id and the manual
  // project head the view joins on; getting either wrong makes the read fail
  // as `not_found` for reasons that have nothing to do with skills.
  const { WebProjectService } = await import("../src/web/v1/project-service");
  const projects = oneConnection(admin);
  const service = new WebProjectService(projects, scope, () => NOW);
  const first = await service.create(identity, { title: "Skill project", summary: "Owns the retained skills." },
    "skill-pg-project-001");
  const second = await service.create(identity, { title: "Second project", summary: "A different project entirely." },
    "skill-pg-project-002");
  ids.project = first.project.projectId;
  ids.second = second.project.projectId;
}

test("M3-SKILL-U03/U04/U05 on real PostgreSQL, as the production web login", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const assertion = signOwnerAssertion(identity);
    // The verifier derives `tokenDigest` from the assertion itself, and the
    // session authority writes that digest into control_web_sessions. Carrying
    // the real one here means the identity and the session agree by
    // construction rather than by coincidence.
    identity.tokenDigest = `sha256:${createHash("sha256").update(assertion).digest("hex")}`;
    const admin = new Client(postgres.admin({ database: postgres.database })); await admin.connect();
    try { await seed(admin, assertion); } finally { await admin.end(); }
    const web = pool(postgres, "web");
    try {
      const skills = new ReusableSkillServiceV1(web.client, scope, () => NOW);

      // ---- M3-SKILL-U03: two versions of one skill on one task --------------
      const skill = await skills.create(identity, ids.project,
        { name: "Evidence review", instructions: "Cite the retained evidence." }, "action:pg-u03");
      await skills.update(identity, ids.project, skill.skillId,
        { expectedVersion: 1, instructions: "Cite the retained evidence and the date." });
      // The reference list is refused AT VALIDATION, as a named invalid
      // request, before any row is written. Before the fix these two
      // references passed the schema and collided on the binding table's
      // (tenant, job, skill_id) primary key.
      const { WebAccessError } = await import("../src/web/v1/access-verifier");
      await assert.rejects(resolveReusableSkillsInSessionV1(
        { query: web.client.query } as never, { tenantId: ids.tenant, projectId: ids.project },
        [{ skillId: skill.skillId, version: 1 }, { skillId: skill.skillId, version: 2 }]),
      (error: unknown) => error instanceof WebAccessError && error.code === "invalid_request",
      "two versions of one skill must be a named invalid request, not a duplicate key");

      // The same refusal through the binding entry point, with nothing written.
      const bindingClient = new Client(postgres.connection("web")); await bindingClient.connect();
      try {
        const { bindReusableSkillsToTaskInSessionV1 } = await import("../src/skills/v1");
        const jobId = await proposedJob(bindingClient, ids.project);
        await assert.rejects(bindReusableSkillsToTaskInSessionV1(
          { query: bindingClient.query.bind(bindingClient) } as never,
          { tenantId: ids.tenant, projectId: ids.project, jobId, boundAt: new Date(NOW).toISOString(),
            references: [{ skillId: skill.skillId, version: 1 }, { skillId: skill.skillId, version: 2 }] }),
        (error: unknown) => error instanceof WebAccessError && error.code === "invalid_request");
        assert.equal((await bindingClient.query("SELECT 1 FROM control_task_skill_bindings WHERE job_id=$1",
          [jobId])).rowCount, 0, "no binding row may survive the refusal");
      } finally { await bindingClient.end(); }

      // ---- M3-SKILL-U04: a lost reply, then the exact retry -----------------
      // The REAL HTTP route, reached through the production gateway trust
      // (a signed assertion verified by the real access verifier), so the
      // action key arrives as a real request header and the identity is
      // verified the way it is in production - not handed to the service.
      const jwt = assertion;
      const route = createReusableSkillHttpHandlerV1({ origin: "https://control.invalid", service: skills,
        trust: gatewayTrust, clock: () => NOW });
      const post = (body: unknown, key: string) => route(postFor(body, key, ids.project, jwt));
      const body = { name: "Lost reply", instructions: "A create whose reply never arrived." };
      const actionKey = newSkillCreateActionKeyV1();
      const first = await post(body, actionKey);
      assert.equal(first.status, 201, `the first create must succeed: ${first.status} ${await first.clone().text()}`);
      const firstReceipt = await first.json() as { skillId: string; replayed: boolean };
      assert.equal(firstReceipt.replayed, false);

      // THE REPRODUCTION: 50 identical replays of the same owner action. Before
      // the fix each minted a fresh skill:<uuid> - the same name and
      // instructions, indistinguishable from the original.
      const receipts = [firstReceipt];
      for (let index = 0; index < 50; index += 1) {
        const replay = await post(body, actionKey);
        assert.equal(replay.status, 201);
        receipts.push(await replay.json() as { skillId: string; replayed: boolean });
      }
      assert.equal(new Set(receipts.map(receipt => receipt.skillId)).size, 1,
        "every replay of one action must return the one skill it created");
      assert.equal(receipts.filter(receipt => !receipt.replayed).length, 1,
        "exactly one of the 51 requests may be the original");
      assert.equal((await web.client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control_skills WHERE tenant_id=$1 AND name='Lost reply'",
        [ids.tenant])).rows[0]?.count, "1", "one action, one skill");

      // A deliberate duplicate still works: same content, NEW action key.
      const deliberate = await post(body, newSkillCreateActionKeyV1());
      assert.equal(deliberate.status, 201);
      const deliberateReceipt = await deliberate.json() as { skillId: string };
      assert.notEqual(deliberateReceipt.skillId, firstReceipt.skillId,
        "a new action is a new skill, by design");
      // ...and the same key with DIFFERENT content is a conflict, not a replay.
      const changed = await post({ ...body, instructions: "Different text entirely." }, actionKey);
      assert.equal(changed.status, 409, "reusing a key for different content is a conflict");

      // ---- M3-SKILL-U05: the 101st skill is reachable -----------------------
      // Fill the project past one page. The names sort BEFORE the two created
      // above so the interesting skill is the one that falls off the end, which
      // is the shape QA reproduced: 100 earlier skills, then one more, and the
      // list silently omitted it.
      for (let index = 0; index < 100; index += 1) {
        await skills.create(identity, ids.project, {
          name: `Filler ${String(index).padStart(3, "0")}`, instructions: `Filler instruction ${index}.` },
        `action:pg-filler-${String(index).padStart(3, "0")}`);
      }
      const last = await skills.create(identity, ids.project,
        { name: "Z the skill after the page", instructions: "The one a capped list would hide." }, "action:pg-last");
      const page = await skills.list(identity, ids.project);
      assert.equal(page.skills.length, 100, "a full page");
      assert.equal(page.skills.some(item => item.skillId === last.skillId), false,
        "the skill past the page is not on the first page, as expected");
      assert.notEqual(page.nextCursor, null, "a full page must declare that more exist");
      assert.equal(page.skills.length, 100, "a full page");
      assert.notEqual(page.nextCursor, null, "a full page must declare that more exist");
      const second = await skills.list(identity, ids.project, page.nextCursor!);
      assert.ok(second.skills.length >= 1, "the following page is not empty");
      const listed = new Set([...page.skills, ...second.skills].map(item => item.skillId));
      const stored = await web.client.query<{ skill_id: string }>(
        "SELECT skill_id FROM control_skills WHERE tenant_id=$1 AND project_id=$2", [ids.tenant, ids.project]);
      assert.equal(listed.size, stored.rows.length,
        "every stored skill is reachable through the list, none dropped");
      assert.equal([...page.skills, ...second.skills].some(item => item.skillId === last.skillId), true,
        "the 101st skill is reachable on the following page");
      // A forged cursor yields an empty page, never a forged one.
      const forged = await skills.list(identity, ids.project, "skill:does-not-exist");
      assert.deepEqual(forged.skills, []);
      assert.equal(forged.nextCursor, null);

      // The cursor is used EXACTLY as the query string decodes it. A
      // double-encoded value must not be decoded twice into a real skill id.
      const forgedCursor = encodeURIComponent(encodeURIComponent(last.skillId));
      const doubleDecoded = new URL(`https://control.invalid/api/v1/projects/${encodeURIComponent(ids.project)}/skills?after=${forgedCursor}`);
      assert.equal(new URLSearchParams(doubleDecoded.search).get("after"), encodeURIComponent(last.skillId),
        "the query string is decoded exactly once before the service sees it");
      const next = await route(new Request(doubleDecoded, {
        method: "GET", redirect: "error",
        headers: { "cf-access-jwt-assertion": assertion, origin: "https://control.invalid" } }));
      // 400, not 200: the once-decoded value is `skill%3A...`, which carries a
      // percent sign and so fails the skill-id grammar before it can name a
      // row. Had the handler decoded a second time it would have become a
      // valid id and this would be a 200 naming a skill the caller never
      // received.
      assert.equal(next.status, 400,
        "a double-encoded cursor is refused rather than decoded into a real skill id");

      // An unexpected query parameter is still refused, so nothing is silently
      // ignored.
      const unexpected = await route(new Request(
        `https://control.invalid/api/v1/projects/${encodeURIComponent(ids.project)}/skills?limit=5`,
        { method: "GET", redirect: "error",
          headers: { "cf-access-jwt-assertion": assertion, origin: "https://control.invalid" } }));
      assert.equal(unexpected.status, 400, "an unexpected query parameter is refused");

      // The private web login may write its own action receipts and nothing else.
      const direct = new Client(postgres.connection("web")); await direct.connect();
      try {
        await assert.rejects(direct.query("UPDATE control_skill_create_actions SET result='{}'"),
          /permission denied|append-only/u);
        await assert.rejects(direct.query("DELETE FROM control_skill_create_actions"),
          /permission denied|append-only/u);
      } finally { await direct.end(); }
    } finally { await web.close(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 300_000 });
});

/** The create request the gateway transport accepts. */
function postFor(body: unknown, key: string, projectId: string, jwt: string) {
  return new Request(`https://control.invalid/api/v1/projects/${encodeURIComponent(projectId)}/skills`, {
    method: "POST", redirect: "error",
    // `requireSameOrigin` refuses any mutating request whose `origin` header is
    // not the configured one, so a real browser create carries it and so must
    // this one. Omitting it is a 403 from the origin check, not from the
    // identity check.
    headers: { "content-type": "application/json", "idempotency-key": key,
      "cf-access-jwt-assertion": jwt, origin: "https://control.invalid" },
    body: JSON.stringify(body) });
}

/** One ordinary proposed job for a project, through the production task
 * service, so the binding table's foreign key is satisfiable. */
async function proposedJob(client: Client, projectId: string): Promise<string> {
  const { WebTaskService } = await import("../src/web/v1/task-service");
  const service = new WebTaskService(oneConnection(client), scope, () => NOW);
  const receipt = await service.propose(identity, projectId, {
    title: "Bind the retained skill", instructions: "Cite the retained evidence before acting." },
  // The ordinary task service's idempotency-key grammar admits letters, digits,
  // colon, underscore and dash only - no dot - so the key is written in that
  // shape rather than one this helper alone would accept.
  "u03-job-0001");
  return receipt.receipt.jobId;
}

/** One connection as a `DatabaseClient`, the shape the private web host
 * composes: a query, a transaction, and a pre-commit-checked transaction. */
function oneConnection(client: Client): DatabaseClient {
  const session = { query: async <T,>(sql: string, values?: unknown[]) =>
    ({ rows: (await client.query(sql, values as never[])).rows as T[] }) };
  return {
    query: session.query,
    transaction: async work => work(session),
    transactionWithPreCommitCheck: async (work, check) => { const value = await work(session); await check(); return value; },
  };
}

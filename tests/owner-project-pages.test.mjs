import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/index.ts";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session.ts";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process.ts";
import { createPrivateWebProcess } from "../src/web/v1/private-process.ts";
import { ownerProjectSectionsV1, ownerProjectSectionPageV1 } from "../src/web/v1/owner-project-pages.ts";
import { conformanceNow, conformanceOrigin, syntheticSigningKey, syntheticAccessTrust,
  syntheticAssertion } from "./helpers/private-owner-bootstrap-conformance.ts";

const origin = "http://127.0.0.1:3210", ownerCode = "synthetic-page-routing-owner-code";
const scope = { tenantId: "tenant:page-routing", workspaceId: "workspace:page-routing" };
const projectId = "project:page-routing", foreignId = "project:other-owner";
const instant = new Date(conformanceNow).toISOString();
const sections = ["inbox", "agents", "reviews", "activity", "files", "settings", "automations", "improvements", "coordination"];

function localApp(client) {
  return createMacLocalWebProcessV1({ origin, ...scope, clock: () => conformanceNow,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: scope.tenantId,
      provider: "local", subject: "synthetic-page-owner", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    database: { client, close: async () => {}, isAvailable: () => true } });
}
async function signIn(app) {
  const response = await app.handle(new Request(`${origin}/api/v1/local-owner-session`, { method: "POST",
    headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }), () => new Response());
  assert.equal(response.status, 201);
  const cookie = response.headers.get("set-cookie"); assert.ok(cookie); return cookie;
}

// A database-port stub, not a PostgreSQL fixture. Real session/grant policy and
// project service still execute; unexpected queries fail instead of granting access.
function projectDatabase() {
  const sessions = new Map();
  const state = { outage: false, missing: false, queries: 0, projectReads: [] };
  const client = {
    async query(sql, parameters = []) {
      state.queries++;
      if (state.outage) throw new Error("synthetic_database_outage");
      if (sql.includes("SELECT id FROM control_identities")) return { rows: [{ id: "identity:page-owner" }] };
      if (sql.includes("INSERT INTO control_web_sessions")) {
        sessions.set(parameters[1], { identity_id: parameters[2], revoked_at: null,
          issued_at: parameters[3], expires_at: parameters[4] }); return { rows: [] };
      }
      if (sql.includes("FROM control_web_sessions")) return { rows: [sessions.get(parameters[1])].filter(Boolean) };
      if (sql.includes("FROM control_role_grants")) return { rows: [{ id: "grant:page-owner", role_key: "owner",
        allowed_actions: ["projects.read"], project_ids: [projectId], risk_ceiling: "low",
        allow_external_effects: false, require_strong_factor: false, expires_at: null, revoked_at: null }] };
      if (sql.includes("FROM projects p") && sql.includes("p.id=$3")) {
        assert.deepEqual(parameters.slice(0, 2), [scope.tenantId, scope.workspaceId]);
        state.projectReads.push(parameters[2]);
        return { rows: parameters[2] === projectId && !state.missing ? [{ id: projectId,
          adapter_id: `adapter:manual:${sha256Digest(scope).slice(7, 39)}`, payload: {}, title: "Synthetic project",
          summary: "Page routing proof", lifecycle: "active", version: 1, created_at: instant, updated_at: instant }] : [] };
      }
      throw new Error("unexpected_page_query");
    },
    async transaction(operation) { return operation(client); },
    async transactionWithPreCommitCheck(operation, check) {
      await new Promise(resolve => setImmediate(resolve));
      const result = await operation(client); await check(client); return result;
    },
  };
  return { client, state };
}

test("Mac-local coordination keeps sibling project authorization under a 50-request burst", { timeout: 30_000 }, async t => {
  const { client, state } = projectDatabase(), app = localApp(client); t.after(() => app.close());
  let rendered = 0;
  const send = (id = projectId, cookie, suffix = "", section = "coordination") => app.handle(
    new Request(`${origin}/projects/${encodeURIComponent(id)}/${section}${suffix}`, { headers: cookie ? { cookie } : {} }),
    () => { rendered++; return new Response("authorized owner page"); });
  const signedOut = await send();
  assert.equal(signedOut.status, 303); assert.equal(signedOut.headers.get("location"), `${origin}/session`);
  assert.equal(rendered, 0); assert.equal(state.queries, 0);
  const cookie = await signIn(app);
  for (const section of ["agents", "coordination"]) {
    const response = await send(projectId, cookie, "", section);
    assert.equal(response.status, 200); assert.equal(await response.text(), "authorized owner page");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const before = rendered;
  const responses = await Promise.all(Array.from({ length: 50 }, (_, index) =>
    send(index % 2 ? foreignId : projectId, cookie)));
  assert.deepEqual(responses.map(r => r.status), Array.from({ length: 50 }, (_, i) => i % 2 ? 403 : 200));
  assert.equal(rendered - before, 25);
  assert.ok(state.projectReads.every(id => id === projectId), "the other project is refused before its records are read");
  state.missing = true; assert.equal((await send(projectId, cookie)).status, 404); state.missing = false;
  state.outage = true; assert.equal((await send(projectId, cookie)).status, 503); state.outage = false;
  assert.equal((await send(projectId, cookie)).status, 200, "retry after a failed database read");
  const beforeInvalid = rendered, beforeQueries = state.queries;
  assert.equal((await send("bad/id", cookie)).status, 404);
  assert.equal((await send(projectId, cookie, "?after=unexpected")).status, 400);
  assert.equal((await app.handle(new Request(`${origin}/projects/%ZZ/coordination`, { headers: { cookie } }),
    () => { throw new Error("malformed ID rendered"); })).status, 404);
  assert.equal(state.queries, beforeQueries); assert.equal(rendered, beforeInvalid);
  const revoked = await app.handle(new Request(`${origin}/api/v1/local-owner-session`, { method: "DELETE",
    headers: { cookie, origin } }), () => new Response());
  assert.equal(revoked.status, 204); assert.equal((await send(projectId, cookie)).status, 303);
});

test("both hosts reach every shared project section and preserve Mac-local setup and connect exceptions", { timeout: 30_000 }, async t => {
  assert.deepEqual(ownerProjectSectionsV1, sections);
  const client = { query: async () => { throw new Error("synthetic_database_boundary"); },
    transaction: async () => { throw new Error("synthetic_database_boundary"); },
    transactionWithPreCommitCheck: async () => { throw new Error("synthetic_database_boundary"); } };
  const local = localApp(client); t.after(() => local.close()); const cookie = await signIn(local);
  const key = syntheticSigningKey(), trust = syntheticAccessTrust(key);
  const hosted = createPrivateWebProcess({ origin: conformanceOrigin, issuer: trust.issuer, audience: trust.audience,
    ...scope, maxSessionSeconds: 3600, loadKeys: async () => trust.keys, clock: () => conformanceNow,
    database: { client, close: async () => {} } }); t.after(() => hosted.close());
  const assertion = syntheticAssertion(key);
  const localSend = (path, signedIn = true) => local.handle(new Request(origin + path,
    { headers: signedIn ? { cookie } : {} }), () => new Response("local shell"));
  const hostedSend = path => hosted.handle(new Request(conformanceOrigin + path,
    { headers: { "cf-access-jwt-assertion": assertion } }), () => new Response("hosted shell"));
  for (const section of sections) {
    const path = `/projects/${projectId}/${section}`;
    assert.equal(ownerProjectSectionPageV1.exec(path)?.[2], section);
    assert.equal((await localSend(path)).status, 503, `Mac-local ${section} reaches its database boundary`);
    assert.equal((await hostedSend(path)).status, 503, `hosted ${section} reaches its database boundary`);
  }
  assert.equal((await localSend(`/projects/${projectId}/settings?unexpected=1`)).status, 400);
  assert.equal((await hostedSend(`/projects/${projectId}/settings?unexpected=1`)).status, 503,
    "hosted settings keeps its existing detail-route query behavior");
  for (const path of [`/projects/${projectId}/unknown`, `/projects/${projectId}/coordination/extra`]) {
    assert.equal(ownerProjectSectionPageV1.exec(path), null);
    assert.equal((await localSend(path)).status, 404); assert.equal((await hostedSend(path)).status, 404);
  }
  // These documented top-level exceptions remain shell-only on Mac-local.
  // Hosted-only modules keep their own routes, outside the shared project list.
  for (const [path, hostedStatus] of [["/workers/connect", 404], ["/setup", 404], ["/settings", 503]]) {
    assert.equal((await localSend(path)).status, 200);
    assert.equal((await hostedSend(path)).status, hostedStatus);
    assert.equal((await localSend(path, false)).status, 303);
    assert.equal((await localSend(path + "?unexpected=1")).status, 400);
  }
});

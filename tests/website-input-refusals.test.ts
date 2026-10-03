import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseClient } from "../src/persistence/database";
import { sha256Digest } from "../src/security";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { createMacLocalPasskeyRegistrationPortV1 } from "../src/web/v1/mac-local-host";
import { projectCreateSchema } from "../src/web/v1/project-wire";

// Exact character cases from Fable's pre-04-repro, plus the pre-02 NUL case.
const badText = ["a\ud800b", "a\udc00b", "a\ude00\ud83db", "a\u0000b"];
const origin = "http://127.0.0.1:3210", ownerCode = "input-refusal-owner-code-long-enough";
const now = Date.parse("2026-10-01T00:00:00.000Z");

function appWith(client: DatabaseClient, clock = () => now) {
  return createMacLocalWebProcessV1({ origin, workspaceId: "workspace:unit",
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: "tenant:unit",
      provider: "local", subject: "owner:unit", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    database: { client, close: async () => {}, isAvailable: () => true }, clock,
    passkeyRegistration: createMacLocalPasskeyRegistrationPortV1(client) });
}
async function signIn(app: ReturnType<typeof appWith>) {
  const response = await app.handle(new Request(`${origin}/api/v1/local-owner-session`, { method: "POST",
    headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }), () => new Response());
  assert.equal(response.status, 201);
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

test("FB-1: project title and summary refuse PostgreSQL-invalid text before any database call", async () => {
  let queries = 0;
  const client = { query: async () => { queries++; throw new Error("storage must not be reached"); },
    transaction: async () => { queries++; throw new Error("storage must not be reached"); } } as unknown as DatabaseClient;
  const app = appWith(client);
  try {
    const cookie = await signIn(app);
    for (const field of ["title", "summary"] as const) for (const value of badText) {
      const response = await app.handle(new Request(`${origin}/api/v1/projects`, { method: "POST",
        headers: { cookie, origin, "content-type": "application/json", "idempotency-key": "unit-invalid-text-0001" },
        body: JSON.stringify({ title: "Title", summary: "Summary", [field]: value }) }), () => new Response());
      assert.equal(response.status, 400, `${field}: ${JSON.stringify(value)}`);
      assert.deepEqual(await response.json(), { error: "invalid_request" });
    }
    assert.equal(queries, 0);
    for (const value of ["a😀b", "a\u202eb", "a\ufeffb", "é漢字", "a\\u0000b"]) {
      assert.equal(projectCreateSchema.safeParse({ title: value, summary: value }).success, true);
    }
    assert.equal(projectCreateSchema.safeParse({ title: "Title", summary: "line\nline\r\ttext" }).success, true);
    assert.equal(projectCreateSchema.safeParse({ title: "a\u0001b", summary: "ok" }).success, false);
  } finally { await app.close(); }
});

test("FB-3: both Face ID routes explain unknown, expired or consumed links; outages stay 503", async () => {
  let time = now;
  let fault: "closed" | "outage" | "privilege" | "race" | "otherRace" | "open" = "closed";
  let reads = 0, inserts = 0;
  const options = { publicKey: { challenge: "A".repeat(43) } };
  const client = { async query(statement: string) {
    if (statement.includes("current_setting('search_path')")) return { rows: [{ path: "pg_catalog, public" }] };
    if (statement.includes("pg_has_role")) return { rows: [{ is_web: true, replication_role: "origin" }] };
    if (fault === "outage") throw new Error("storage transport failed");
    if (statement.includes("passkey_open_registrations_web")) {
      reads++;
      return { rows: fault === "closed" ? [] : [{ registration_digest: `sha256:${"a".repeat(64)}`,
        mode: "initial", options_json: options, authorization_challenge: null }] };
    }
    if (statement.includes("INSERT INTO updater.passkey_registrations")) {
      inserts++;
      if (fault === "otherRace") {
        fault = "closed";
        throw Object.assign(new Error("database_unavailable"), { code: "database_unavailable", sqlState: "08006" });
      }
      if (fault === "race" || fault === "privilege") {
        if (fault === "race") fault = "closed";
        // Production sanitization retains SQLSTATE, not the DB's message.
        throw Object.assign(new Error("database_unavailable"), { code: "database_unavailable", sqlState: "42501" });
      }
      return { rows: [] };
    }
    throw new Error("unexpected statement");
  } } as unknown as DatabaseClient;
  const app = appWith(client, () => time);
  try {
    const cookie = await signIn(app);
    const send = (path: string, secret = "A".repeat(43)) => app.handle(new Request(`${origin}/api/v1/passkeys/registration${path}`, {
      method: "POST", headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify(path ? { registrationSecret: secret } : { registrationSecret: secret, comparisonCode: "ABC234",
        response: { id: Buffer.alloc(32, 1).toString("base64url"), rawId: Buffer.alloc(32, 1).toString("base64url"), type: "public-key", response: { clientDataJSON: "e30", attestationObject: "A".repeat(43), transports: [] } },
        authorizationAssertion: null }) }), () => new Response());
    for (const path of ["/options", ""]) {
      // Preserve fifty admitted expired-link checks on each route while also
      // exercising the new attempt limit with a fifty-request burst. Advance
      // the injected clock between windows; no real waiting is needed.
      for (let window = 0; window < 5; window++) {
        time += 60_000;
        const results = await Promise.all(Array.from({ length: window === 0 ? 50 : 10 }, () => send(path)));
        for (const response of results.slice(0, 10)) {
          assert.equal(response.status, 410);
          const body = await response.json() as { error: string; message: string };
          assert.equal(body.error, "registration_expired");
          assert.match(body.message, /installer.*start again/i);
          assert.equal(response.headers.get("cache-control"), "no-store");
        }
        for (const response of results.slice(10)) {
          assert.equal(response.status, 429);
          assert.equal(response.headers.get("retry-after"), "60");
          assert.equal(response.headers.get("cache-control"), "no-store");
          assert.equal((await response.json() as { error: string }).error, "owner_attempt_limit");
        }
      }
      time += 60_000;
      assert.equal((await send(path, "short")).status, 400);
      fault = "outage";
      const outage = await send(path);
      assert.equal(outage.status, 503);
      assert.deepEqual(await outage.json(), { error: "service_unavailable" });
      fault = "closed";
      assert.equal((await send(path)).status, 410, "retry after a failed request");
    }
    assert.equal(inserts, 0, "an unknown or expired link never attempts an insert");
    fault = "open";
    assert.equal((await send("/options")).status, 200);
    assert.equal((await send("")).status, 201);
    fault = "privilege";
    assert.equal((await send("")).status, 503, "a permission failure on an open link is an outage");
    fault = "race";
    assert.equal((await send("")).status, 410, "expiry or consumption between read and insert");
    fault = "otherRace";
    assert.equal((await send("")).status, 503, "an unrelated storage failure stays an outage even if the link closes");
    assert.ok(reads > 100);
  } finally { await app.close(); }
});

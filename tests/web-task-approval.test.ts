import test from "node:test";
import assert from "node:assert/strict";
import { canonicalApprovalStorageFixture } from "./helpers/canonical-approval-storage";
import { taskStartupFixture } from "./helpers/task-startup";
import { createPrivateTaskBootstrap } from "../src/web/v1/private-task-startup";
import type { PrivateApplication } from "../src/web/v1/private-process";
import { request } from "./helpers/web-foundation";
import { sha256Digest } from "../src/security";
import { binding } from "./hermes-native-fixture";

async function fixture() {
  const f = await canonicalApprovalStorageFixture(), startup = await taskStartupFixture(f.assignmentFixture);
  let app!: PrivateApplication;
  const approvals = { enrollments: [{ enrollment: f.prepared.enrollment, nodeClass: "personal-compute" }], store: f.store };
  const config = { ...startup.config, coordinator: { ...startup.config.coordinator, approvals } };
  const bootstrap = createPrivateTaskBootstrap({ clock: f.clock, openDatabase: startup.openDatabase, install: value => { app = value; } });
  const runtime = await bootstrap.start(config);
  const path = `/api/v1/projects/${encodeURIComponent(f.args[1])}/tasks/${encodeURIComponent(f.args[2])}/approval`;
  const make = (method = "GET", body?: unknown, suffix = method === "GET" ? `?inputDigest=${encodeURIComponent(f.args[3])}` : "") => request(path + suffix, method, body, undefined, f.jwt);
  const handle = (r: Request) => app.handle(r, () => new Response("shell"));
  return { ...f, startup, config, path, make, handle, runtime,
    close: async () => { await runtime.close(); await f.close(); } };
}
test("stored approval without a configured queue does not enable HTTP submission", async t => {
  const f = await fixture(); t.after(f.close);
  await f.handle(f.make("POST", { action: "store", expectedInputDigest: f.args[3], packet: f.packet }));
  const req = request(f.path.replace(/approval$/, "submission"), "POST", {
    expectedInputDigest: f.args[3], expectedPacketDigest: sha256Digest(f.packet),
  }, undefined, f.jwt);
  req.headers.delete("idempotency-key");
  assert.equal((await f.handle(req)).status, 503);
  const view = await f.handle(request(f.path.replace(/\/approval$/, ""), "GET", undefined, undefined, f.jwt));
  assert.equal(view.status, 200); assert.equal((await view.json()).dispatch, "not_connected");
  await f.raw.exec("SET SESSION AUTHORIZATION postgres");
  assert.equal((await f.db.query("SELECT * FROM control_native_task_queue")).rows.length, 0);
});
test("verified two-pool startup mounts protected review, signed intake and historical readback", async t => {
  const f = await fixture(); t.after(f.close);
  const prepare = await f.handle(f.make("POST", { action: "prepare", expectedInputDigest: f.args[3] }));
  assert.equal(prepare.status, 200, await prepare.clone().text()); const review = await prepare.json();
  assert.equal(review.signatureStatus, "unsigned"); assert.equal(review.operationDigest, f.prepared.request.operationDigest);
  for (const key of ["credentialRef", "canonicalDestination", "profilePolicyDigest", "qualificationDigest", "body", "enrollment"])
    assert.equal(key in review, false);
  const initial = await f.handle(f.make()); assert.equal((await initial.json()).receipt, null);
  const saved = await f.handle(f.make("POST", { action: "store", expectedInputDigest: f.args[3], packet: f.packet }));
  assert.equal(saved.status, 201, await saved.clone().text()); assert.equal((await saved.json()).receipt.packetDigest, sha256Digest(f.packet));
  assert.match(saved.headers.get("cache-control")!, /no-store/); assert.match(saved.headers.get("x-robots-tag")!, /noindex/);
  f.setNow(f.prepared.start.deadline + 1000); f.approvals.close();
  const read = await f.handle(f.make()); assert.equal(read.status, 200);
  const value = await read.json(); assert.equal(value.receipt.evidence, "stored_signatures_only"); assert.equal(value.receipt.grantsExecutionAuthority, false);
  assert.equal("packet" in value.receipt, false);
  await assert.rejects(f.startup.web.client.query("SELECT * FROM control_native_approval_packets"));
  await f.runtime.close(); assert.equal((await f.handle(f.make())).status, 503);
  assert.equal(f.startup.web.closes(), 1); assert.equal(f.startup.coordinator.closes(), 1);
});

test("approval endpoint denies missing identity, wrong origin, revoked role and malformed scope", async t => {
  const f = await fixture(); t.after(f.close);
  const missing = f.make(); missing.headers.delete("cf-access-jwt-assertion"); assert.equal((await f.handle(missing)).status, 401);
  const cross = f.make("POST", { action: "prepare", expectedInputDigest: f.args[3] });
  cross.headers.set("origin", "https://other.example.invalid"); assert.equal((await f.handle(cross)).status, 403);
  const crossRead = f.make(); crossRead.headers.set("sec-fetch-site", "cross-site"); assert.equal((await f.handle(crossRead)).status, 403);
  for (const suffix of ["", "?inputDigest=wrong", `?inputDigest=${encodeURIComponent(f.args[3])}&inputDigest=${encodeURIComponent(f.args[3])}`, `?inputDigest=${encodeURIComponent(f.args[3])}&extra=1`])
    assert.equal((await f.handle(f.make("GET", undefined, suffix))).status, 400);
  // Administrative fixture edit, outside either application LOGIN role.
  // PGlite RESET retains the latest session user; restore only this disposable setup role.
  await f.raw.exec("SET SESSION AUTHORIZATION postgres");
  await f.db.query("UPDATE control_role_grants SET role_key='operator' WHERE tenant_id=$1", [binding.tenantId]);
  assert.equal((await f.handle(f.make())).status, 403);
  assert.equal((await f.handle(f.make("POST", { action: "prepare", expectedInputDigest: f.args[3] }))).status, 403);
  assert.equal(await f.count(), 0);
});

test("intake rejects invalid signed files and oversized bodies without storing or starting", async t => {
  const f = await fixture(); t.after(f.close);
  for (const body of [{ action: "store", expectedInputDigest: f.args[3], packet: {} },
    { action: "prepare", expectedInputDigest: f.args[3], signerKey: "not-allowed" },
    { action: "store", expectedInputDigest: f.args[3], packet: f.packet, extra: "x".repeat(33_000) }])
    assert.equal((await f.handle(f.make("POST", body))).status, 400);
  const forged = structuredClone(f.packet); forged.approval.signature = "A".repeat(86);
  assert.equal((await f.handle(f.make("POST", { action: "store", expectedInputDigest: f.args[3], packet: forged }))).status, 503);
  assert.equal(await f.count(), 0);
});

test("invalid enrollment configuration fails before database opening", async t => {
  const f = await canonicalApprovalStorageFixture(); t.after(f.close); const startup = await taskStartupFixture(f.assignmentFixture);
  let opens = 0;
  const bootstrap = createPrivateTaskBootstrap({ clock: f.clock, openDatabase: () => { opens++; throw new Error(); }, install: () => { throw new Error(); } });
  await assert.rejects(bootstrap.start({ ...startup.config, coordinator: { ...startup.config.coordinator,
    approvals: { enrollments: [{ enrollment: { ...f.prepared.enrollment, tenantId: "tenant:other" }, nodeClass: "personal-compute" }], store: f.store } } }), /config_invalid/);
  assert.equal(opens, 0);
});

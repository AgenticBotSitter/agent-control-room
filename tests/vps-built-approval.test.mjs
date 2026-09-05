import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import handler from "../dist-vps/server/index.js";
import { createPrivateTaskBootstrap } from "../dist-vps/server/taskBootstrap.js";
import { installPrivateApplication } from "../dist-vps/server/runtime.js";
import { canonicalApprovalStorageFixture } from "./helpers/canonical-approval-storage.ts";
import { taskStartupFixture } from "./helpers/task-startup.ts";
import { request } from "./helpers/web-foundation.ts";

test("compiled protected application mounts approval review/intake/readback through verified two-pool startup", async t => {
  const f = await canonicalApprovalStorageFixture(); t.after(f.close);
  const startup = await taskStartupFixture(f.assignmentFixture);
  const bootstrap = createPrivateTaskBootstrap({ openDatabase: startup.openDatabase, install: installPrivateApplication, clock: f.clock });
  const runtime = await bootstrap.start({ ...startup.config, coordinator: { ...startup.config.coordinator,
    approvals: { enrollments: [{ enrollment: f.prepared.enrollment, nodeClass: "personal-compute" }], store: f.store } } });
  t.after(runtime.close);
  const path = `/api/v1/projects/${f.args[1]}/tasks/${f.args[2]}/approval`;
  const req = (method, body, suffix = "") => request(path + suffix, method, body, undefined, f.jwt);
  const prepared = await handler(req("POST", { action: "prepare", expectedInputDigest: f.args[3] }));
  assert.equal(prepared.status, 200, await prepared.clone().text()); assert.equal((await prepared.json()).signatureStatus, "unsigned");
  const saved = await handler(req("POST", { action: "store", expectedInputDigest: f.args[3], packet: f.packet }));
  assert.equal(saved.status, 201, await saved.clone().text());
  const read = await handler(req("GET", undefined, `?inputDigest=${encodeURIComponent(f.args[3])}`));
  assert.equal(read.status, 200); assert.equal((await read.json()).receipt.grantsExecutionAuthority, false);
  assert.equal((await handler(request("/api/v1/session/logout", "POST", undefined, undefined, f.jwt))).status, 204);
  assert.equal((await handler(req("GET", undefined, `?inputDigest=${encodeURIComponent(f.args[3])}`))).status, 401);
  await runtime.close(); assert.equal(startup.web.closes(), 1); assert.equal(startup.coordinator.closes(), 1);
});

test("approval trust, packet storage and server cryptography remain outside browser assets", () => {
  const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
  for (const file of files("dist-vps/client").filter(file => file.endsWith(".js")))
    assert.doesNotMatch(readFileSync(file, "utf8"), /PinnedApprovalTrustStore|control_native_approval_packets|native_approval_packet_unavailable|node:crypto/);
});

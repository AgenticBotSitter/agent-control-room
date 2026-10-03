import assert from "node:assert/strict";
import test from "node:test";
import { access } from "node:fs/promises";
import { readFile, readdir } from "node:fs/promises";
import handler from "../dist-vps/server/index.js";
import { installPrivateWebProcess } from "../dist-vps/server/runtime.js";
import { taskAssignmentFixture } from "./helpers/task-assignment.ts";
import { sha256Digest } from "../src/security/index.ts";
import { binding, instant } from "./hermes-native-fixture.ts";
import { at } from "./native-task-fixture.ts";
import { request, origin } from "./helpers/web-foundation.ts";

test("compiled assignment keeps scheduled planning and allocation server-only", async () => {
  const compiledScripts = async (root) => Promise.all((await readdir(root, { recursive: true }))
    .filter(path => path.endsWith(".js"))
    .map(path => readFile(new URL(path, root), "utf8")));
  // Vite may move server-only code into a shared server chunk. Check the whole
  // compiled server boundary, while refusing the same authority in client JS.
  const server = (await compiledScripts(new URL("../dist-vps/server/", import.meta.url))).join("\n");
  const client = (await compiledScripts(new URL("../dist-vps/client/", import.meta.url))).join("\n");
  assert.ok(server.includes("service:schedule-assignment:v1"));
  assert.ok(server.includes("scheduled.tasks.plan"));
  assert.equal(server.includes("api/v1/scheduled-assignment"), false);
  assert.equal(client.includes("service:schedule-assignment:v1"), false);
  assert.equal(client.includes("scheduled.tasks.plan"), false);
});

test("browser bundles never include server-only host-value security code", async () => {
  // host-value.ts reads node:util intrinsics at import time; in a browser
  // chunk it throws and blanks the page (the Mac-local Work page did this).
  const root = new URL("../dist-vps/client/", import.meta.url);
  for (const path of (await readdir(root, { recursive: true })).filter(item => item.endsWith(".js"))) {
    const text = await readFile(new URL(path, root), "utf8");
    assert.equal(text.includes("host intrinsics unavailable"), false, `server-only host-value code in ${path}`);
  }
});

// The artifact scan above only sees a leak once someone has rebuilt dist-vps,
// so a barrel import reintroduced into src/ is green until the next build. This
// reads the sources instead, which is the check that fails at the edit.
//
// The rule: a module reachable from a "use client" component must not import
// the `src/security` barrel. The barrel re-exports digest.ts and
// rollback-checkpoint.ts, which import host-value.ts, which throws at import
// time in a browser. The leaf that is safe to import directly is
// canonical-digest.ts (createHash only).
//
// Reachability is derived, not listed: it starts at every "use client" file
// under private-app/ and follows relative imports that stay inside the
// repository. A file may be added to the graph without editing this test.
test("no client-reachable module imports the server-only security barrel", async () => {
  const root = process.cwd();
  const read = async (relative) => readFile(`${root}/${relative}`, "utf8");
  const readable = async (path) => { try { await access(path); return true; } catch { return false; } };
  const clientRoots = (await readdir(`${root}/private-app/app`, { recursive: true }))
    .filter(path => path.endsWith(".tsx") || path.endsWith(".ts"));
  // Captures the whole import statement (group 1) and its specifier (group 2),
  // so a whole-statement `import type { ... } from "..."` can be told apart
  // from a value import: TypeScript erases the former before the bundler ever
  // sees it, so following it (or flagging a direct `import type` of
  // `../security`) would report a module that never actually reaches the
  // browser chunk.
  const importStatement = /(?:^|\s)(import[\s\S]*?from\s+["']([^"']+)["']\s*;?)/gu;
  const isTypeOnlyImport = (statement) => /^import\s+type\b/u.test(statement.trimStart());
  const resolveFrom = (from, specifier) => {
    const base = `${from.slice(0, from.lastIndexOf("/"))}/${specifier}`;
    const parts = [];
    for (const segment of base.split("/")) {
      if (segment === "." || segment === "") continue;
      if (segment === "..") parts.pop(); else parts.push(segment);
    }
    const joined = parts.join("/");
    return [joined, `${joined}.ts`, `${joined}.tsx`, `${joined}/index.ts`];
  };
  const queue = clientRoots.map(path => `private-app/app/${path}`);
  const seen = new Set();
  const offenders = [];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    let source;
    try { source = await read(file); } catch { continue; }
    for (const [, statement, specifier] of source.matchAll(importStatement)) {
      const typeOnly = isTypeOnlyImport(statement);
      if (!typeOnly && /\/security$/u.test(specifier)) offenders.push(file);
      if (typeOnly || !specifier.startsWith(".")) continue;
      for (const candidate of resolveFrom(file, specifier)) {
        if (seen.has(candidate)) continue;
        // Only enqueue a candidate that exists, so a missing file cannot mask
        // a later module by throwing here instead of being reported.
        if (await readable(`${root}/${candidate}`)) { queue.push(candidate); break; }
      }
    }
  }
  // A parser that silently matched nothing would make the walk vacuous.
  assert.ok(seen.size > clientRoots.length + 20,
    `the client walk reached only ${seen.size} files; it is not following imports`);
  assert.deepEqual(offenders.sort(), [],
    "a module reachable from a \"use client\" component imports the src/security barrel, which pulls host-value's import-time throw into browser chunks");
});

test("compiled private assignment API records, reads and expires a real lease under shared logout", async t => {
  const f = await taskAssignmentFixture(); let now = instant + 8000;
  const coordinator = f.create(f.db, () => now);
  const app = installPrivateWebProcess({ ...f.accessTrust, ...f.scope, origin, tasks: f.ownerKeys,
    assignment: coordinator.webOperation(), loadKeys: async () => f.accessTrust.keys,
    database: { client: f.db, close: f.close }, clock: () => now });
  t.after(() => app.close());
  const base = `/api/v1/projects/${f.prepared.receipt.projectId}/tasks/${f.prepared.receipt.jobId}`, path = `${base}/assignment`;
  const req = (url = path, method = "GET", body) => request(url, method, body, undefined, f.jwt);
  assert.deepEqual(Object.keys(coordinator.webOperation()).sort(),
    ["assign", "cancel", "expire", "options", "projectOptions", "revoke", "tenantId", "workspaceId"]);
  assert.equal("assignLocked" in coordinator, false);
  const options = await (await handler(req())).json(); assert.equal(options.candidates.length, 1); assert.equal(options.receipt, null);
  const draft = { action: "assign", expectedInputDigest: options.inputDigest, nodeId: options.candidates[0].nodeId };
  const anonymous = new Request(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(draft) });
  assert.equal((await handler(anonymous)).status, 401);
  const saved = await handler(req(path, "POST", draft)); assert.equal(saved.status, 201, await saved.clone().text());
  const { receipt } = await saved.json(); assert.equal(receipt.startsWork, false);
  assert.equal((await (await handler(req(base))).json()).task.state, "leased");
  assert.equal((await handler(req(path, "POST", draft))).status, 200);
  assert.equal((await (await handler(req())).json()).receipt.leaseId, receipt.leaseId);
  now = instant + 70_000;
  const expired = await handler(req(path, "POST", { action: "expire", expectedInputDigest: options.inputDigest }));
  assert.equal(expired.status, 201, await expired.clone().text()); assert.equal((await expired.json()).receipt.leaseState, "expired");
  const retryOptions = await (await handler(req())).json();
  assert.equal(retryOptions.candidates.length, 1, "a terminal reservation must expose a route again");
  const reassigned = await handler(req(path, "POST", { ...draft, nodeId: retryOptions.candidates[0].nodeId }));
  assert.equal(reassigned.status, 201, await reassigned.clone().text());
  const reassignedReceipt = (await reassigned.json()).receipt;
  assert.notEqual(reassignedReceipt.leaseId, receipt.leaseId);
  assert.equal(reassignedReceipt.leaseEpoch, 2);
  const reassignedDetail = await (await handler(req(base))).json();
  assert.equal(reassignedDetail.attempts[0].attemptNumber, 2);
  assert.equal(reassignedDetail.task.state, "leased");
  assert.equal((await handler(req("/api/v1/session/logout", "POST"))).status, 204);
  assert.equal((await handler(req())).status, 401);
});

test("locked assignment preserves owner replay and node capacity", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  const coordinator = f.create(f.db, () => instant + 8000, [{ ...f.route, maxConcurrentTasks: 2 }]);
  const first = await coordinator.assign(f.identity, binding.projectId, f.prepared.receipt.jobId,
    binding.nodeId, f.prepared.receipt.inputDigest);
  assert.equal(first.replayed, false);
  const replay = await coordinator.assign(f.identity, binding.projectId, f.prepared.receipt.jobId,
    binding.nodeId, f.prepared.receipt.inputDigest);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, first.receipt);

  const secondDraft = { ...f.sourceDraft, title: "Compare two more launch ideas" };
  const secondSource = await f.tasks.propose(f.identity, binding.projectId, secondDraft, "assignment-source-capacity-002");
  const second = await f.planner.plan(f.identity, binding.projectId, secondSource.receipt.jobId, sha256Digest(secondDraft));
  await assert.rejects(coordinator.assign(f.identity, binding.projectId, second.receipt.jobId,
    binding.nodeId, second.receipt.inputDigest), { message: "conflict" });
  const active = await f.db.query("SELECT id FROM control_leases WHERE tenant_id=$1 AND node_id=$2 AND state='active'",
    [f.scope.tenantId, binding.nodeId]);
  assert.equal(active.rows.length, 2);
});

test("locked assignment preserves current fleet eligibility refusal", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  const critical = { ...f.telemetry, sequence: 2, observedAt: at(7000), fingerprint: sha256Digest("critical-telemetry"),
    payload: { ...f.telemetry.payload, thermalState: "critical" } };
  await f.signals.ingestAuthenticated(critical, at(7000), binding);
  await assert.rejects(f.assign(), { message: "conflict" });
  const attempts = await f.db.query("SELECT id FROM control_attempts WHERE tenant_id=$1 AND job_id=$2",
    [f.scope.tenantId, f.prepared.receipt.jobId]);
  const leases = await f.db.query("SELECT id FROM control_leases WHERE tenant_id=$1 AND job_id=$2",
    [f.scope.tenantId, f.prepared.receipt.jobId]);
  assert.equal(attempts.rows.length, 0); assert.equal(leases.rows.length, 0);
});

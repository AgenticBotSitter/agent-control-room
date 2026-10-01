import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { UpdaterControlServerV1, requestVerifiedAdminSocketV1,
  sendControlRequestV1 } from "../src/updater/v1/control-socket.mjs";

async function rootV1(t) {
  const root = realpathSync(mkdtempSync("/private/tmp/updater-control-"));
  t.after(async () => { await import("node:fs/promises").then(fs => fs.rm(root, { recursive: true, force: true })); });
  await mkdir(join(root, "updater-state")); return root;
}
const requestV1 = index => ({ schema: "control-room.updater-control/v1", requestId: `request-${index}`,
  verb: "pause", arguments: [] });

test("control.sock is owner-only, bounded, validates input, and survives a dropped client", async t => {
  const root = await rootV1(t), server = new UpdaterControlServerV1({ root, handler: async request => request.requestId });
  const path = await server.start(); t.after(() => server.stop());
  const entry = await lstat(path); assert.ok(entry.isSocket()); assert.equal(entry.mode & 0o777, 0o600);
  assert.equal(await sendControlRequestV1(path, requestV1("ok")), "request-ok");
  assert.equal(await sendControlRequestV1(path, { ...requestV1("passkey"), verb: "passkey-list" }),
    "request-passkey", "the narrow passkey verbs use the same root-only socket");
  await assert.rejects(sendControlRequestV1(path, { ...requestV1("bad"), verb: "install" }),
    /updater_request_refused/u, "an R14 sudo-only verb cannot cross the socket");

  const dropped = createConnection(path); await new Promise(resolve => dropped.once("connect", resolve));
  dropped.write('{"schema":"control-room.updater-control/v1"'); dropped.destroy();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await sendControlRequestV1(path, requestV1("retry")), "request-retry",
    "a retry after a dropped connection is accepted");
});

test("a 50-request burst is serviced and the caller beyond the limit is refused busy", async t => {
  const root = await rootV1(t);
  const server = new UpdaterControlServerV1({ root, maximumConnections: 50,
    handler: async request => request.requestId });
  const path = await server.start(); t.after(() => server.stop());
  // Hold 50 slow/partial clients at the boundary, then prove caller 51 gets a
  // bounded busy response rather than consuming another handler.
  const held = await Promise.all(Array.from({ length: 50 }, () => new Promise((resolve, reject) => {
    const socket = createConnection(path); socket.once("connect", () => { socket.write("{"); resolve(socket); });
    socket.once("error", reject);
  })));
  for (let tries = 0; server.activeConnections !== 50 && tries < 50; tries += 1)
    await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(server.activeConnections, 50);
  await assert.rejects(sendControlRequestV1(path, requestV1("over-limit")), error => error?.code === "busy");
  for (const socket of held) socket.destroy();
  for (let tries = 0; server.activeConnections !== 0 && tries < 50; tries += 1)
    await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(server.activeConnections, 0);
  const burst = Array.from({ length: 50 }, (_, index) => sendControlRequestV1(path, requestV1(index)));
  const results = await Promise.all(burst);
  assert.equal(results.length, 50); assert.equal(new Set(results).size, 50);
});

test("an absolute request deadline evicts a slowloris that keeps sending bytes", async t => {
  let handled = 0;
  const root = await rootV1(t), server = new UpdaterControlServerV1({ root, requestTimeoutMs: 60,
    handler: async request => { handled += 1; return request.requestId; } });
  const path = await server.start(); t.after(() => server.stop());
  const socket = createConnection(path); await new Promise((resolve, reject) => {
    socket.once("connect", resolve); socket.once("error", reject);
  });
  const drip = setInterval(() => { if (!socket.destroyed) socket.write("{"); }, 10);
  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("slowloris_not_evicted")), 500);
      socket.once("close", () => { clearTimeout(deadline); resolve(); });
    });
  } finally { clearInterval(drip); }
  for (let tries = 0; server.activeConnections !== 0 && tries < 50; tries += 1)
    await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(server.activeConnections, 0); assert.equal(handled, 0);
  assert.equal(await sendControlRequestV1(path, requestV1("after-slowloris")), "request-after-slowloris");
  assert.equal(handled, 1);
});

test("a planted socket symlink or ordinary file is refused without removing its target", async t => {
  const root = await rootV1(t), target = join(root, "target"); await writeFile(target, "keep");
  const path = join(root, "updater-state/control.sock"); await symlink(target, path);
  const symlinked = new UpdaterControlServerV1({ root, handler: async () => ({}) });
  await assert.rejects(symlinked.start(), /updater_symlink_refused/u);
  assert.equal(await readFile(target, "utf8"), "keep");
  await (await import("node:fs/promises")).unlink(path); await writeFile(path, "ordinary"); await chmod(path, 0o600);
  await assert.rejects(new UpdaterControlServerV1({ root, handler: async () => ({}) }).start(),
    /updater_control_path_refused/u);
});

test("an overlong macOS control socket path is refused before listen", async t => {
  const root = await rootV1(t);
  const socketPath = `updater-state/${"x".repeat(104)}`;
  await assert.rejects(new UpdaterControlServerV1({ root, socketPath, handler: async () => ({}) }).start(),
    error => error?.code === "updater_control_socket_path_too_long");
});

test("an admin socket needs the service uid, fixed magic and a bounded primitive-only reply", async t => {
  const root = await rootV1(t), path = join(root, "updater-state/admin.sock");
  let magic = "CONTROL-ROOM-ADMIN/1", body = { ok: true, state: "running", pid: process.pid, generation: 2 };
  const admin = createServer(socket => socket.on("data", () => socket.end(`${magic}\n${JSON.stringify(body)}\n`)));
  await new Promise((resolve, reject) => { admin.once("error", reject); admin.listen(path, resolve); });
  t.after(() => new Promise(resolve => admin.close(resolve)));
  const expectedUid = (await lstat(path)).uid;
  assert.equal((await requestVerifiedAdminSocketV1({ root, socketPath: "updater-state/admin.sock", expectedUid,
    request: { command: "drain" } })).state, "running");
  await assert.rejects(requestVerifiedAdminSocketV1({ root, socketPath: "updater-state/admin.sock",
    expectedUid: expectedUid + 1, request: {} }), /updater_admin_socket_owner_refused/u);
  magic = "WRONG";
  await assert.rejects(requestVerifiedAdminSocketV1({ root, socketPath: "updater-state/admin.sock", expectedUid,
    request: {} }), /updater_admin_magic_refused/u);
  magic = "CONTROL-ROOM-ADMIN/1"; body = { ok: true, path: "untrusted" };
  await assert.rejects(requestVerifiedAdminSocketV1({ root, socketPath: "updater-state/admin.sock", expectedUid,
    request: {} }), /updater_admin_reply_refused/u);
});

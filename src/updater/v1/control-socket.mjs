import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { assertNoSymlinkBelowV1 } from "./fs-safety.mjs";
import { assertPlainObjectV1, parseControlRequestV1, updaterRefuseV1 } from "./contracts.mjs";

const ADMIN_MAGIC_V1 = "CONTROL-ROOM-ADMIN/1";

/** R-FS admin-socket boundary: lstat/no symlink, exact service uid, fixed magic,
 * bounded reply, and only primitive values returned to the root caller. */
export async function requestVerifiedAdminSocketV1({ root, socketPath, expectedUid, request, timeoutMs = 5_000 }) {
  const path = await assertNoSymlinkBelowV1(root, socketPath);
  const entry = await lstat(path);
  if (!entry.isSocket() || entry.uid !== expectedUid) throw updaterRefuseV1("updater_admin_socket_owner_refused");
  const reply = await new Promise((resolveReply, reject) => {
    const socket = createConnection(path); let output = "", settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; socket.destroy();
      if (error) reject(error); else resolveReply(value); };
    socket.setEncoding("utf8"); socket.setTimeout(timeoutMs);
    socket.once("connect", () => socket.end(`${ADMIN_MAGIC_V1}\n${JSON.stringify(request)}\n`));
    socket.on("data", chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 8192) return finish(updaterRefuseV1("updater_admin_reply_too_large"));
      const lines = output.split("\n");
      if (lines.length < 3) return;
      if (lines[0] !== ADMIN_MAGIC_V1) return finish(updaterRefuseV1("updater_admin_magic_refused"));
      try { finish(undefined, JSON.parse(lines[1])); }
      catch { finish(updaterRefuseV1("updater_admin_reply_refused")); }
    });
    socket.once("timeout", () => finish(updaterRefuseV1("updater_admin_timeout")));
    socket.once("error", error => finish(error));
    socket.once("close", () => { if (!settled) finish(updaterRefuseV1("updater_admin_incomplete_reply")); });
  });
  const object = assertPlainObjectV1(reply, "updater_admin_reply_refused");
  const allowed = new Set(["ok", "state", "pid", "generation"]);
  if (Object.keys(object).some(key => !allowed.has(key)) || typeof object.ok !== "boolean"
      || (object.state !== undefined && !["running", "draining", "stopped", "maintenance"].includes(object.state))
      || (object.pid !== undefined && (!Number.isSafeInteger(object.pid) || object.pid < 2))
      || (object.generation !== undefined && (!Number.isSafeInteger(object.generation) || object.generation < 0)))
    throw updaterRefuseV1("updater_admin_reply_refused");
  return Object.freeze({ ...object });
}

export class UpdaterControlServerV1 {
  #server; #path; #active = 0; #sockets = new Set();
  constructor({ root, socketPath = "updater-state/control.sock", handler, maximumConnections = 50,
    requestTimeoutMs = 5_000 }) {
    this.root = root; this.socketPath = socketPath; this.handler = handler;
    this.maximumConnections = maximumConnections; this.requestTimeoutMs = requestTimeoutMs;
  }
  get activeConnections() { return this.#active; }
  async start() {
    const path = await assertNoSymlinkBelowV1(this.root, this.socketPath, { allowMissingLeaf: true });
    this.#path = path;
    try {
      const old = await lstat(path);
      if (!old.isSocket()) throw Object.assign(new Error("updater_control_path_refused"), { code: "updater_control_path_refused" });
      await unlink(path);
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
    this.#server = createServer({ allowHalfOpen: true }, socket => {
      this.#sockets.add(socket); socket.once("close", () => this.#sockets.delete(socket));
      if (this.#active >= this.maximumConnections) {
        socket.end(`${JSON.stringify({ ok: false, code: "busy" })}\n`, () => socket.destroy()); return;
      }
      this.#active += 1;
      let input = "", settled = false, requestSeen = false;
      const finish = () => { if (!settled) { settled = true; this.#active -= 1; } };
      socket.setEncoding("utf8"); socket.setTimeout(this.requestTimeoutMs);
      socket.on("data", chunk => {
        if (requestSeen) return;
        input += chunk;
        if (Buffer.byteLength(input) > 8192) {
          requestSeen = true; socket.end(`${JSON.stringify({ ok: false, code: "request_too_large" })}\n`); return;
        }
        const newline = input.indexOf("\n");
        if (newline === -1) return;
        requestSeen = true;
        void Promise.resolve().then(async () => this.handler(parseControlRequestV1(input.slice(0, newline))))
          .then(result => socket.end(`${JSON.stringify({ ok: true, result })}\n`))
          .catch(error => socket.end(`${JSON.stringify({ ok: false,
            code: typeof error?.code === "string" ? error.code : "request_refused" })}\n`));
      });
      socket.on("end", () => { if (!requestSeen) socket.destroy(); });
      socket.on("timeout", () => socket.destroy()); socket.on("close", finish); socket.on("error", finish);
    });
    await new Promise((resolveListen, reject) => {
      this.#server.once("error", reject); this.#server.listen(path, resolveListen);
    });
    try { await chmod(path, 0o600); }
    catch (error) { await this.stop(); throw error; }
    return path;
  }
  async stop() {
    if (!this.#server) return;
    const server = this.#server; this.#server = undefined;
    for (const socket of this.#sockets) socket.destroy();
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    if (this.#path) {
      try {
        const entry = await lstat(this.#path);
        if (entry.isSocket()) await unlink(this.#path);
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
      this.#path = undefined;
    }
  }
}

export function sendControlRequestV1(path, request, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolveResult, reject) => {
    const socket = createConnection(path); let output = "", settled = false;
    socket.setEncoding("utf8"); socket.setTimeout(timeoutMs);
    socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 8192) { socket.destroy(); return; }
      const newline = output.indexOf("\n");
      if (newline === -1 || settled) return;
      settled = true;
      try {
        const reply = JSON.parse(output.slice(0, newline));
        if (!reply.ok) reject(Object.assign(new Error(reply.code), { code: reply.code }));
        else resolveResult(reply.result);
      } catch (error) { reject(error); }
      socket.destroy();
    });
    socket.once("timeout", () => socket.destroy(Object.assign(new Error("updater_control_timeout"),
      { code: "updater_control_timeout" })));
    socket.once("error", error => { if (!settled) { settled = true; reject(error); } });
    socket.once("close", () => {
      if (!settled) { settled = true; reject(Object.assign(new Error("updater_control_incomplete_reply"),
        { code: "updater_control_incomplete_reply" })); }
    });
  });
}

import { assertOwnerActionTimeoutV1, beginOwnerActionV1 } from "./owner-action.mjs";
import { acquireUpdaterLocalLockV1 } from "./fs-safety.mjs";
import { chmod, lstat, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { assertNoSymlinkBelowV1 } from "./fs-safety.mjs";
import { assertPlainObjectV1, parseControlRequestV1, updaterRefuseV1 } from "./contracts.mjs";

const ADMIN_MAGIC_V1 = "CONTROL-ROOM-ADMIN/1";
// Darwin's sockaddr_un.sun_path is 104 bytes including its terminating NUL.
const DARWIN_UNIX_SOCKET_PATH_MAX_BYTES_V1 = 103;

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
  #server; #path; #socketIdentity; #release; #active = 0; #sockets = new Set(); #actions = new Set(); #stopping;
  constructor({ root, socketPath = "updater-state/control.sock", handler, maximumConnections = 50,
    requestTimeoutMs = 5_000, actionTimeoutMs }) {
    if (actionTimeoutMs !== undefined) assertOwnerActionTimeoutV1(actionTimeoutMs);
    this.root = root; this.socketPath = socketPath; this.handler = handler;
    this.maximumConnections = maximumConnections; this.requestTimeoutMs = requestTimeoutMs; this.actionTimeoutMs = actionTimeoutMs;
  }
  get activeConnections() { return this.#active; }
  async start() {
    if (this.#stopping) await this.#stopping;
    this.#stopping = undefined;
    const release = await acquireUpdaterLocalLockV1(this.root, "updater-state/control.lock", { busyCode: "updater_control_busy" });
    this.#release = release;
    try {
    const path = await assertNoSymlinkBelowV1(this.root, this.socketPath, { allowMissingLeaf: true });
    if (Buffer.byteLength(path) > DARWIN_UNIX_SOCKET_PATH_MAX_BYTES_V1)
      throw updaterRefuseV1("updater_control_socket_path_too_long");
    this.#path = path;
    try {
      const old = await lstat(path);
      if (!old.isSocket()) throw Object.assign(new Error("updater_control_path_refused"), { code: "updater_control_path_refused" });
      await unlink(path);
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
    this.#server = createServer({ allowHalfOpen: true }, socket => {
      if (!this.#server) { socket.destroy(); return; }
      this.#sockets.add(socket); socket.once("close", () => this.#sockets.delete(socket));
      if (this.#active >= this.maximumConnections) {
        socket.end(`${JSON.stringify({ ok: false, code: "busy" })}\n`, () => socket.destroy()); return;
      }
      this.#active += 1;
      let input = "", settled = false, requestSeen = false, action;
      const reply = value => { if (!socket.destroyed) socket.end(`${JSON.stringify(value)}\n`); };
      const deadline = setTimeout(() => socket.destroy(), this.requestTimeoutMs);
      const finish = () => { clearTimeout(deadline);
        if (!settled && (!action || action.settled)) { settled = true; this.#active -= 1; }
      };
      socket.setEncoding("utf8"); socket.setTimeout(this.requestTimeoutMs);
      socket.on("data", chunk => {
        if (requestSeen) return;
        input += chunk;
        if (Buffer.byteLength(input) > 8192) {
          requestSeen = true; socket.end(`${JSON.stringify({ ok: false, code: "request_too_large" })}\n`); return;
        }
        const newline = input.indexOf("\n");
        if (newline === -1) return;
        requestSeen = true; clearTimeout(deadline); socket.setTimeout(0);
        let request;
        try { request = parseControlRequestV1(input.slice(0, newline)); }
        catch (error) { reply({ ok: false, code: typeof error?.code === "string" ? error.code : "request_refused" }); return; }
        const actionTimeout = this.actionTimeoutMs ??
          (["check-and-continue", "rollback", "backup-now"].includes(request.verb) ? 300_000 : 15_000);
        action = beginOwnerActionV1(context => this.handler(request, context), actionTimeout,
          "updater_control_action_timeout");
        this.#actions.add(action);
        action.completion.then(() => {
          this.#actions.delete(action);
          if (socket.destroyed) finish();
        });
        void action.wait.then(outcome => {
          if (outcome.pending) reply({ ok: false, code: "updater_control_action_timeout" });
          else if (outcome.error) reply({ ok: false, code: typeof outcome.error?.code === "string" ? outcome.error.code : "request_refused" });
          else reply({ ok: true, result: outcome.value });
        }).catch(() => reply({ ok: false, code: "request_refused" }));
      });
      socket.on("end", () => { if (!requestSeen) socket.destroy(); });
      socket.on("timeout", () => socket.destroy()); socket.on("close", finish); socket.on("error", finish);
    });
    await new Promise((resolveListen, reject) => {
      this.#server.once("error", reject); this.#server.listen(path, resolveListen);
    });
    this.#socketIdentity = await lstat(path);
    try { await chmod(path, 0o600); }
    catch (error) { await this.stop(); throw error; }
    return path;
    } catch (error) { await this.stop(); await release(); throw error; }
  }
  stop() {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }
  async #stop() {
    const release = this.#release; this.#release = undefined;
    if (!this.#server) { await release?.(); return; }
    const server = this.#server; this.#server = undefined;
    let preserved;
    try {
      for (const action of this.#actions) action.cancel();
      for (const socket of this.#sockets) socket.destroy();
      await Promise.all([...this.#actions].map(action => action.completion));
      // libuv unlinks its original pathname on close. Move a foreign inode
      // aside before that happens, then put it back after our handle closes.
      if (this.#path && this.#socketIdentity) {
        try {
          const entry = await lstat(this.#path);
          if (entry.dev !== this.#socketIdentity.dev || entry.ino !== this.#socketIdentity.ino) {
            preserved = `${this.#path}.preserved-${randomBytes(16).toString("hex")}`;
            await rename(this.#path, preserved);
          }
        } catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
      await new Promise((resolveClose, reject) => server.close(error => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolveClose()));
    } finally {
      try { if (preserved) await rename(preserved, this.#path); }
      finally { this.#path = undefined; this.#socketIdentity = undefined; await release?.(); }
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

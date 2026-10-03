import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isMainModuleV1 } from "../../installer/shared/is-main-module.mjs";

export const SERVICE_LOG_MAX_BYTES_V1 = 10 * 1024 * 1024;
const refuse = () => { throw new Error("service_log_custody_refused"); };

/** Truncate the same inode at the cap. Never rename a daemon's open log. */
export async function openBoundedServiceLogV1(path, { maxBytes = SERVICE_LOG_MAX_BYTES_V1,
  uid = process.geteuid(), gid = process.getegid(), openFile = open } = {}) {
  if (!isAbsolute(path) || resolve(path) !== path || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || maxBytes > SERVICE_LOG_MAX_BYTES_V1) refuse();
  const handle = await openFile(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = await handle.stat();
    const safe = entry => entry.isFile() && entry.nlink === 1 && (entry.mode & 0o7777) === 0o600
      && entry.uid === uid && entry.gid === gid;
    if (!safe(initial)) refuse();
    let position = initial.size;
    if (position > maxBytes) { await handle.truncate(0); position = 0; }
    let pending = Promise.resolve();
    const write = async chunk => {
        const named = await lstat(path), entry = await handle.stat();
        if (!safe(named) || !safe(entry) || named.dev !== initial.dev || named.ino !== initial.ino) refuse();
        // Retain only the newest bounded chunk; a large burst never allocates a second large buffer.
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const tail = bytes.subarray(Math.max(0, bytes.length - maxBytes));
        if (position + tail.length > maxBytes) { await handle.truncate(0); position = 0; }
        let offset = 0;
        while (offset < tail.length) {
          const { bytesWritten } = await handle.write(tail, offset, tail.length - offset, position);
          if (bytesWritten === 0) throw new Error("service_log_write_failed");
          offset += bytesWritten; position += bytesWritten;
        }
        if (!safe(await handle.stat())) refuse();
    };
    return Object.freeze({
      write(chunk) { pending = pending.then(() => write(chunk)); return pending; },
      async close() { await pending.catch(() => {}); await handle.close(); },
    });
  } catch (error) { await handle.close(); throw error; }
}

/** One direct child, pipe backpressure, bounded logs, and an awaited shutdown. */
export async function collectServiceOutputV1({ out, err, command, args = [], signal,
  shutdownMs = 5000, maxBytes = SERVICE_LOG_MAX_BYTES_V1 }) {
  if (!isAbsolute(command) || out === err || !Array.isArray(args) || args.some(arg => typeof arg !== "string")
    || !Number.isSafeInteger(shutdownMs) || shutdownMs < 1 || shutdownMs > 120000) refuse();
  const logs = [];
  let child, closed, timer, pumps = [];
  const stop = () => {
    child?.stdin.end();
    if (Number.isSafeInteger(child?.pid) && child.pid > 0 && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      timer ??= setTimeout(() => {
        child.kill("SIGKILL");
        child.stdout.destroy(); child.stderr.destroy();
      }, shutdownMs);
    }
  };
  try {
    logs.push(await openBoundedServiceLogV1(out, { maxBytes }));
    logs.push(await openBoundedServiceLogV1(err, { maxBytes }));
    if (signal?.aborted) return 0;
    child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], detached: false });
    closed = new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("close", (code, termination) => accept({ code, termination }));
    });
    // Attach rejection handling immediately, including spawn errors before pumping begins.
    closed.catch(() => {});
    child.stdin.on("error", () => {});
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const pump = async (stream, log) => { for await (const chunk of stream) await log.write(chunk); };
    pumps = [pump(child.stdout, logs[0]), pump(child.stderr, logs[1])];
    await Promise.all([...pumps, closed]);
    const result = await closed;
    return signal?.aborted ? 0 : result.code ?? 1;
  } finally {
    signal?.removeEventListener("abort", stop);
    stop();
    if (closed) await closed.catch(() => {});
    await Promise.allSettled(pumps);
    clearTimeout(timer);
    await Promise.all(logs.map(log => log.close()));
  }
}

export async function mainServiceOutputV1(argv) {
  if (argv[0] !== "--out" || argv[2] !== "--err" || argv[4] !== "--shutdown-ms" || argv[6] !== "--" || argv.length < 8) refuse();
  const abort = new AbortController(), stop = () => abort.abort();
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  try { return await collectServiceOutputV1({ out: argv[1], err: argv[3], command: argv[7], args: argv.slice(8), shutdownMs: Number(argv[5]), signal: abort.signal }); }
  finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
}

if (isMainModuleV1(process.argv[1], import.meta.url)) {
  mainServiceOutputV1(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
}

// Operator preflight: validate configured inputs BEFORE any start or install.
//
// Static by default. Version gates, configuration custody, and release artifact
// integrity are all read-only checks. Opening a listener is a REAL effect, so the
// loopback bind probe is opt-in via --bind-probe and never runs otherwise.
//
// Exit 0 = every check passed. Exit 1 = the failing check names are printed.
//
// stdlib only. No network access. No privilege required.

import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, statSync, lstatSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, isAbsolute } from "node:path";
import { verifyRelease } from "./verify-artifact.mjs";

/** Compare dotted versions numerically. Returns 1, 0 or -1. */
export function compareVersions(actual, minimum) {
  const parse = v => String(v).trim().replace(/^v/, "").split(".").map(n => Number(n));
  const a = parse(actual), m = parse(minimum);
  for (let i = 0; i < Math.max(a.length, m.length); i++) {
    const x = a[i] ?? 0, y = m[i] ?? 0;
    if (Number.isNaN(x)) throw new Error("preflight_version_unparseable");
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

export function checkNodeVersion(version = process.versions.node, minimum = "22.13.0") {
  try {
    return compareVersions(version, minimum) >= 0
      ? { ok: true, detail: `node ${version}` }
      : { ok: false, detail: `node ${version} below required ${minimum}` };
  } catch { return { ok: false, detail: `node version unparseable: ${version}` }; }
}

export function checkPnpmVersion(run = () => execFileSync("pnpm", ["--version"], { encoding: "utf8" }), minimum = "11.19.0") {
  let version;
  try { version = run().trim(); }
  catch { return { ok: false, detail: "pnpm not runnable" }; }
  try {
    return compareVersions(version, minimum) >= 0
      ? { ok: true, detail: `pnpm ${version}` }
      : { ok: false, detail: `pnpm ${version} below required ${minimum}` };
  } catch { return { ok: false, detail: `pnpm version unparseable: ${version}` }; }
}

/**
 * Configuration custody. The configuration holds secrets, so it must be a
 * regular owner-only file reached without a symlink. Both conditions are part
 * of the contract rather than conventions, because a world-readable or
 * symlinked configuration can be read or swapped by another local user.
 */
export function checkConfiguration(path, { uid = typeof process.getuid === "function" ? process.getuid() : null } = {}) {
  if (!path) return { ok: false, detail: "no --configuration given" };
  const abs = resolve(path);
  if (!isAbsolute(abs)) return { ok: false, detail: `${path}: not an absolute path` };
  if (!existsSync(abs)) return { ok: false, detail: `${path}: does not exist` };
  const link = lstatSync(abs);
  if (link.isSymbolicLink()) return { ok: false, detail: `${path}: is a symlink` };
  const st = statSync(abs);
  if (!st.isFile()) return { ok: false, detail: `${path}: not a regular file` };
  const mode = st.mode & 0o777;
  if (mode !== 0o600) return { ok: false, detail: `${path}: mode ${mode.toString(8)} must be 600` };
  if (uid !== null && st.uid !== uid) return { ok: false, detail: `${path}: not owned by this user` };
  return { ok: true, detail: `${path} (mode 600)` };
}

/** Release artifact integrity: full archive + unpack + member verification. */
export function checkArtifact({ archive, manifest } = {}) {
  if (!archive) return { ok: true, detail: "no --archive given (nothing to verify)" };
  const abs = resolve(archive);
  if (!existsSync(abs)) return { ok: false, detail: `${archive}: does not exist` };
  const result = verifyRelease({
    archivePath: abs,
    manifestPath: resolve(manifest || join(abs, "..", "manifest.json")),
  });
  return result.ok
    ? { ok: true, detail: `${archive}: ${result.checked} members verified` }
    : { ok: false, detail: `${archive}: ${result.problems.slice(0, 5).join(", ")}` };
}

/**
 * Prove loopback binding works, or that a specific port is free. Binds
 * 127.0.0.1 only and never 0.0.0.0. THIS OPENS A LISTENER — a real effect —
 * so it is only ever called when expressly requested.
 */
export function checkLoopbackBind(port = 0) {
  return new Promise(resolveCheck => {
    const server = createServer();
    server.once("error", error => resolveCheck({
      ok: false,
      detail: port === 0 ? `loopback bind failed: ${error.code}` : `port ${port} unavailable on 127.0.0.1: ${error.code}`,
    }));
    server.listen(port, "127.0.0.1", () => {
      const bound = server.address().port;
      server.close(() => resolveCheck({ ok: true, detail: `127.0.0.1:${port === 0 ? `(ephemeral ${bound})` : port} bindable` }));
    });
  });
}

export async function runPreflight({ configuration = "", port = 0, archive = "", manifest = "", bindProbe = false } = {}) {
  const failures = [];
  const note = (name, result) => {
    console.log(`${result.ok ? "ok" : "FAIL"} - preflight:${name} # ${result.detail}`);
    if (!result.ok) failures.push(name);
  };
  note("node", checkNodeVersion());
  note("pnpm", checkPnpmVersion());
  note("configuration", checkConfiguration(configuration));
  note("artifact", checkArtifact({ archive, manifest }));
  if (bindProbe) note("bind", await checkLoopbackBind(port));
  return { ok: failures.length === 0, failures };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log("Usage: node scripts/release/preflight.mjs --configuration <abs-path> [--archive <path>] [--manifest <path>] [--port <n>] [--bind-probe]");
    console.log("Validates operator inputs before any start/install effect. Static by default; --bind-probe adds the listener probe (a real effect).");
    process.exit(args.includes("--help") ? 0 : 1);
  }
  const pick = name => { const i = args.indexOf(name); return i === -1 ? "" : (args[i + 1] || ""); };
  const port = Number(pick("--port") || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error("preflight: --port must be 0-65535"); process.exit(1); }
  const bindProbe = args.includes("--bind-probe");
  if ((port !== 0 || pick("--port") !== "") && !bindProbe) {
    console.error("preflight: --port requires --bind-probe (static preflight opens no listener)");
    process.exit(1);
  }
  const result = await runPreflight({
    configuration: pick("--configuration"), port,
    archive: pick("--archive"), manifest: pick("--manifest"), bindProbe,
  });
  process.exit(result.ok ? 0 : 1);
}
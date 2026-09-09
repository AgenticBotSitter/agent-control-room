// Operator preflight: validate configured inputs BEFORE any start/install effect.
// Read-only. Exit 0 = every check passed; exit 1 = failure list printed.
// Reuses the private-VPS operator-config trust boundary (same-UID, mode 0600,
// no symlinks) rather than inventing a second one.
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { validatePrivateVpsConfigurationPath } from "../run-private-vps.mjs";
import { verifyManifest } from "./verify-artifact.mjs";

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
  return compareVersions(version, minimum) >= 0
    ? { ok: true, detail: `node ${version}` }
    : { ok: false, detail: `node ${version} below required ${minimum}` };
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

// Proves loopback binding works by listening on 127.0.0.1 (ephemeral port),
// or checks a specific port is free. Never binds 0.0.0.0.
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

export async function checkConfiguration(path) {
  if (!path) return { ok: false, detail: "no --configuration given" };
  try { await validatePrivateVpsConfigurationPath(resolve(path)); return { ok: true, detail: path }; }
  catch (error) { return { ok: false, detail: `${path}: ${error.message}` }; }
}

export function checkArtifact(repoRoot, artifactDir) {
  if (!artifactDir) return { ok: true, detail: "no --artifact given (skipped)" };
  const result = verifyManifest({ repoRoot: resolve(repoRoot), manifestPath: resolve(repoRoot, artifactDir, "manifest.json") });
  return result.ok
    ? { ok: true, detail: `${artifactDir}: ${result.checked} files verified` }
    : { ok: false, detail: `${artifactDir}: ${result.problems.slice(0, 5).join(", ")}` };
}

// Runs every check; returns { ok, failures[] }. Makes no changes.
export async function runPreflight({ configuration = "", port = 0, artifact = "", repoRoot = resolve(".") } = {}) {
  const failures = [];
  const note = (name, result) => {
    console.log(`${result.ok ? "ok" : "FAIL"} - preflight:${name} # ${result.detail}`);
    if (!result.ok) failures.push(name);
  };
  note("node", checkNodeVersion());
  note("pnpm", checkPnpmVersion());
  note("loopback", await checkLoopbackBind(port));
  note("configuration", await checkConfiguration(configuration));
  note("artifact", checkArtifact(repoRoot, artifact));
  return { ok: failures.length === 0, failures };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log("Usage: node scripts/release/preflight.mjs --configuration /absolute/operator-config.mjs [--port <n>] [--artifact <dir>]");
    console.log("Validates operator inputs before any start/install effect. Read-only; exit 1 lists failures.");
    process.exit(args.includes("--help") ? 0 : 1);
  }
  const pick = name => { const i = args.indexOf(name); return i === -1 ? "" : (args[i + 1] || ""); };
  const port = Number(pick("--port") || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error("preflight: --port must be 0-65535"); process.exit(1); }
  const result = await runPreflight({ configuration: pick("--configuration"), port, artifact: pick("--artifact") });
  process.exit(result.ok ? 0 : 1);
}

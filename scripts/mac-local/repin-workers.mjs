#!/usr/bin/env node
// Re-pins worker CLIs after an app auto-update. Run by mac:up before the hosts start.
// It follows an update only inside the same vendor install location as the recorded
// pin; anything else is refused and left unavailable for the owner to decide.
// Usage: node --import tsx scripts/mac-local/repin-workers.mjs --protected-root ABS_PATH [--check]
import { chmod, lstat, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { captureMacLocalProtectedConfigurationV1 } from "../../src/web/v1/mac-local-protected-configuration";
import { readPinnedMacExecutableVersion } from "./start-web-host.mjs";

// Any unexpected failure is exit 2 (do not start), never exit 1 (start with a worker unavailable).
for (const event of ["uncaughtException", "unhandledRejection"])
  process.on(event, error => { console.error(`repin: ${error?.message ?? "failed"}`); process.exit(2); });

const home = homedir();
const claudeRoot = join(home, "Library/Application Support/Claude/claude-code");

/** Known vendor install locations. Each resolves the current binary inside that location. */
const installLocations = Object.freeze([
  { kind: "claude-code", root: `${claudeRoot}/`, current: async () => {
    const versions = (await readdir(claudeRoot)).filter(v => /^\d+\.\d+\.\d+$/u.test(v))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return versions.map(v => join(claudeRoot, v, "claude.app/Contents/MacOS/claude")).filter(p => existsSync(p));
  } },
  { kind: "codex", root: "/Applications/ChatGPT.app/Contents/Resources/", current: async () => ["/Applications/ChatGPT.app/Contents/Resources/codex"] },
  { kind: "codex", root: join(home, ".codex/plugins/.plugin-appserver/"), current: async () => [join(home, ".codex/plugins/.plugin-appserver/codex")] },
  { kind: "hermes", root: join(home, ".hermes/hermes-agent/venv/bin/"), current: async () => [join(home, ".hermes/hermes-agent/venv/bin/hermes")] },
  { kind: "hermes-021", root: join(home, ".hermes/hermes-agent/venv/bin/"), current: async () => [join(home, ".hermes/hermes-agent/venv/bin/hermes")] },
]);

const args = process.argv.slice(2);
const index = args.indexOf("--protected-root");
const protectedRoot = index === -1 ? process.env.CONTROL_ROOM_PROTECTED_ROOT : args[index + 1];
const checkOnly = args.includes("--check");
if (!protectedRoot || !isAbsolute(protectedRoot) || resolve(protectedRoot) !== protectedRoot) {
  console.error("repin: --protected-root ABSOLUTE_PATH is required");
  process.exit(2);
}
const configPath = join(protectedRoot, "config/mac-local.json");

async function readVersion(path) {
  try { return await readPinnedMacExecutableVersion(path); } catch { return undefined; }
}

async function writePrivate(path, content) {
  const temporary = `${path}.new-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

const entry = await lstat(configPath);
if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) {
  console.error("repin: protected configuration is not a private regular file");
  process.exit(2);
}
const raw = await readFile(configPath, "utf8");
const config = captureMacLocalProtectedConfigurationV1(JSON.parse(raw));

let changed = false, blocked = 0;
const workers = [];
for (const worker of config.enablement.workers) {
  const observed = await readVersion(worker.executablePath);
  if (observed === worker.recordedVersion) { workers.push(worker); console.log(`ok       ${worker.kind}: ${worker.recordedVersion}`); continue; }
  const location = installLocations.find(item => item.kind === worker.kind && worker.executablePath.startsWith(item.root));
  let replacement;
  if (location) {
    let candidates = [];
    try { candidates = await location.current(); } catch { candidates = []; }
    for (const candidate of candidates) {
      const version = await readVersion(candidate);
      if (version) { replacement = { ...worker, executablePath: candidate, recordedVersion: version }; break; }
    }
  }
  if (!replacement) {
    blocked++;
    workers.push(worker);
    console.log(`BLOCKED  ${worker.kind}: pinned CLI ${observed === undefined ? "missing" : "changed"} and no update found in its install location; it stays unavailable. Re-run the provisioner to choose a new CLI.`);
    continue;
  }
  changed = true;
  workers.push(Object.freeze(replacement));
  console.log(`${checkOnly ? "NEEDS    " : "repinned "}${worker.kind}: ${worker.recordedVersion} -> ${replacement.recordedVersion}`);
}

if (changed && !checkOnly) {
  const material = { schema: config.enablement.schema, mode: config.enablement.mode, nodeId: config.enablement.nodeId, workers };
  const next = { ...JSON.parse(raw), enablement: material };
  captureMacLocalProtectedConfigurationV1(JSON.parse(JSON.stringify(next)));
  await writePrivate(`${configPath}.previous`, raw);
  await writePrivate(configPath, `${JSON.stringify(next)}\n`);
}
process.exit(blocked > 0 ? 1 : checkOnly && changed ? 3 : 0);

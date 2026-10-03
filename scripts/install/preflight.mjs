#!/usr/bin/env node
// Read-only install-night checks. This file deliberately has no mutating APIs:
// no shell, no sudo, no network client, no writes, and no process control.
import { execFile as nativeExecFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { firstFreeServiceAccountIdV1 } from "../../src/updater/v1/install/installer.mjs";
import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";

const execFile = promisify(nativeExecFile);
const MAX_OUTPUT = 64 * 1024;
const TIMEOUT_MS = 3_000;
const RESCUE_RESERVE_BYTES = 2 * 1024 * 1024 * 1024;
const REQUIRED_PORTS = Object.freeze([3210, 3211, 3212, 5432]);
const TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const PG_BIN_DIRECTORIES = Object.freeze([
  "/opt/homebrew/opt/postgresql@17/bin",
  "/usr/local/opt/postgresql@17/bin",
]);
const LEGACY_PROTECTED_DIRECTORY = join(homedir(), "Library", "Application Support", "Agent Control Room", "Protected");
const CURRENT_INSTALL_DIRECTORY = "/Library/Application Support/Control Room";

const cleanText = value => String(value ?? "").replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, "");
const short = value => cleanText(value).slice(0, 240).replace(/\s+/gu, " ").trim();
const check = (id, status, summary, action, mutation) => Object.freeze({ id, status, summary, action, mutation });
const passed = (id, summary, action, mutation) => check(id, "pass", summary, action, mutation);
const warned = (id, summary, action, mutation) => check(id, "warn", summary, action, mutation);
const failed = (id, summary, action, mutation) => check(id, "fail", summary, action, mutation);

function commandPort() {
  return Object.freeze({
    geteuid: () => process.geteuid?.() ?? -1,
    exists: existsSync,
    async run(file, args, options = {}) {
      try {
        const result = await execFile(file, args, { timeout: options.timeout ?? TIMEOUT_MS, maxBuffer: MAX_OUTPUT,
          windowsHide: true, encoding: "utf8" });
        return { code: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      } catch (error) {
        return { code: Number.isInteger(error?.code) ? error.code : 1, stdout: error?.stdout ?? "", stderr: error?.stderr ?? "",
          timedOut: error?.killed === true || error?.signal === "SIGTERM", missing: error?.code === "ENOENT" };
      }
    },
  });
}

async function run(ports, file, args, options) {
  const result = await ports.run(file, args, options);
  const stdout = cleanText(result?.stdout), stderr = cleanText(result?.stderr);
  if (!result || typeof result !== "object" || stdout.length > MAX_OUTPUT || stderr.length > MAX_OUTPUT) return { code: 1, malformed: true };
  return { ...result, stdout, stderr };
}

function parseVersion(value) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u.exec(short(value));
  return match ? match.slice(1).map(part => Number(part ?? 0)) : null;
}

function atLeast(version, minimum) {
  if (!version) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] > minimum[index]) return true;
    if (version[index] < minimum[index]) return false;
  }
  return true;
}

function parseDirectoryRows(value) {
  const rows = cleanText(value).split(/\r?\n/u).filter(Boolean);
  if (rows.length > 10_000) return null;
  const result = [];
  for (const line of rows) {
    const match = /^(\S+)\s+(-?\d{1,10})$/u.exec(line.trim()); // nobody -2, nogroup -1 are normal rows
    if (!match) return null;
    result.push({ name: match[1], id: Number(match[2]) });
  }
  return result.every(row => Number.isSafeInteger(row.id)) ? result : null;
}

function serveDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const web = value.Web, tcp = value.TCP, funnel = value.AllowFunnel;
  if (!web || typeof web !== "object" || Array.isArray(web) || tcp && (typeof tcp !== "object" || Array.isArray(tcp))
    || funnel && (typeof funnel !== "object" || Array.isArray(funnel))) return null;
  const funnelOn = Boolean(funnel && Object.values(funnel).some(Boolean));
  const webEntries = Object.entries(web), tcpEntries = Object.keys(tcp ?? {}), extras = [
    ...webEntries.map(([name]) => name).filter(name => !name.endsWith(":443")), ...tcpEntries.map(String),
  ];
  const live = webEntries.filter(([name]) => name.endsWith(":443"));
  const root = live.length === 1 && live[0][1] && typeof live[0][1] === "object" && !Array.isArray(live[0][1])
    ? live[0][1].Handlers?.["/"]?.Proxy : undefined;
  return { funnelOn, extras, liveCount: live.length, root: typeof root === "string" ? root : null };
}

function renderText(result) {
  const marker = { pass: "✅", warn: "⚠️", fail: "❌" };
  return result.checks.map(row => `${marker[row.status]} ${row.summary}\n   What to do: ${row.action}`).join("\n");
}

export async function runInstallPreflightV1(ports = commandPort()) {
  const checks = [];
  if (ports.geteuid() === 0) {
    checks.push(failed("owner", "This check must be run by the Mac owner, not as root.", "Open a normal Terminal window and run it again.", "Run as root: must refuse before every system command."));
    return Object.freeze({ schema: "control-room.install-preflight/v1", ok: false, checks: Object.freeze(checks) });
  }

  const [mac, arch, disk, clt, users, groups] = await Promise.all([
    run(ports, "/usr/bin/sw_vers", ["-productVersion"]), run(ports, "/usr/bin/uname", ["-m"]),
    run(ports, "/bin/df", ["-kP", "/Library"]), run(ports, "/usr/bin/xcode-select", ["-p"]),
    run(ports, "/usr/bin/dscl", [".", "-list", "/Users", "UniqueID"]), run(ports, "/usr/bin/dscl", [".", "-list", "/Groups", "PrimaryGroupID"]),
  ]);
  const macVersion = parseVersion(mac.stdout);
  checks.push(atLeast(macVersion, [14, 0, 0]) ? passed("macos", `macOS ${short(mac.stdout)} is supported.`, "Nothing.", "Return an older version or malformed output.")
    : failed("macos", "macOS 14 or later is required.", "Update macOS, then run this again.", "Return an older version or malformed output."));
  checks.push(short(arch.stdout) === "arm64" ? passed("apple-silicon", "Apple Silicon is available.", "Nothing.", "Return a non-arm64 architecture.")
    : failed("apple-silicon", "This install needs an Apple Silicon Mac.", "Use an Apple Silicon Mac for the install.", "Return a non-arm64 architecture."));

  const diskLine = disk.stdout.split(/\r?\n/u).find(line => /^\S+\s+\d+\s+\d+\s+\d+/u.test(line.trim()));
  const diskMatch = diskLine && /^(?:\S+)\s+\d+\s+\d+\s+(\d+)/u.exec(diskLine.trim());
  const freeBytes = diskMatch ? Number(diskMatch[1]) * 1024 : NaN;
  checks.push(Number.isSafeInteger(freeBytes) && freeBytes >= RESCUE_RESERVE_BYTES
    ? passed("disk", "Enough free space for the 2 GiB rescue reserve.", "Keep extra room free; the final installer also measures the release and database sizes.", "Report less than the reserve or malformed df output.")
    : failed("disk", "There is not enough free space for the 2 GiB rescue reserve.", "Free at least 2 GiB, then run this again.", "Report less than the reserve or malformed df output."));
  checks.push(clt.code === 0 && /^\//u.test(short(clt.stdout)) ? passed("xcode-clt", "Xcode Command Line Tools are ready.", "Nothing.", "Make xcode-select fail or return a relative path.")
    : failed("xcode-clt", "Xcode Command Line Tools are missing.", "Install Xcode Command Line Tools, then run this again.", "Make xcode-select fail or return a relative path."));

  let pgVersion = null;
  for (const candidate of PG_BIN_DIRECTORIES) {
    if (!["postgres", "initdb", "pg_ctl"].every(name => ports.exists(`${candidate}/${name}`))) continue;
    const observed = await run(ports, `${candidate}/postgres`, ["--version"]);
    const match = /PostgreSQL\)?\s+(\d+)(?:\.\d+){0,2}/iu.exec(observed.stdout);
    if (observed.code === 0 && match) { pgVersion = Number(match[1]); break; }
  }
  checks.push(pgVersion === 17 ? passed("postgres-17", "PostgreSQL 17 is available for the runtime copy.", "Nothing.", "Remove PostgreSQL 17 or return a different major version.")
    : failed("postgres-17", "PostgreSQL 17 is not available for the runtime copy.", "Install PostgreSQL 17, then run this again.", "Remove PostgreSQL 17 or return a different major version."));

  const status = await run(ports, TAILSCALE, ["status", "--json"]);
  let tailscale;
  try { tailscale = status.code === 0 ? JSON.parse(status.stdout) : null; } catch { tailscale = null; }
  const dnsName = typeof tailscale?.Self?.DNSName === "string" ? tailscale.Self.DNSName.replace(/\.$/u, "") : "";
  const loggedIn = tailscale?.BackendState === "Running" && /^[a-z0-9][a-z0-9.-]*\.ts\.net$/iu.test(dnsName);
  checks.push(loggedIn ? passed("tailscale", "Tailscale is signed in and has a MagicDNS name.", "Nothing.", "Remove DNSName, use a non-ts.net name, or stop Tailscale.")
    : failed("tailscale", "Tailscale is not signed in with a MagicDNS name.", "Open Tailscale, sign in, and wait for its name to appear.", "Remove DNSName, use a non-ts.net name, or stop Tailscale."));

  const serve = await run(ports, TAILSCALE, ["serve", "status", "--json"]);
  let serveJson;
  try { serveJson = serve.code === 0 ? JSON.parse(serve.stdout) : null; } catch { serveJson = null; }
  const details = serveDetails(serveJson);
  if (!details) checks.push(failed("tailscale-serve", "Tailscale Serve settings could not be read safely.", "Fix Tailscale Serve, then run this again.", "Return malformed or oversized JSON."));
  else if (details.funnelOn) checks.push(failed("tailscale-serve", "Tailscale Funnel is on.", "Turn Funnel off before install night.", "Set any AllowFunnel value to true."));
  else if (details.extras.length > 0) checks.push(failed("tailscale-serve", `Extra Tailscale Serve port${details.extras.length === 1 ? "" : "s"} found: ${details.extras.join(", ")}.`, "Move the phone preview to its own address (OPS-1), then run this again.", "Add a second Serve or TCP port, such as :8443."));
  else if (details.liveCount !== 1 || !/^http:\/\/127\.0\.0\.1:3210(?:\/|$)/u.test(details.root ?? "")) checks.push(failed("tailscale-serve", "HTTPS 443 is not pointing only to the live web service.", "Set one HTTPS 443 handler to the live web service, then run this again.", "Remove the 443 handler or point it anywhere except loopback web port 3210."));
  else checks.push(passed("tailscale-serve", "Tailscale Serve has one HTTPS 443 route to the live web service.", "Nothing.", "Add another handler, a non-443 port, or Funnel."));

  // `lsof -iTCP:PORT` can only show listeners this account owns, so a port held by a system
  // service or another account looked free. `netstat` reads the kernel's own socket table, which
  // has no such blind spot, and it stays read-only: no shell, no socket, no mutation. It is asked
  // ONCE for every port rather than per port, and the per-port lsof is kept only to name the
  // holder for the owner. A netstat that cannot be read fails the check closed.
  const netstat = await run(ports, "/usr/sbin/netstat", ["-anv", "-p", "tcp"]);
  const listening = new Set();
  if (netstat.code === 0 && !netstat.malformed) {
    for (const line of netstat.stdout.split("\n")) {
      if (!/\bLISTEN\b/u.test(line)) continue;
      const local = line.trim().split(/\s+/u)[3] ?? "";
      // 127.0.0.1.5432, 127.0.0.1.5432 1 (the trailing count on newer macOS) or *.5432.
      const match = /(?:^|\.)(\d{1,5})(?:\s|$)/u.exec(local.replace(/^\*|\.\*/gu, ""));
      const port = match ? Number(match[1]) : NaN;
      if (Number.isInteger(port) && REQUIRED_PORTS.includes(port)) listening.add(port);
    }
  }
  // A netstat that failed, timed out, was malformed or overflowed the buffer is not evidence that
  // the ports are free. It is an unknown, and an unknown on install night is a refusal.
  const netstatUnreadable = netstat.code !== 0 || netstat.malformed === true || netstat.timedOut === true;
  const holders = await Promise.all(REQUIRED_PORTS.map(async port => ({
    port, result: await run(ports, "/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]),
  })));
  const busy = REQUIRED_PORTS.filter(port => listening.has(port) || holders.some(row => row.port === port && row.result.code === 0));
  const unreadable = netstatUnreadable || holders.some(row => row.result.code !== 0 && row.result.code !== 1);
  const heldElsewhere = busy.filter(port => !holders.some(row => row.port === port && row.result.code === 0));
  checks.push(unreadable ? failed("ports", "The required ports could not be checked safely.", "Close other Terminal tools and run this again.", "Make netstat or lsof missing, slow, or return an unexpected error.")
    : busy.length ? failed("ports", `A new-install port is already in use: ${busy.join(", ")}.`, "Stop or reconfigure the item using that port, then run this again.", "Listen on any required port.")
      : passed("ports", "The new-install ports are free (3210, 3211, 3212, 5432).", "Nothing.", "Listen on any required port."));
  if (heldElsewhere.length)
    checks.push(failed("ports-other-account", `Port ${heldElsewhere.join(", ")} is in use by another account or a system service, which this check cannot name.`,
      "Stop that service, or pick different install ports, then run this again.",
      "Listen on a required port from another account, so lsof cannot name the holder."));

  const accountUsers = parseDirectoryRows(users.stdout), accountGroups = parseDirectoryRows(groups.stdout);
  const names = ["_controlroom", "_crdb", "_crbuild"];
  const nameTaken = accountUsers && accountGroups && names.some(name => accountUsers.some(row => row.name === name) || accountGroups.some(row => row.name === name));
  let accountIds;
  if (accountUsers && accountGroups) {
    const usedUids = new Set(accountUsers.map(row => row.id)), usedGids = new Set(accountGroups.map(row => row.id));
    try {
      accountIds = names.map(() => {
        const id = firstFreeServiceAccountIdV1(usedUids, usedGids);
        usedUids.add(id); usedGids.add(id);
        return id;
      });
    } catch { accountIds = null; }
  }
  checks.push(accountIds && !nameTaken
    ? passed("service-accounts", "Three service-account IDs and names are free.", "Nothing.", "Occupy a required name or leave fewer than three IDs from 300–399.")
    : failed("service-accounts", "Service-account names or IDs are not free.", "Ask the installer maintainer before changing any account.", "Occupy a required name or leave fewer than three IDs from 300–399."));

  checks.push(warned("github-read-token", "Have your read-only GitHub token ready (the one made for Control Room only — not the bots' login).", "At installer item 11a, paste it only at that prompt.", "This must remain an owner-attendance reminder, not a Keychain check."));

  const currentInstall = ports.exists(CURRENT_INSTALL_DIRECTORY), legacyProtected = ports.exists(LEGACY_PROTECTED_DIRECTORY);
  const existing = currentInstall || legacyProtected;
  checks.push(existing ? warned("existing-install", "An earlier Control Room install was found — it will be moved aside, not deleted.", "Nothing unless you want to cancel install night.", "Make the current install or the legacy Protected directory appear.")
    : passed("existing-install", "No earlier Control Room install was found.", "Nothing.", "Make the current install or the legacy Protected directory appear."));
  checks.push(warned("phone", "Have a Face ID-capable phone with you for the owner sign-in.", "Keep the phone unlocked and ready after the install starts.", "This is an owner-attendance reminder; it must never block the command."));

  const result = Object.freeze({ schema: "control-room.install-preflight/v1", ok: !checks.some(row => row.status === "fail"), checks: Object.freeze(checks) });
  return result;
}

export function formatInstallPreflightV1(result) { return renderText(result); }

async function main(args) {
  if (args.length > 1 || args[0] && args[0] !== "--json") throw new Error("Usage: control-room preflight [--json]");
  const result = await runInstallPreflightV1();
  process.stdout.write(`${args[0] === "--json" ? JSON.stringify(result, null, 2) : formatInstallPreflightV1(result)}\n`);
  return result.ok ? 0 : 1;
}

if (isMainModuleV1(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`Preflight stopped safely: ${short(error instanceof Error ? error.message : "unknown error")}\n`); process.exitCode = 1;
  });
}

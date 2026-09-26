// The Mac-local task host as one launchd user agent: it starts at login and restarts after a crash.
// mac:up installs or refreshes it (the first install needs --install-service); mac:down stops it and
// disables it so it does not return at the next login; mac:uninstall-service removes it. No data is touched.
// The agent runs exactly hostCommand(root) from the repository, so the existing pid checks keep working.
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { hostCommand, repoRoot } from "./stack.mjs";

export const SERVICE_LABEL = "xyz.agentcontrolroom.mac-local-host";
// The host drains its queue worker on SIGTERM for up to 45 s (see mac:down), so launchd waits as long.
const EXIT_TIMEOUT_SECONDS = 45;
const xmlEscape = value => value.replace(/[&<>"']/gu, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
const safe = value => typeof value === "string" && value.startsWith("/") && !/[\u0000-\u001f\u007f]/u.test(value);

export const plistPath = (home = homedir()) => join(home, "Library/LaunchAgents", `${SERVICE_LABEL}.plist`);
const target = uid => `gui/${uid}/${SERVICE_LABEL}`;

/** Only PATH and the locale cross into the service. No token or other variable does. */
function serviceEnvironment(env) {
  const out = {};
  if (typeof env.PATH === "string" && env.PATH && !/[\u0000-\u001f]/u.test(env.PATH)) out.PATH = env.PATH;
  if (typeof env.LANG === "string" && /^[A-Za-z0-9_.@-]{1,64}$/u.test(env.LANG)) out.LANG = env.LANG;
  return out;
}

export function servicePlist({ protectedRoot, logPath, env = process.env, root = repoRoot }) {
  const args = hostCommand(protectedRoot);
  if (![protectedRoot, logPath, root, ...args.filter(value => value.startsWith("/"))].every(safe))
    throw new Error("mac_local_service_path_invalid");
  const environment = serviceEnvironment(env);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>Label</key>', `<string>${SERVICE_LABEL}</string>`,
    '<key>ProgramArguments</key>', '<array>', ...args.map(value => `<string>${xmlEscape(value)}</string>`), '</array>',
    '<key>WorkingDirectory</key>', `<string>${xmlEscape(root)}</string>`,
    '<key>EnvironmentVariables</key>', '<dict>',
    ...Object.entries(environment).flatMap(([key, value]) => [`<key>${key}</key>`, `<string>${xmlEscape(value)}</string>`]),
    '</dict>',
    '<key>RunAtLoad</key>', '<true/>',
    // A clean SIGTERM stop exits 0 and stays stopped; a crash or kill -9 is restarted.
    '<key>KeepAlive</key>', '<dict><key>SuccessfulExit</key><false/></dict>',
    '<key>ThrottleInterval</key>', '<integer>15</integer>',
    '<key>ExitTimeOut</key>', `<integer>${EXIT_TIMEOUT_SECONDS}</integer>`,
    '<key>ProcessType</key>', '<string>Background</string>',
    '<key>Umask</key>', '<integer>63</integer>',
    '<key>StandardOutPath</key>', `<string>${xmlEscape(logPath)}</string>`,
    '<key>StandardErrorPath</key>', `<string>${xmlEscape(logPath)}</string>`,
    '</dict></plist>',
    "",
  ].join("\n");
}

const production = Object.freeze({
  uid: () => process.getuid(),
  home: () => homedir(),
  launchctl: args => new Promise(resolve => execFile("/bin/launchctl", args, { encoding: "utf8", timeout: 90_000 },
    (error, stdout) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: stdout ?? "" }))),
});

/** Refuses a LaunchAgents directory or plist that is a symlink or not a regular entry. */
async function inspectPlist(path) {
  const directory = join(path, "..");
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("mac_local_service_directory_invalid");
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("mac_local_service_plist_invalid");
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

/** True when the installed plist is byte-identical to what mac:up would write now. */
export async function serviceUpToDate({ protectedRoot, logPath, env }, runtime = production) {
  return (await inspectPlist(plistPath(runtime.home()))) === servicePlist({ protectedRoot, logPath, env });
}

export async function serviceInstalled(runtime = production) {
  return (await inspectPlist(plistPath(runtime.home()))) !== undefined;
}

/** The running pid launchd reports for the agent, if any. */
export async function servicePid(runtime = production) {
  const result = await runtime.launchctl(["print", target(runtime.uid())]);
  if (result.code !== 0) return { loaded: false, pid: undefined };
  const match = /^\s*pid = (\d+)\s*$/mu.exec(result.stdout);
  const pid = match ? Number(match[1]) : undefined;
  return { loaded: true, pid: Number.isSafeInteger(pid) && pid > 1 ? pid : undefined };
}

async function must(runtime, args) {
  const result = await runtime.launchctl(args);
  if (result.code !== 0) throw new Error(`mac_local_service_launchctl_failed: ${args[0]}`);
}

/** Writes the plist if it changed and (re)loads the agent. Returns what it did. */
export async function installOrRefreshService({ protectedRoot, logPath, env }, runtime = production) {
  const path = plistPath(runtime.home());
  const body = servicePlist({ protectedRoot, logPath, env });
  const current = await inspectPlist(path);
  const uid = runtime.uid();
  const { loaded } = await servicePid(runtime);
  // mac:up reaches here only when the host is not already serving, so an unchanged, loaded agent
  // is restarted in place to pick up the freshly checked configuration.
  if (current === body && loaded) {
    await must(runtime, ["kickstart", "-k", target(uid)]);
    return "restarted";
  }
  if (loaded) await must(runtime, ["bootout", target(uid)]);
  if (current !== body) {
    const temporary = `${path}.new-${process.pid}`;
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600, flag: "w" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  }
  // mac:down disables the agent so it skips the next login; a deliberate mac:up re-enables it.
  await must(runtime, ["enable", target(uid)]);
  await must(runtime, ["bootstrap", `gui/${uid}`, path]);
  return current === undefined ? "installed" : current === body ? "reloaded" : "refreshed";
}

/** Stops the agent and keeps it from starting at the next login. The plist stays, so the
 * next mac:up still uses the service. */
export async function stopService(runtime = production) {
  const uid = runtime.uid();
  const { loaded } = await servicePid(runtime);
  if (loaded) await must(runtime, ["bootout", target(uid)]);
  await must(runtime, ["disable", target(uid)]);
  return loaded ? "stopped" : "not_running";
}

export async function uninstallService(runtime = production) {
  const state = await stopService(runtime);
  const path = plistPath(runtime.home());
  if ((await inspectPlist(path)) !== undefined) await rm(path);
  await must(runtime, ["enable", target(runtime.uid())]);
  return state === "stopped" ? "stopped_and_removed" : "removed";
}

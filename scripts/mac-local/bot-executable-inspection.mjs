import { execFile as execFileCallback } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { pinnedVersionLine } from "./executable-version.mjs";

const execFile = promisify(execFileCallback);

/** Owner-attended setup inspection. Service hosts must not import this module:
 * local bots run as connector workers outside the task-host process. */
export async function readPinnedMacExecutableVersion(executablePath, runtime = { execFile }) {
  if (!isAbsolute(executablePath) || resolve(executablePath) !== executablePath) throw new Error("mac_local_executable_invalid");
  try {
    const result = await runtime.execFile(executablePath, ["--version"], {
      windowsHide: true, timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 4_096,
      encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "", NODE_ENV: "production" },
    });
    return pinnedVersionLine(result.stdout);
  } catch { throw new Error("mac_local_executable_version_unavailable"); }
}

export async function verifyPinnedMacModelPolicy(worker, runtime = { execFile }) {
  if (!worker?.modelPolicy || !isAbsolute(worker.executablePath) || resolve(worker.executablePath) !== worker.executablePath) return false;
  const run = async args => (await runtime.execFile(worker.executablePath, args, {
    windowsHide: true, timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 262_144,
    encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "", NODE_ENV: "production" },
  })).stdout;
  try {
    if (worker.kind === "codex") {
      const [models, help] = await Promise.all([run(["debug", "models"]), run(["exec", "--help"])]);
      return help.includes("--model") && worker.modelPolicy.models.every(model => models.includes(model));
    }
    const help = await run(["--help"]);
    if (worker.kind === "claude-code") return help.includes("--model") && help.includes("--effort");
    return help.includes("--model") && help.includes("--provider") && help.includes("--profile");
  } catch { return false; }
}

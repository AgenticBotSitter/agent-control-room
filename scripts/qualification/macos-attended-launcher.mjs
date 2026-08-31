import { spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repositoryRoot = resolve(scriptDirectory, "..", "..");
const harnessPath = join(scriptDirectory, "platform-key-store-harness.ts");
const safeComponent = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/;

function parseArguments(values) {
  if (values.length !== 4) throw new Error("invalid_arguments");
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!["--service", "--account"].includes(name) || !value || parsed.has(name) || !safeComponent.test(value)) {
      throw new Error("invalid_arguments");
    }
    parsed.set(name, value);
  }
  if (!parsed.has("--service") || !parsed.has("--account")) throw new Error("invalid_arguments");
  return { service: parsed.get("--service"), account: parsed.get("--account") };
}

async function validateScratch(path) {
  const resolved = await realpath(path);
  const tempRoot = await realpath(tmpdir());
  const stat = await lstat(resolved);
  if (dirname(resolved) !== tempRoot || !basename(resolved).startsWith("control-room-cr5c9h-mac-owner-")
    || !stat.isDirectory() || stat.isSymbolicLink()
    || typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("scratch_validation_failed");
  }
  return resolved;
}

async function runHarness(scratch, service, account) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      "--import", "tsx", harnessPath,
      "--platform", "macos", "--scratch", scratch,
      "--service", service, "--account", account,
    ], { cwd: repositoryRoot, env: { ...process.env }, stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    const chunks = [];
    let bytes = 0;
    child.stdout.on("data", (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > 32_768) {
        child.kill();
        reject(new Error("harness_output_exceeded"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.once("error", () => reject(new Error("harness_launch_failed")));
    child.once("close", (code) => resolvePromise({ exitCode: code ?? -1, stdout: Buffer.concat(chunks).toString("utf8") }));
  });
}

async function removeScratch(scratch) {
  const validated = await validateScratch(scratch);
  await readdir(validated, { withFileTypes: true });
  await rm(validated, { recursive: true });
  try {
    await lstat(validated);
  } catch (error) {
    if (error?.code === "ENOENT") return "absent";
    throw error;
  }
  throw new Error("scratch_cleanup_failed");
}

async function main() {
  const { service, account } = parseArguments(process.argv.slice(2));
  if (process.platform !== "darwin") throw new Error("wrong_platform");
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("attached_terminal_required");
  if (await realpath(process.cwd()) !== await realpath(repositoryRoot)) throw new Error("wrong_working_directory");

  const phrase = `ALLOW ONCE ${service} ${account}`;
  process.stderr.write([
    "CONTROL ROOM OWNER ACTION REQUIRED",
    `Confirm the disposable Keychain item: service=${service} account=${account}`,
    "Remain at this Mac. When the native dialog appears, choose Allow or Allow Once only.",
    "Never choose Always Allow. Dismiss any stale or mismatched prompt.",
    `Type exactly: ${phrase}`,
    "> ",
  ].join("\n"));
  const terminal = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const response = await terminal.question("");
  terminal.close();
  if (response !== phrase) throw new Error("owner_confirmation_refused");

  const tempRoot = await realpath(tmpdir());
  const created = await mkdtemp(join(tempRoot, "control-room-cr5c9h-mac-owner-"));
  const scratch = await validateScratch(created);
  let harnessResult;
  let harnessError;
  try {
    harnessResult = await runHarness(scratch, service, account);
  } catch (error) {
    harnessError = error;
  }
  const cleanup = await removeScratch(scratch);
  if (harnessError !== undefined) throw harnessError;
  let harnessOutput;
  try {
    harnessOutput = JSON.parse(harnessResult.stdout);
  } catch {
    throw new Error("invalid_harness_output");
  }
  process.stdout.write(`${JSON.stringify({
    schema: "control-room.macos-attended-qualification/v1",
    operatorBoundary: "interactive_attached_terminal",
    harnessExitCode: harnessResult.exitCode,
    harness: harnessOutput,
    scratchCleanup: cleanup,
  })}\n`);
  process.exitCode = harnessResult.exitCode;
}

main().catch((error) => {
  const category = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "attended_launcher_failed";
  process.stdout.write(`${JSON.stringify({ schema: "control-room.macos-attended-qualification-error/v1", category })}\n`);
  process.exitCode = 1;
});

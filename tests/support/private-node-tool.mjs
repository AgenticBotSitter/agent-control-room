import { execFile } from "node:child_process";
import { chmod, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** A test-owned executable, independent of the Node installation's permissions. */
export async function createPrivateNodeTool(dir) {
  const path = join(dir, "node-tool");
  // A private binary also avoids shebang limits and interpreter paths with spaces.
  await copyFile(process.execPath, path);
  await chmod(path, 0o700);
  // macOS checks a newly copied binary on first execution. Complete that setup
  // before tests measure tool deadlines; the tool's timeout is unchanged.
  await execute(path, ["--version"], { env: {}, timeout: 10_000, maxBuffer: 1024 });
  return path;
}

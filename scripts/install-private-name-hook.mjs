import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const MARKER = "# control-room-private-name-hook:v1";

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function installPrivateNameHook({ root = process.cwd(), env = process.env } = {}) {
  const namesFile = env.CONTROL_ROOM_PRIVATE_NAMES_FILE;
  if (!namesFile) throw new Error("set CONTROL_ROOM_PRIVATE_NAMES_FILE before installing the hook");
  try {
    if (!readFileSync(namesFile, "utf8").trim()) throw new Error();
  } catch {
    throw new Error("the configured private-name list must be readable and non-empty");
  }

  let hookPath;
  try {
    hookPath = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error("could not locate this repository's pre-push hook");
  }
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf8");
    if (!existing.startsWith(`#!/bin/sh\n${MARKER}\n`)) {
      throw new Error("pre-push hook already exists and was left unchanged");
    }
  }

  const hook = `#!/bin/sh
${MARKER}
set -eu
repository_root=$(git rev-parse --show-toplevel)
CONTROL_ROOM_PRIVATE_NAMES_FILE=${shellQuote(namesFile)} \\
  node "$repository_root/scripts/check-private-names.mjs"
`;
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, hook, { mode: 0o755 });
  chmodSync(hookPath, 0o755);
  return hookPath;
}

function main() {
  try {
    installPrivateNameHook();
    console.log("private-name pre-push hook installed");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "private-name hook installation failed");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

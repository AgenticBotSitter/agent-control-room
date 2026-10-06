// Run ONE database phase through the REAL native port, for the M1 lane's
// default-path test, from inside a pseudo-terminal (see `pty-run.py`).
//
// The port is `initializeDatabaseV1` from `control-room-native-ports.mjs` with its
// real transport (`runWithStdin`): it spawns the pinned node on the SHIPPED esbuild
// output at `<root>/updater/current/bin/<script>`, request on argv, passwords on
// one stdin line. The only argument replaced is the T1 path assertion, which
// requires a root-owned ancestry this lane cannot have; its stand-in still refuses
// a path that is missing or outside the install root.
//
// argv: <config.json> with `{ root, input }`. Prints ONE line: the result or the
// error message, as JSON.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initializeDatabaseV1 } from "../../src/updater/v1/cli/control-room-native-ports.mjs";

const { root, input } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const assertPath = async path => {
  if (!existsSync(path)) throw new Error("t1_path_missing");
  if (resolve(path) !== path || !path.startsWith(`${root}/`)) throw new Error("t1_path_outside_roots");
  return path;
};
try {
  const result = await initializeDatabaseV1(input, undefined, assertPath);
  process.stdout.write(`PHASE-RESULT ${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stdout.write(`PHASE-RESULT ${JSON.stringify({ ok: false, error: String(error?.message ?? error) })}\n`);
}

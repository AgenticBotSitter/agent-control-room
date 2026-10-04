// Blocker 2's second half, isolated: can a PG-family program the phase starts
// PROMPT on the terminal at all? Run from inside a pseudo-terminal (`pty-run.py`),
// this asks `spawnPgFamily` for a `psql` WITHOUT `-w` against a scram login with
// no password — the one invocation that prompts whenever it has a terminal. With
// the children started in a new session (`detached`) there is no terminal: psql
// fails at once with "no password supplied". Without it, psql prints
// `Password for user …:` into the pty and the lane's assertion fails.
//
// argv: <config.json> with the lane's context. Prints ONE `PROBE-RESULT` line.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnPgFamily } from "../../src/updater/v1/pg/database-phase-process.mjs";

const context = JSON.parse(readFileSync(process.argv[2], "utf8"));
const result = await spawnPgFamily({ executable: join(context.root, "runtime/pg-current/bin/psql"),
  args: ["-h", context.layout.socketDirectory, "-p", String(context.port), "-U", "control_room_web",
    "-d", "control_room", "-Atc", "SELECT 1"],
  environment: context.environment, uid: context.identity.uid, gid: context.identity.gid, role: "database",
  profile: context.profile, profileParameters: context.profileParameters, cwd: context.pgRoot, timeoutMs: 30_000 })
  .catch(error => ({ code: -1, stderr: String(error?.message) }));
process.stdout.write(`PROBE-RESULT ${JSON.stringify({ code: result.code, stderr: result.stderr.trim().slice(0, 300) })}\n`);

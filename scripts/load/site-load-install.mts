// A throwaway Control Room website for the whole-site load test, built only with
// this repository's own Mac-local tooling, plus a seed of realistic saved work.
//
//   node --import tsx scripts/load/site-load-install.mts up     ROOT_DIR --port 59610 --web-port 39610
//   node --import tsx scripts/load/site-load-install.mts seed   ROOT_DIR --port 59610 --web-port 39610
//   node --import tsx scripts/load/site-load-install.mts down   ROOT_DIR --port 59610 --web-port 39610
//
// It runs against a disposable PostgreSQL cluster under ROOT_DIR and nothing
// else. Every scope guard below refuses a root that is not that cluster, so
// this script cannot be pointed at an owner's install, the live database, the
// VPS or the phone preview. It never reads or prints an owner code: the load
// tool reads the same protected file the website was configured with, so the
// code never enters a log, a report or a transcript.
//
// The steps are the same ones ~/work/acr-private/preview/preview.sh runs
// (rehearsal setup -> prepare-task-runtime -> first-owner manifest/apply/
// complete -> mac:up), with two deliberate differences:
//
//   * no remoteAccess at all. The preview adds the owner's Tailscale origin so
//     a phone can reach it; a load test runs entirely on loopback, and naming a
//     tailnet origin here would have this script claiming a phone route it
//     never serves.
//   * pretend worker executables that answer `--version` and then emit exactly
//     the stdout each production process adapter parses, so real tasks really
//     run end to end against the real queue, publisher and result store.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

const action = process.argv[2];
const rootArg = process.argv[3];
const portOf = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : Number(process.argv[index + 1]);
};
const dbPort = portOf("--port") ?? 59610;
const webPort = portOf("--web-port") ?? 39610;
if (!["up", "seed", "down"].includes(action) || !rootArg || !isAbsolute(rootArg) || resolve(rootArg) !== rootArg
  || !Number.isInteger(dbPort) || !Number.isInteger(webPort) || webPort < 1024 || webPort > 65534
  || webPort === dbPort || webPort + 1 === dbPort) {
  console.error("usage: site-load-install.mts up|seed|down ABSOLUTE_DIR [--port 59610] [--web-port 39610]");
  process.exit(2);
}
const root = rootArg, protectedRoot = join(root, "protected"), repoRoot = process.cwd();
const origin = `http://127.0.0.1:${webPort}`;
const env = { ...process.env, CONTROL_ROOM_PROTECTED_ROOT: protectedRoot, TMPDIR: process.env.TMPDIR };
const invoke = (args: string[]) => {
  // Seeding drives real end-to-end deliveries on a shared Mac that pauses itself
  // whenever it is busy, so it is given a long budget and prints its own
  // progress. A shorter budget turned a slow machine into a discarded install.
  const result = spawnSync(process.execPath, ["--import", "tsx", ...args], { cwd: repoRoot, encoding: "utf8",
    timeout: Number(process.env.CONTROL_ROOM_LOAD_SEED_TIMEOUT_MS ?? 3_600_000), env });
  if (result.status !== 0) throw new Error(`${args[0]} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
};
const pgBin = process.env.PG_BIN;
if (pgBin !== undefined && (!isAbsolute(pgBin) || resolve(pgBin) !== pgBin)) throw new Error("rehearsal_pg_bin_must_be_absolute");

/** The disposable-cluster marker mac:rehearsal writes. Nothing else is deleted. */
async function assertDisposableRoot(): Promise<void> {
  const marker = join(root, "pg", ".control-room-disposable-postgres.json");
  if (!existsSync(marker)) throw new Error("load_test_scope_refused: not a disposable rehearsal root");
  const macLocal = JSON.parse(await readFile(join(protectedRoot, "config/mac-local.json"), "utf8"));
  if (macLocal.port !== webPort || macLocal.database?.host !== "127.0.0.1" || macLocal.database.port !== dbPort
    || macLocal.database.database !== "control_room")
    throw new Error("load_test_scope_refused: configuration is not this load-test install");
  if (macLocal.localOwnerSession?.origin !== origin) throw new Error("load_test_scope_refused: session origin mismatch");
}

// Pretend workers: the same three stdout shapes scripts/mac-local/rehearsal/journey.ts
// proves against the production adapters, minus its model-allowlist assertions.
const hermesScript = `#!/bin/sh
for a in "$@"; do [ "$a" = "--version" ] && printf '%s\\n' 'hermes 1.0.0-loadtest' && exit 0; done
[ "$1" = "--help" ] && printf '%s\\n' '--profile --provider --model' && exit 0
cat >/dev/null
session_id="loadtest-hermes-$(printf '%012d' "$$")"
printf '%s\\n' 'Load test sample result' > "$PWD/hermes-result.txt"
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"'"$session_id"'","model":"loadtest-model","timestamp":1}'
printf '%s\\n' '{"type":"text","text":"I will write the requested result.","timestamp":2}'
printf '%s\\n' '{"type":"tool_use","name":"write_file","tool_call_id":"tool-1","input":{"path":"hermes-result.txt"},"timestamp":3}'
printf '%s\\n' '{"type":"tool_result","name":"write_file","tool_call_id":"tool-1","output":"Wrote hermes-result.txt","duration_ms":1,"is_error":false,"timestamp":4}'
printf '%s\\n' '{"type":"result","session_id":"'"$session_id"'","exit_code":0,"text":"Load test sample result from a pretend Hermes.","tokens":{"input":3,"output":5,"total":8,"cache_read":0,"cache_write":0},"duration_ms":5,"timestamp":5}'
printf 'session_id: %s\\n' "$session_id" >&2
exit 0
`;
const claudeScript = `#!/bin/sh
for a in "$@"; do [ "$a" = "--version" ] && printf '%s\\n' 'claude 1.0.0-loadtest' && exit 0; done
[ "$1" = "--help" ] && printf '%s\\n' '--model --effort' && exit 0
cat >/dev/null
session_id="00000000-0000-4000-8000-$(printf '%012d' "$$")"
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"'"$session_id"'","model":"loadtest-model"}'
printf '%s\\n' '{"type":"rate_limit_event","session_id":"'"$session_id"'","rate_limit_info":{"status":"allowed"}}'
printf '%s\\n' '{"type":"assistant","session_id":"'"$session_id"'","message":{"role":"assistant","content":[{"type":"text","text":"Load test sample result from a pretend Claude."}]}}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"'"$session_id"'","result":"Load test sample result from a pretend Claude.","terminal_reason":"completed","total_cost_usd":0,"usage":{"input_tokens":3,"output_tokens":5}}'
exit 0
`;
const codexScript = `#!/bin/sh
for a in "$@"; do [ "$a" = "--version" ] && printf '%s\\n' 'codex 1.0.0-loadtest' && exit 0; done
[ "$1 $2" = "debug models" ] && printf '%s\\n' 'loadtest-model' && exit 0
[ "$1 $2" = "exec --help" ] && printf '%s\\n' '--model' && exit 0
cat >/dev/null
thread_id="00000000-0000-4000-8000-$(printf '%012d' "$$")"
printf '%s\\n' '{"type":"thread.started","thread_id":"'"$thread_id"'"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"reasoning"}}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Load test sample result from a pretend Codex."}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":5}}'
exit 0
`;
const workerScripts: Readonly<Record<string, string>> = { hermes: hermesScript, "claude-code": claudeScript, codex: codexScript };

async function up(): Promise<void> {
  if (existsSync(join(root, "pg"))) throw new Error("load_test_root_exists: remove it first (down)");
  // `mac:up` refuses a release build whose source digest is older than the tree,
  // and that digest covers scripts/mac-local and src. Rebuilding here means a
  // load test is never blocked by having edited a file since the last build --
  // and failing late, after a disposable cluster had already been created.
  console.log("site-load: building the release artifact (mac:up refuses a stale one)");
  invoke(["scripts/build-vps.mjs"]);
  invoke(["scripts/mac-local/rehearsal/setup.ts", "up", root, "--port", String(dbPort), "--web-port", String(webPort),
    "--fake-executables"]);
  const macLocal = JSON.parse(await readFile(join(protectedRoot, "config/mac-local.json"), "utf8"));
  // A load test must not be reachable from a phone or the internet. The
  // rehearsal writes no remoteAccess; refuse to continue if one appeared.
  if (macLocal.remoteAccess !== undefined) throw new Error("load_test_scope_refused: remote access must be absent");
  invoke(["scripts/mac-local/prepare-task-runtime.ts", "--protected-root", protectedRoot,
    "--hermes-profile", "loadtest", "--hermes-provider", "loadtest", "--hermes-model", "loadtest-model",
    "--hermes-destination", "https://loadtest.invalid:443"]);

  // Pretend workers replace the version-only stand-ins setup.ts wrote.
  const workerDirectory = join(protectedRoot, "loadtest-workers");
  await mkdir(workerDirectory, { recursive: true, mode: 0o700 });
  await chmod(workerDirectory, 0o700);
  for (const worker of macLocal.enablement.workers) {
    const name = worker.kind === "claude-code" ? "claude" : worker.kind;
    const executable = join(workerDirectory, name);
    await writeFile(executable, workerScripts[worker.kind]!, { mode: 0o700, flag: "wx" });
    await chmod(executable, 0o700);
    worker.executablePath = executable;
    worker.recordedVersion = `${name} 1.0.0-loadtest`;
  }
  await writeFile(join(protectedRoot, "config/mac-local.json"), `${JSON.stringify(macLocal, null, 2)}\n`, { mode: 0o600 });
  await rm(join(root, "setup-fake-workers"), { recursive: true, force: true });

  // First owner: manifest -> apply as the cluster owner on this exact cluster ->
  // complete on the Mac side. The apply runs against postgres, exactly as the
  // reviewed package-5 sequence and the phone preview do.
  await assertDisposableRoot();
  invoke(["scripts/mac-local/first-owner-manifest.mjs", protectedRoot, join(root, "first-owner-manifest.json")]);
  const manifest = JSON.parse(await readFile(join(protectedRoot, "config/first-owner-manifest.json"), "utf8"));
  const admin = new Client({ host: "127.0.0.1", port: dbPort, database: "control_room", user: "postgres",
    connectionTimeoutMillis: 5_000, statement_timeout: 30_000, query_timeout: 120_000 });
  await admin.connect();
  let receipt: unknown;
  try {
    const identity = (await admin.query("SELECT current_setting('data_directory') AS data_directory,"
      + "current_setting('server_version_num')::int AS version_num")).rows[0];
    if (resolve(identity.data_directory) !== resolve(root, "pg") || Math.floor(identity.version_num / 10_000) !== 17)
      throw new Error("load_test_scope_refused: not this disposable cluster");
    const { applyMacLocalFirstOwnerV1 } = await import(pathToFileURL(join(repoRoot, "scripts/mac-local/first-owner-vps.mjs")).href);
    receipt = await applyMacLocalFirstOwnerV1(admin, manifest);
  } finally { await admin.end(); }
  const receiptPath = join(protectedRoot, "config/first-owner-receipt.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  invoke(["scripts/mac-local/complete-first-owner.mjs", protectedRoot, receiptPath]);
  invoke(["scripts/mac-local/bootstrap-owner.ts", protectedRoot]);
  invoke(["scripts/mac-local/up.mjs", "--protected-root", protectedRoot]);
  console.log(`load-test website ready on ${origin} (database 127.0.0.1:${dbPort})`);
}

async function seed(): Promise<void> {
  await assertDisposableRoot();
  // The seeder's own progress is the evidence that seeding worked, so it is
  // printed rather than captured and dropped.
  console.log(invoke(["scripts/load/site-load-seed.mts", root, "--port", String(dbPort), "--web-port", String(webPort)]));
}

async function down(): Promise<void> {
  if (!existsSync(root)) { console.log("nothing to remove"); return; }
  if (!existsSync(join(root, "pg", ".control-room-disposable-postgres.json")))
    throw new Error("load_test_scope_refused: not a disposable rehearsal root; refusing to delete");
  spawnSync(process.execPath, ["scripts/mac-local/down.mjs", "--protected-root", protectedRoot],
    { cwd: repoRoot, encoding: "utf8", timeout: 300_000, env });
  invoke(["scripts/mac-local/rehearsal/setup.ts", "down", root, "--port", String(dbPort), "--web-port", String(webPort)]);
  await rm(root, { recursive: true, force: true });
  console.log("load-test website stopped and its data folder deleted");
}

assert.ok(process.platform === "darwin" || process.platform === "linux");
if (action === "up") await up();
else if (action === "seed") await seed();
else await down();

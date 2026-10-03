// Shared harness for the two owner-push crash lanes (R6C-04, R6C-05) on real
// PostgreSQL 17, as the production owner-web login.
//
// Everything here exists to start and RETIRE a child process safely: the child
// is spawned into its OWN process group, and only that group is signalled, so a
// lane can never reach another job's processes. `stopCrashChild` is called from
// a finally in every test, and the group is retired whether the lane passed,
// failed or timed out.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** tests/support -> repository root. The child runs from here so `tsx` resolves. */
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CRASH_CHILD = join(REPOSITORY_ROOT, "tests/fixtures/owner-push-crash-child.mjs");

/** How long a parked child may take to report the boundary it reached. */
const READY_TIMEOUT_MS = 60_000;

/** Every token the child may legitimately report as reached. */
const READY_TOKENS = new Set(["CLAIM_COMMITTED", "PROVIDER_ACCEPTED", "DISPATCH_DONE"]);

/**
 * Spawn the crash child in its own process group and wait for one readiness
 * token. The returned handle carries `stop()`, which SIGKILLs the group and
 * waits for it to be reaped.
 */
export function crashChild(input: {
  connection: { host: string; port: number; database: string; user: string; password: string };
  tenantId: string;
  mode: "claim_committed" | "provider_accepted";
  tagLog?: string;
  env?: Record<string, string>;
}): { child: ReturnType<typeof spawn>; closed: Promise<{ code: number | null; signal: string | null }>;
  stdout: string; ready: Promise<string>; stop: () => Promise<void> } {
  // Started in its own process group below. Nothing else this lane signals.
  const child = spawn(process.execPath, ["--import", "tsx", CRASH_CHILD], {
    // Its OWN process group, so the kill below cannot reach anything else.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    // The repository root, NOT the scratch directory: the child imports the real
    // source through tsx, and resolving that from a directory outside the tree
    // fails with ERR_MODULE_NOT_FOUND -- a harness failure that would otherwise
    // be reported as a product finding.
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, NODE_ENV: "test", CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1",
      CONTROL_ROOM_PUSH_CRASH_CONNECTION: JSON.stringify(input.connection),
      CONTROL_ROOM_PUSH_CRASH_TENANT: input.tenantId,
      CONTROL_ROOM_PUSH_CRASH_MODE: input.mode,
      ...(input.tagLog ? { CONTROL_ROOM_PUSH_CRASH_TAG_LOG: input.tagLog } : {}),
      ...input.env },
  });
  const closed = once(child, "close") as unknown as Promise<{ code: number | null; signal: string | null }>;
  let seen = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { seen += chunk; });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`owner_push_crash_child_not_ready:${input.mode}:${stderr.slice(0, 400)}`)), READY_TIMEOUT_MS);
    const check = setInterval(() => {
      // The child reports ONE bare token per line it reaches. Matched by
      // position in a known set rather than by shape, so a stray line of child
      // output can never be read as a boundary the child actually reached.
      const token = seen.split("\n").map(line => line.trim()).find(line => READY_TOKENS.has(line.split(":")[0]!));
      if (token) { clearInterval(check); clearTimeout(timer); resolve(token); }
    }, 25);
    child.once("exit", () => {
      clearInterval(check); clearTimeout(timer);
      reject(new Error(`owner_push_crash_child_exited_early:${input.mode}:${stderr.slice(0, 400)}`));
    });
  });
  const stop = async () => {
    // The NEGATIVE pid signals the child's own group, which is the only group
    // this lane created.
    try { process.kill(-child.pid!, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    await closed;
  };
  return { child, closed, get stdout() { return seen; }, ready, stop };
}

/** A scratch directory for one lane, removed by the caller's finally. */
export async function scratchDirectory(label: string): Promise<{ path: string; remove: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), `owner-push-crash-${label}-`));
  return { path, remove: async () => { await rm(path, { recursive: true, force: true }); } };
}

/** Every tag a child durably recorded as accepted by the provider. */
export async function acceptedTags(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").map(line => line.trim()).filter(line => line !== "");
}
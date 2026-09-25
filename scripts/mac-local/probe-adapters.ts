// Runs each real Mac-local agent adapter outside the website: one tiny task, one cancel
// mid-run and one deadline. After cancel/deadline, no process may remain in the agent's
// process group. Uses the pins in the protected config. No database, no queue.
// Usage: node --import tsx scripts/mac-local/probe-adapters.ts ABS_PROTECTED_ROOT [codex|claude-code|hermes ...]
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMacLocalProtectedConfigurationFromRootV1 } from "../../src/web/v1/mac-local-protected-loader";
import { createOwnerTrustedLocalCodexExecV1 } from "../../src/harness/codex-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalClaudeExecV1 } from "../../src/harness/claude-code-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalHermesExecV1 } from "../../src/harness/hermes-local-v1/owner-trusted-local-exec";

const [root, ...only] = process.argv.slice(2);
if (!root) { console.error("usage: probe-adapters.ts ABS_PROTECTED_ROOT [kinds...]"); process.exit(2); }
const configuration = await loadMacLocalProtectedConfigurationFromRootV1(root);
const hermesProfile = { profile: process.env.PROBE_HERMES_PROFILE ?? "cr", model: process.env.PROBE_HERMES_MODEL ?? "stealth/ox-alpha",
  provider: process.env.PROBE_HERMES_PROVIDER ?? "openrouter" };

const QUICK = "Reply with exactly the single word: ok";
const LONG = "Write the numbers from 1 to 3000, one per line, each followed by a short original sentence. Do not stop early.";

// Every direct child of this process is an agent group leader (spawned detached).
function processTable() {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid="], { encoding: "utf8" }).trim().split("\n")
    .map(line => line.trim().split(/\s+/u).map(Number)).filter(row => row.length === 3);
}
const everyGroup = new Set<number>();
function watchGroups() {
  const groups = new Set<number>();
  const timer = setInterval(() => {
    for (const [pid, ppid, pgid] of processTable()) if (ppid === process.pid && pid === pgid) { groups.add(pgid); everyGroup.add(pgid); }
  }, 100);
  return { groups, stop: () => clearInterval(timer) };
}
const leftovers = (groups: Set<number>) => processTable().filter(([, , pgid]) => groups.has(pgid)).map(([pid]) => pid);
// A leftover is reported as a failure and then killed, so the probe never abandons processes.
const reap = (groups: Set<number>) => { for (const pgid of groups) { try { process.kill(-pgid, "SIGKILL"); } catch {} } };
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => { reap(everyGroup); process.exit(130); });

type Run = (prompt: string, deadlineMs: number, signal?: AbortSignal, cwd?: string) => Promise<{ status: string; reason?: string; text?: string }>;
const runners: Record<string, Run> = {};
for (const worker of configuration.enablement.workers) {
  const base = (prompt: string, deadlineMs: number, signal: AbortSignal | undefined, cwd: string) =>
    ({ executablePath: worker.executablePath, prompt, workingDirectory: cwd, deadlineMs, ...(signal ? { signal } : {}) });
  if (worker.kind === "codex") { const exec = createOwnerTrustedLocalCodexExecV1(); runners.codex = (p, d, s, c) => exec.execute(base(p, d, s, c!)); }
  if (worker.kind === "claude-code") { const exec = createOwnerTrustedLocalClaudeExecV1(); runners["claude-code"] = (p, d, s, c) => exec.execute(base(p, d, s, c!)); }
  if (worker.kind === "hermes") { const exec = createOwnerTrustedLocalHermesExecV1(); runners.hermes = (p, d, s, c) => exec.execute({ ...base(p, d, s, c!), ...hermesProfile }); }
}

let failures = 0;
const report = (kind: string, name: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${kind.padEnd(11)} ${name.padEnd(9)} ${detail}`);
};

for (const [kind, run] of Object.entries(runners)) {
  if (only.length && !only.includes(kind)) continue;
  const scenario = async (name: string, prompt: string, deadlineMs: number, abortAfterMs?: number) => {
    const cwd = mkdtempSync(join(tmpdir(), "acr-probe-"));
    const watch = watchGroups(), controller = new AbortController(), started = Date.now();
    const timer = abortAfterMs ? setTimeout(() => controller.abort(), abortAfterMs) : undefined;
    try {
      const result = await run(prompt, deadlineMs, abortAfterMs ? controller.signal : undefined, cwd);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      await new Promise(r => setTimeout(r, 1500));
      watch.stop();
      const left = leftovers(watch.groups);
      if (left.length) reap(watch.groups);
      return { result, elapsed, left, groups: watch.groups.size };
    } finally {
      clearTimeout(timer); watch.stop();
      if (leftovers(watch.groups).length) reap(watch.groups);
      rmSync(cwd, { recursive: true, force: true });
    }
  };
  const quick = await scenario("complete", QUICK, 240_000);
  report(kind, "complete", quick.result.status === "completed" && /\bok\b/iu.test(quick.result.text ?? "") && quick.left.length === 0,
    `${quick.result.status}${quick.result.reason ? `:${quick.result.reason}` : ""} in ${quick.elapsed}s, text=${JSON.stringify((quick.result.text ?? "").slice(0, 40))}, leftover=${quick.left.length}`);
  const cancel = await scenario("cancel", LONG, 240_000, 1_000);
  report(kind, "cancel", cancel.result.status === "canceled" && cancel.left.length === 0 && cancel.groups > 0,
    `${cancel.result.status}${cancel.result.reason ? `:${cancel.result.reason}` : ""} in ${cancel.elapsed}s, groups=${cancel.groups}, leftover=${cancel.left.join(",") || 0}`);
  const late = await scenario("deadline", LONG, 1_000);
  report(kind, "deadline", late.result.status === "timed_out" && late.left.length === 0 && late.groups > 0,
    `${late.result.status}${late.result.reason ? `:${late.result.reason}` : ""} in ${late.elapsed}s, groups=${late.groups}, leftover=${late.left.join(",") || 0}`);
}
console.log(failures === 0 ? "\nADAPTER PROBE: PASS" : `\nADAPTER PROBE: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

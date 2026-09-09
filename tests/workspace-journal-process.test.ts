import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteBridgeJournal } from "../src/node-bridge/journal";

test("two ready processes compete for one durable workspace intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "cr-workspace-process-")), file = join(root, "journal.sqlite");
  const children: ReturnType<typeof start>[] = [];
  function start() {
    const child = fork(fileURLToPath(new URL("./helpers/workspace-journal-child.ts", import.meta.url)), [file], {
      execArgv: ["--import", "tsx"], silent: true,
      env: { PATH: "/usr/bin:/bin", NODE_ENV: "test", TMPDIR: root },
    });
    let markReady!: () => void, rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { markReady = resolve; rejectReady = reject; });
    let result: unknown;
    child.on("message", (value: { type?: string; result?: unknown }) => {
      if (value.type === "ready") markReady();
      else if (value.type === "result") result = value.result;
    });
    let stderr = "";
    child.stdout?.resume(); child.stderr?.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-4000); });
    const done = new Promise<unknown>((resolve, reject) => {
      child.on("error", error => { rejectReady(error); reject(error); });
      child.on("exit", (code, signal) => {
        rejectReady(new Error(`fixture_exited_before_ready: ${stderr}`));
        if (code === 0 && signal === null) resolve(result); else reject(new Error("fixture_process_failed"));
      });
    });
    // Observe rejection immediately even while the readiness barrier is pending.
    void done.catch(() => {}); void ready.catch(() => {});
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 10000);
    void done.finally(() => clearTimeout(timer)).catch(() => {});
    return { child, ready, done };
  }
  try {
    new SqliteBridgeJournal(file).close();
    children.push(start()); children.push(start());
    await Promise.all(children.map(value => value.ready));
    for (const { child } of children) child.send("reserve");
    const results = await Promise.all(children.map(value => value.done));
    assert.deepEqual(results.sort(), ["existing", "recorded"]);
    const reopened = new SqliteBridgeJournal(file);
    try {
      const inventory = reopened.workspaceIntentInventory();
      assert.equal(inventory.length, 1);
      assert.equal(inventory[0].disposition, "reconciliation_required");
    } finally { reopened.close(); }
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.allSettled(children.map(value => value.done));
    await rm(root, { recursive: true, force: true });
    await assert.rejects(stat(root), { code: "ENOENT" });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteBridgeJournal } from "../src/node-bridge/journal";
import { journaledWorkspacePort } from "../src/harness/codex-v1/journaled-workspace-port";

for (const boundary of ["intent", "creation", "removal", "removed"]) {
  test(`journal survives SIGKILL after ${boundary} without replaying creation`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cr-workspace-crash-"));
    const file = join(root, "journal.sqlite");
    const child = fork(fileURLToPath(new URL("./helpers/workspace-journal-crash-child.ts", import.meta.url)), [file, boundary], {
      execArgv: ["--import", "tsx"], silent: true,
      env: { PATH: "/usr/bin:/bin", NODE_ENV: "test", TMPDIR: root },
    });
    child.stdout?.resume(); child.stderr?.resume();
    let reached = false;
    const done = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.on("message", (value: { type?: string; boundary?: string }) => {
        if (value.type === "boundary" && value.boundary === boundary) {
          reached = true; child.kill("SIGKILL");
        }
      });
      child.once("exit", (code, signal) => {
        if (reached && code === null && signal === "SIGKILL") resolve();
        else reject(new Error("fixture_did_not_reach_crash_boundary"));
      });
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      await done;
      const journal = new SqliteBridgeJournal(file);
      try {
        const rows = journal.workspaceIntentInventory();
        assert.equal(rows.length, 1);
        const saved = rows[0];
        assert.equal(saved.disposition, "reconciliation_required");
        assert.equal(Boolean(saved.creation), boundary !== "intent");
        assert.equal(saved.removal, boundary === "removed" ? "removed" : boundary === "removal" ? "pending" : undefined);
        assert.equal(journal.reserveWorkspaceIntent(saved.intent, () => {}), "existing");
        let effects = 0;
        const port = journaledWorkspacePort({ journal, intent: saved.intent, assertCurrent: () => {},
          port: { inspectRootIdentities: async () => { throw new Error("unexpected_roots"); },
            inspectExisting: async () => { throw new Error("unexpected_inspect"); },
            createDetachedWorktree: async () => { effects++; throw new Error("unexpected_create"); },
            removeWorktree: async () => { effects++; throw new Error("unexpected_remove"); } } });
        await assert.rejects(port.createDetachedWorktree({ repositoryRealPath: saved.intent.repositoryRoot,
          checkoutPath: saved.intent.checkoutPath, revision: saved.intent.revision }), /reconciliation_required/);
        assert.equal(effects, 0);
      } finally { journal.close(); }
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await done.catch(() => {});
      await rm(root, { recursive: true, force: true });
      await assert.rejects(stat(root), { code: "ENOENT" });
    }
  });
}

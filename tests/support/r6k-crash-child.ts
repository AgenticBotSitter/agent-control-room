import { writeSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { PersistentLocalArtifactStorageV1 } from "../../src/artifacts/v1/persistent-local-storage.ts";
import { acquireRotationLock } from "../../scripts/fleet/connector-update.mjs";
const [kind, root, boundary = "none", phase = "after", hit = "1"] = process.argv.slice(2);
const bytes = new TextEncoder().encode("Crash-safe immutable text result.");
const artifactId = "artifact:native:" + "a".repeat(64);
const configuration = { rootPath: root, maximumArtifacts: 100, maximumFileBytes: 65536,
  maximumTotalBytes: 1000000, operationTimeoutMs: 30_000 };
let hits = 0;
const cut = async (at: string) => {
  if (at !== boundary || ++hits !== Number(hit)) return;
  if (phase === "hold") {
    console.log(JSON.stringify({ held: true }));
    await new Promise<void>(done => process.stdin.once("data", () => done()));
  } else {
    writeSync(1, JSON.stringify({ cut: at, phase, hit: hits }) + "\n");
    process.kill(process.pid, "SIGKILL");
  }
};
if (kind === "kernel-probe") {
  const { tryPersistentKernelLockV1 } = await import("../../src/installer/shared/persistent-kernel-lock.mjs");
  try { const guard = await tryPersistentKernelLockV1(join(root, "profile.guard")); await guard?.close(); console.log(JSON.stringify({ code: "accepted" })); }
  catch (error) { console.log(JSON.stringify({ code: (error as Error).message })); }
} else if (kind === "artifact-write") {
  const storage = await PersistentLocalArtifactStorageV1.createForTest(configuration, {
    async run(at, operation) {
      if (phase === "before") await cut(at);
      const value = await operation();
      if (phase !== "before") await cut(at);
      return value;
    },
  });
  await storage.put({ artifactId, bytes });
  console.log(JSON.stringify({ written: true }));
} else if (kind === "artifact-open") {
  const storage = await PersistentLocalArtifactStorageV1.create(configuration);
  const prior = await storage.read(artifactId);
  if (prior && Buffer.compare(Buffer.from(prior), Buffer.from(bytes))) throw new Error("complete_target_changed");
  await storage.put({ artifactId, bytes });
  if (Buffer.compare(Buffer.from((await storage.read(artifactId))!), Buffer.from(bytes))) throw new Error("retry_changed");
  console.log(JSON.stringify({ opened: true, prior: !!prior }));
} else {
  const release = await acquireRotationLock(join(root, "profile.rotate.lock"), {
    deadlineMs: kind === "lock-load" ? 60_000 : 2000, staleMs: 0, getProcessIdentity: async (pid: number) => `fixture-start:${pid}`,
    afterDirectoryElection: async () => cut("directory"),
    afterOwnerPublication: async () => cut("owner"),
    afterCleanerElection: async () => cut("cleaner"),
  });
  if (kind === "lock-load") {
    await appendFile(join(root, "journal"), "enter\n");
    await new Promise(done => setTimeout(done, 10));
    await appendFile(join(root, "journal"), "exit\n");
  }
  await cut("held"); await release(); await cut("released");
  console.log(JSON.stringify({ opened: true }));
}

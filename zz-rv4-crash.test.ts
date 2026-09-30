// REVIEW-ONLY (not for commit): SIGKILL real writer processes (and real recoveries) at random points,
// then a fresh process must open, clean up, re-prove every stored file and write again.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResultFileStoreV1 } from "/Users/alastairfraser/work/acr-cook-files/src/artifacts/v1/result-file-store";

const TRIALS = Number(process.env.RV4_TRIALS ?? 20);
const cfg = (rootPath: string) => ({ rootPath, maximumFiles: 32, maximumFileBytes: 268_435_456,
  maximumSetBytes: 536_870_912, maximumTotalBytes: 10_737_418_240, operationTimeoutMs: 30_000 });
const storeModule = JSON.stringify(join(process.cwd(), "src/artifacts/v1/result-file-store.ts"));
const T = "tenant:rv", P = `project:${"a".repeat(24)}`;

function spawnChild(script: string) {
  const c = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; c.stdout!.on("data", d => { out += d; }); c.stderr!.on("data", d => { out += d; });
  const keep = setInterval(() => {}, 1000);
  const exited = new Promise<void>(r => c.once("exit", () => { clearInterval(keep); r(); }));
  return { c, exited, out: () => out };
}
const sleep = (ms: number) => new Promise(r => { const t = setTimeout(r, ms); void t; });

test("review 4: SIGKILL writers and recoveries mid-flight, then reopen", { timeout: 900_000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), "rv4-crash-"));
  const results: unknown[] = [];
  try {
    const root = join(base, "store"); await mkdir(root, { mode: 0o700 });
    const good = new Map<string, string>(); // storageKey-ish name -> digest (from writer "PUT ok" lines)
    for (let t = 0; t < TRIALS; t++) {
      const killRecovery = t % 4 === 3;
      // Writer: 32 MiB files in a loop; prints each committed file's id+digest.
      const w = spawnChild(`
        const { ResultFileStoreV1 } = await import(${storeModule});
        const { createHash, randomUUID } = await import("node:crypto");
        const s = await ResultFileStoreV1.create(${JSON.stringify(cfg(root))});
        console.log("READY");
        for (;;) {
          const b = new Uint8Array(32 * 1024 * 1024).fill(Math.floor(Math.random() * 255)); crypto.getRandomValues(b.subarray(0, 64));
          const fileId = "result-file:" + randomUUID().replace(/-/g, ""), d = "sha256:" + createHash("sha256").update(b).digest("hex");
          await s.put({ tenantId: "${T}", projectId: "${P}", fileId, contentDigest: d, bytes: b });
          console.log("PUT " + fileId + " " + d);
        }`);
      for (let i = 0; i < 400 && !w.out().includes("READY"); i++) await sleep(10);
      const delay = 30 + Math.floor(Math.random() * 400);
      await sleep(delay);
      const before = await readdir(root);
      w.c.kill("SIGKILL"); await w.exited;
      for (const line of w.out().split("\n")) { const m = /^PUT (\S+) (\S+)$/.exec(line); if (m) good.set(m[1]!, m[2]!); }
      const leftover = (await readdir(root)).filter(e => e.startsWith(".control-room"));
      let recoveryKilled = false;
      if (killRecovery && leftover.length) {
        // Kill a recovering opener too, right after it starts: leaves (maybe) a recovery lock behind.
        const r = spawnChild(`
          const { ResultFileStoreV1 } = await import(${storeModule});
          console.log("GO"); await ResultFileStoreV1.create(${JSON.stringify(cfg(root))}); console.log("OPENED");`);
        for (let i = 0; i < 500 && !r.out().includes("GO"); i++) await sleep(2);
        await sleep(Math.floor(Math.random() * 6));
        r.c.kill("SIGKILL"); await r.exited; recoveryKilled = !r.out().includes("OPENED");
      }
      const leftoverBeforeOpen = (await readdir(root)).filter(e => e.startsWith(".control-room"));
      // A fresh opener in THIS process.
      let opened = "opened"; let store: ResultFileStoreV1 | undefined;
      try { store = await ResultFileStoreV1.create(cfg(root)); } catch (e) { opened = String((e as { code?: string }).code ?? e); }
      const after = await readdir(root);
      let reads = 0, readBad = 0, putAfter = "skipped";
      if (store) {
        for (const [fileId, d] of good) {
          try { const b = await store.read({ tenantId: T, projectId: P, fileId, contentDigest: d }); if (b) reads++; else readBad++; }
          catch { readBad++; }
        }
        const b = new Uint8Array(1024).fill(t);
        try { await store.put({ tenantId: T, projectId: P, fileId: "result-file:" + randomUUID().replace(/-/g, ""),
          contentDigest: "sha256:" + createHash("sha256").update(b).digest("hex"), bytes: b }); putAfter = "ok"; }
        catch (e) { putAfter = String((e as { code?: string }).code ?? e); }
      }
      results.push({ t, delay, bookkeepingBeforeKill: before.filter(e => e.startsWith(".control-room")).length,
        leftover, recoveryKilled, leftoverBeforeOpen, opened,
        bookkeepingAfterOpen: after.filter(e => e.startsWith(".control-room")), committed: good.size, reads, readBad, putAfter });
    }
    // Stray non-bookkeeping, non-result entries?
    const strays = (await readdir(root)).filter(e => !e.endsWith(".crbf"));
    const summary = { trials: TRIALS,
      withLeftover: results.filter((r: any) => r.leftover.length).length,
      recoveriesKilled: results.filter((r: any) => r.recoveryKilled).length,
      openedAll: results.every((r: any) => r.opened === "opened"),
      notOpened: results.filter((r: any) => r.opened !== "opened"),
      cleanAfterOpen: results.every((r: any) => r.bookkeepingAfterOpen.length === 0),
      readBadTotal: results.reduce((a: number, r: any) => a + r.readBad, 0),
      putAfterAllOk: results.every((r: any) => r.putAfter === "ok"), strays };
    console.log(`FINDING R4_crash ${JSON.stringify(summary)}`);
    for (const r of results) console.log(`TRIAL ${JSON.stringify(r)}`);
    void readFile;
  } finally { await rm(base, { recursive: true, force: true }); }
});

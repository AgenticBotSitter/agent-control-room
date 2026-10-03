import assert from "node:assert/strict";
import test from "node:test";
import { loadUsagePriceTableFromRootV1 } from "../src/usage/v1/usage-price-table-loader";

const file = { isFile: () => true, isSymbolicLink: () => false, mode: 0o100600, uid: 501 };
const table = { schema: "control-room.usage-price-table/v1", tableId: "owner-table",
  recordedAt: "2026-09-28T00:00:00.000Z", entries: [] };

test("the owner price table loader distinguishes missing, recorded and unsafe files", async () => {
  assert.equal(await loadUsagePriceTableFromRootV1("/protected", {
    open: async () => { const error = new Error() as NodeJS.ErrnoException; error.code = "ENOENT"; throw error; },
    uid: () => 501,
  } as never), undefined);
  assert.deepEqual(await loadUsagePriceTableFromRootV1("/protected", {
    open: async () => ({ stat: async () => file, readFile: async () => JSON.stringify(table), close: async () => {} }), uid: () => 501,
  } as never), table);
  await assert.rejects(loadUsagePriceTableFromRootV1("/protected", {
    open: async () => ({ stat: async () => ({ ...file, mode: 0o100644 }), readFile: async () => JSON.stringify(table), close: async () => {} }), uid: () => 501,
  } as never), /usage_price_table_unsafe/);
});

test("M3-PRICE-01: descriptor checks refuse unsafe metadata and close on every failure", async () => {
  for (const scenario of ["type", "mode", "owner", "stat", "read", "json", "schema"] as const) {
    let closed = 0, reads = 0;
    await assert.rejects(loadUsagePriceTableFromRootV1("/protected", {
      uid: () => 501,
      open: async () => ({
        stat: async () => {
          if (scenario === "stat") throw new Error("stat_failed");
          return { ...file, isFile: () => scenario !== "type",
            mode: scenario === "mode" ? 0o100644 : file.mode, uid: scenario === "owner" ? 502 : file.uid };
        },
        readFile: async () => {
          reads++;
          if (scenario === "read") throw new Error("read_failed");
          return scenario === "json" ? "{" : scenario === "schema" ? "{}" : JSON.stringify(table);
        },
        close: async () => { closed++; },
      }),
    } as never), scenario === "stat" ? /stat_failed/ : ["type", "mode", "owner"].includes(scenario)
      ? /usage_price_table_unsafe/ : /usage_price_table_invalid/);
    assert.equal(closed, 1, scenario);
    assert.equal(reads, ["type", "mode", "owner", "stat"].includes(scenario) ? 0 : 1, scenario);
  }
});

test("M3-PRICE-01: 50 native reads refuse a symlink even to an otherwise safe price file", async () => {
  const { mkdtemp, writeFile, symlink, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(process.cwd(), ".qa-price-symlink-"));
  try {
    await writeFile(join(root, "safe.json"), JSON.stringify(table), { mode: 0o600 });
    await symlink("safe.json", join(root, "usage-prices.json"));
    await Promise.all(Array.from({ length: 50 }, () =>
      assert.rejects(loadUsagePriceTableFromRootV1(root), /usage_price_table_unsafe/)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("M3-PRICE-01: a native FIFO is refused without waiting for a writer", async () => {
  const { mkdtemp, open, rm } = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(process.cwd(), ".qa-price-fifo-"));
  let timer: ReturnType<typeof setTimeout> | undefined, load: Promise<unknown> | undefined;
  try {
    const made = spawnSync("mkfifo", ["-m", "600", join(root, "usage-prices.json")]);
    assert.equal(made.status, 0);
    load = loadUsagePriceTableFromRootV1(root);
    await assert.rejects(Promise.race([load, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("price_loader_stalled")), 1000);
    })]), /usage_price_table_unsafe/);
  } finally {
    clearTimeout(timer);
    // Release a blocked reader if the nonblocking-open guard is mutated away.
    try { await (await open(join(root, "usage-prices.json"), constants.O_WRONLY | constants.O_NONBLOCK)).close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error; }
    await load?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});


test("M3-PRICE-01: replacement after inspection cannot change the descriptor being read", async () => {
  const { lstat, open, mkdtemp, writeFile, rename, symlink, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(process.cwd(), ".qa-price-race-"));
  const path = join(root, "usage-prices.json"), replacement = join(root, "replacement.json");
  let closed = 0;
  const swap = async () => { await rename(path, join(root, "original.json")); await symlink("replacement.json", path); };
  try {
    await writeFile(path, JSON.stringify(table), { mode: 0o600 });
    await writeFile(replacement, JSON.stringify({ ...table, tableId: "replacement" }), { mode: 0o644 });
    const result = await loadUsagePriceTableFromRootV1(root, {
      uid: () => process.getuid?.(),
      lstat: async (input: string) => { const entry = await lstat(input); await swap(); return entry; },
      readFile: (await import("node:fs/promises")).readFile,
      open: async (input: string, flags: number) => {
        const handle = await open(input, flags);
        return { stat: async () => { const entry = await handle.stat(); await swap(); return entry; },
          readFile: () => handle.readFile("utf8"), close: async () => { closed++; await handle.close(); } };
      },
    } as never);
    assert.equal(result?.tableId, table.tableId);
    assert.equal(closed, 1);
    await assert.rejects(loadUsagePriceTableFromRootV1(root), /usage_price_table_unsafe/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

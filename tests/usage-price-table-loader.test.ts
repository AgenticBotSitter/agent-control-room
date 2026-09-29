import assert from "node:assert/strict";
import test from "node:test";
import { loadUsagePriceTableFromRootV1 } from "../src/usage/v1/usage-price-table-loader";

const file = { isFile: () => true, isSymbolicLink: () => false, mode: 0o100600, uid: 501 };
const table = { schema: "control-room.usage-price-table/v1", tableId: "owner-table",
  recordedAt: "2026-09-28T00:00:00.000Z", entries: [] };

test("the owner price table loader distinguishes missing, recorded and unsafe files", async () => {
  assert.equal(await loadUsagePriceTableFromRootV1("/protected", {
    lstat: async () => { const error = new Error() as NodeJS.ErrnoException; error.code = "ENOENT"; throw error; },
    readFile: async () => "", uid: () => 501,
  } as never), undefined);
  assert.deepEqual(await loadUsagePriceTableFromRootV1("/protected", {
    lstat: async () => file, readFile: async () => JSON.stringify(table), uid: () => 501,
  } as never), table);
  await assert.rejects(loadUsagePriceTableFromRootV1("/protected", {
    lstat: async () => ({ ...file, mode: 0o100644 }), readFile: async () => JSON.stringify(table), uid: () => 501,
  } as never), /usage_price_table_unsafe/);
});

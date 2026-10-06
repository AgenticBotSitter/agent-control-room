import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { usagePriceTableSchemaV1, type UsagePriceTableV1 } from "./usage-cost";

type Runtime = Readonly<{ open: typeof open; uid: () => number | undefined }>;
const production: Runtime = { open, uid: () => process.getuid?.() };

/** Reads owner-authored billing facts only. Missing means cost remains unknown;
 * no vendor price or billing plan is inferred from the selected harness. */
export async function loadUsagePriceTableFromRootV1(protectedRoot: string,
  runtime: Runtime = production): Promise<UsagePriceTableV1 | undefined> {
  const path = join(protectedRoot, "usage-prices.json");
  let handle;
  try { handle = await runtime.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("usage_price_table_unsafe");
    throw error;
  }
  try {
    const entry = await handle.stat(), uid = runtime.uid();
    if (!entry.isFile() || (entry.mode & 0o077) !== 0 || uid !== undefined && entry.uid !== uid)
      throw new Error("usage_price_table_unsafe");
    try { return usagePriceTableSchemaV1.parse(JSON.parse(await handle.readFile("utf8"))); }
    catch { throw new Error("usage_price_table_invalid"); }
  } finally { await handle.close(); }
}

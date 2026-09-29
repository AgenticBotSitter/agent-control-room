import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { usagePriceTableSchemaV1, type UsagePriceTableV1 } from "./usage-cost";

type Runtime = Readonly<{ lstat: typeof lstat; readFile: typeof readFile; uid: () => number | undefined }>;
const production: Runtime = { lstat, readFile, uid: () => process.getuid?.() };

/** Reads owner-authored billing facts only. Missing means cost remains unknown;
 * no vendor price or billing plan is inferred from the selected harness. */
export async function loadUsagePriceTableFromRootV1(protectedRoot: string,
  runtime: Runtime = production): Promise<UsagePriceTableV1 | undefined> {
  const path = join(protectedRoot, "usage-prices.json");
  let entry;
  try { entry = await runtime.lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const uid = runtime.uid();
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || uid !== undefined && entry.uid !== uid)
    throw new Error("usage_price_table_unsafe");
  try { return usagePriceTableSchemaV1.parse(JSON.parse(await runtime.readFile(path, "utf8"))); }
  catch { throw new Error("usage_price_table_invalid"); }
}

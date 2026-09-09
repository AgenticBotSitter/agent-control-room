import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database";
import { exerciseScheduleStore } from "./helpers/schedule-store-scenario";

test("calendar occurrence persistence, replay, reconciliation and cancelled refusal", async () => {
  const raw = new PGlite();
  try {
    for (const file of (await readdir("db/migrations")).filter(file => file.endsWith(".sql")).sort())
      await raw.exec(await readFile(`db/migrations/${file}`, "utf8"));
    await exerciseScheduleStore(adaptPglite(raw), async () => adaptPglite(raw));
  } finally { await raw.close(); }
});

import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database";
import { exerciseScheduleStore } from "./helpers/schedule-store-scenario";
import { ScheduleOccurrenceStore } from "../src/services/v1/occurrence-store";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

test("calendar occurrence persistence, replay, reconciliation and cancelled refusal", async () => {
  const raw = new PGlite();
  try {
    for (const file of (await readdir("db/migrations")).filter(file => file.endsWith(".sql")).sort())
      await raw.exec(await readFile(`db/migrations/${file}`, "utf8"));
    await exerciseScheduleStore(adaptPglite(raw), async () => adaptPglite(raw));
    const db = adaptPglite(raw);
    const failOutbox = (session: DatabaseSession): DatabaseSession => ({
      query: (sql, params) => {
        if (sql.startsWith("INSERT INTO control_outbox")) throw new Error("synthetic_outbox_failure");
        return session.query(sql, params);
      },
    });
    const failing: DatabaseClient = { ...db,
      transaction: callback => db.transaction(session => callback(failOutbox(session))),
      transactionWithPreCommitCheck: (callback, check) => db.transactionWithPreCommitCheck(session => callback(failOutbox(session)), check),
    };
    const proposal = { tenantId: "tenant:calendar", scheduleId: "schedule:rollback",
      occurrenceKey: "schedule:rollback:2026-11-01T09:00", scheduledFor: "2026-11-01T09:00:00.000Z",
      localTime: "2026-11-01T09:00", targetType: "job" as const, targetId: "job:rollback",
      definitionDigest: `sha256:${"a".repeat(64)}`, createdAt: "2026-11-01T08:00:00.000Z" };
    await assert.rejects(new ScheduleOccurrenceStore(failing).materialize(proposal), /synthetic_outbox_failure/);
    assert.equal((await raw.query("SELECT * FROM control_schedule_occurrences WHERE schedule_id='schedule:rollback'")).rows.length, 0);
    assert.equal((await new ScheduleOccurrenceStore(db).materialize(proposal)).replayed, false);
  } finally { await raw.close(); }
});

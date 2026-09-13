import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatabaseClient } from "../src/persistence/database";
import { prepared, syntheticLifecycle } from "./owner-bootstrap-ceremony-helper";

test("every failure after accepted peer proof closes exactly once and cleanup uncertainty wins", async t => {
  // Four isolated databases cover distinct accepted-control boundaries in this process.
  for (const kind of ["database", "post-query-abort", "entropy", "entropy-cleanup"] as const) {
    let countQueries = 0;
    const wrap = kind === "database" ? (base: DatabaseClient): DatabaseClient => ({
      query: async (sql, values) => {
        if (sql.includes("count(*)") && ++countQueries === 2) throw new Error("synthetic_database_failure");
        return base.query(sql, values);
      }, transaction: base.transaction.bind(base), transactionWithPreCommitCheck: base.transactionWithPreCommitCheck.bind(base),
    }) : undefined;
    const controller = new AbortController();
    const lifecycle = kind === "post-query-abort" ? { ...syntheticLifecycle(), async claim() { controller.abort(); } }
      : syntheticLifecycle();
    const x = await prepared(wrap, lifecycle,
      kind === "entropy" || kind === "entropy-cleanup" ? { random: () => new Uint8Array(31) } : {});
    t.after(() => x.raw.close()); let closes = 0;
    const attempt = x.attempt({ async close() {
      closes++; if (kind === "entropy-cleanup") throw new Error("synthetic_cleanup_uncertain");
    } });
    await assert.rejects(x.ceremony.arm(attempt, controller.signal),
      kind === "entropy-cleanup" ? /cleanup_uncertain/ : /control_uncertain/);
    assert.equal(closes, 1);
    assert.equal((await x.base.query<{ count: string }>("SELECT count(*)::text AS count FROM control_identities")).rows[0]?.count, "0");
  }
});

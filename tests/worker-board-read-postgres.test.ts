// Real PostgreSQL proof for the worker-board read.  This deliberately uses the
// production web role: a fake database client cannot demonstrate that the
// browser-facing read has only the permissions it needs.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { DatabaseWorkerBoardReadSourceV1 } from "../src/web/v1/worker-board-read";

const PORT = Number(process.env.WORKER_BOARD_PG_PORT ?? 58380);
const PG = requiresRealPostgres();

test("worker-board attribution runs as the production web role and remains bounded on an empty fleet", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const client = new Client(postgres.connection("web")); await client.connect();
    try {
      // The source is a read-only query port; bind only that port from the
      // production-role client rather than granting this test a transaction or
      // mutation capability it does not exercise.
      const view = await new DatabaseWorkerBoardReadSourceV1({ query: client.query.bind(client) } as never)
        .read({ tenantId: "tenant:worker-board", now: "2026-09-29T12:00:00.000Z" });
      assert.deepEqual(view.workers, []);
    } finally { await client.end(); }
  }, { port: PORT, allowedPorts: [58380], boundMs: 60_000 });
});

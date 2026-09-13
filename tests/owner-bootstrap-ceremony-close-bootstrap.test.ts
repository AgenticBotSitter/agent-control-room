import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatabaseClient } from "../src/persistence/database";
import { prepared } from "./owner-bootstrap-ceremony-helper";

test("close during owner transaction cannot resurrect the ceremony", async t => {
  let started!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { started = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const x = await prepared((base): DatabaseClient => ({ query: base.query.bind(base), transaction: base.transaction.bind(base),
    transactionWithPreCommitCheck: (work, check) => base.transactionWithPreCommitCheck(work, async () => {
      started(); await proceed; await check();
    }) }));
  t.after(() => x.raw.close()); await x.ceremony.arm(x.attempt());
  const routed = x.ceremony.route(x.browser()); await reached; await x.ceremony.close(); release();
  assert.equal((await routed)?.status, 503);
  assert.equal((await x.ceremony.route(x.browser()))?.status, 503);
});

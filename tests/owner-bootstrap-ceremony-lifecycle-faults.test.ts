import assert from "node:assert/strict";
import { test } from "node:test";
import { prepared, syntheticLifecycle } from "./owner-bootstrap-ceremony-helper";

test("durable lifecycle claim and completion timeouts become terminal uncertainty", async t => {
  for (const kind of ["claim", "complete"] as const) {
    const base = syntheticLifecycle();
    const lifecycle = kind === "claim" ? { ...base, claim: () => new Promise<void>(() => {}) }
      : { ...base, complete: () => new Promise<void>(() => {}) };
    const x = await prepared(undefined, lifecycle); t.after(() => x.raw.close());
    let closes = 0;
    if (kind === "claim") {
      await assert.rejects(x.ceremony.arm(x.attempt({ async close() { closes++; } })), /control_uncertain/);
      assert.equal(closes, 1);
    }
    else {
      await x.ceremony.arm(x.attempt());
      assert.equal((await x.ceremony.route(x.browser()))?.status, 503);
      assert.equal((await x.base.query<{ count: string }>("SELECT count(*)::text AS count FROM control_identities")).rows[0]?.count, "1");
    }
    assert.equal((await x.ceremony.route(x.browser()))?.status, 503);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { prepared, syntheticLifecycle } from "./owner-bootstrap-ceremony-helper";

function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}

test("close is a permanent fence across late inspect, claim, delivery, and marker completion", async t => {
  // Four databases are isolated in this process; each case targets one late-return boundary.
  for (const kind of ["inspect", "claim", "write", "complete"] as const) {
    const started = deferred(), release = deferred(), base = syntheticLifecycle();
    const lifecycle = kind === "inspect" ? { ...base, async inspect() { started.resolve(); await release.promise; return "available" as const; } }
      : kind === "claim" ? { ...base, async claim() { started.resolve(); await release.promise; await base.claim(new AbortController().signal); } }
      : kind === "complete" ? { ...base, async complete() { started.resolve(); await release.promise; await base.complete(new AbortController().signal); } }
      : base;
    const x = await prepared(undefined, lifecycle); t.after(() => x.raw.close());
    if (kind === "inspect") {
      await started.promise; await x.ceremony.close(); release.resolve();
      assert.equal((await x.ceremony.route(x.browser()))?.status, 503);
      await assert.rejects(x.ceremony.arm(x.attempt()), /unavailable/);
      continue;
    }
    let closes = 0;
    if (kind === "claim") {
      const armed = x.ceremony.arm(x.attempt({ async close() { closes++; } }));
      await started.promise; await x.ceremony.close(); release.resolve(); await assert.rejects(armed, /uncertain/);
      assert.equal(closes, 1);
    } else if (kind === "write") {
      const armed = x.ceremony.arm(x.attempt({ async writeCode() { started.resolve(); await release.promise; }, async close() { closes++; } }));
      await started.promise; await x.ceremony.close(); release.resolve(); await assert.rejects(armed, /uncertain/);
      assert.equal(closes, 1);
    } else {
      await x.ceremony.arm(x.attempt()); const routed = x.ceremony.route(x.browser());
      await started.promise; await x.ceremony.close(); release.resolve();
      assert.equal((await routed)?.status, 503);
    }
    assert.equal((await x.ceremony.route(x.browser()))?.status, 503);
  }
});

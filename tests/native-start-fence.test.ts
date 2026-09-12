import test from "node:test";
import assert from "node:assert/strict";
import { nativeStartAuthorityFixture } from "./helpers/native-start-authority";

test("native start rejects asynchronous freshness before admission or effect markers", async t => {
  const f = await nativeStartAuthorityFixture(); t.after(f.close);
  for (const operation of ["check", "mark"] as const) for (const source of ["policy", "profile"] as const)
    for (const failureCall of [1, 2]) for (const rejection of [false, true]) {
      let checks = 0;
      const fence = () => {
        if (++checks === failureCall) return rejection ? Promise.reject(new Error("synthetic_revocation")) : Promise.resolve();
      };
      const controller = f.create(source === "policy"
        ? { readCurrent: async signal => ({ ...await f.dependencies.readCurrent(signal), assertFresh: fence }) }
        : { assertProfileCurrent: async () => fence });
      try {
        await assert.rejects(operation === "mark" ? controller.authority.markStart(f.prepared.binding)
          : controller.authority.check("capabilities", f.prepared.binding), /native_start_authority_unavailable/);
        assert.equal(checks, failureCall);
        assert.equal(f.effects.countFull(), 0);
        assert.equal(f.calls.length, 0);
        await new Promise<void>(resolve => setImmediate(resolve));
      } finally { controller.close(); }
    }
  for (const invalid of [false, null, 0]) {
    const controller = f.create({ readCurrent: async signal => ({ ...await f.dependencies.readCurrent(signal),
      assertFresh: invalid as unknown as () => void }) });
    try { await assert.rejects(controller.authority.markStart(f.prepared.binding), /native_start_authority_unavailable/); }
    finally { controller.close(); }
    assert.equal(f.effects.countFull(), 0);
  }
  const positive = f.create(); t.after(() => positive.close());
  await f.adapter(positive).start(f.prepared.start);
  assert.equal(f.calls.filter(value => value === "start").length, 1);
  assert.equal(f.effects.countFull(), 1);
});

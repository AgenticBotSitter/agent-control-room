import test from "node:test";
import assert from "node:assert/strict";
import { NativeObservationReporter } from "../src/harness/hermes-native-v1/observation-reporter";
import { managedNativeSessionFixture, currentSignal } from "./helpers/managed-native-session";

test("late or uncertain publication cannot revive a closed reporting owner or invoke native work", async t => {
  const x = await managedNativeSessionFixture(); t.after(x.close);
  const peer = await x.attach(); await x.handshake(peer); const native = await x.dispatch(peer);
  await native.produce("start");
  const saved = x.local.journal.load(x.registration.id), calls = [...x.local.calls], pin = x.settings.nodes[0];
  for (const mode of ["closed", "aborted", "timeout"] as const) await t.test(mode, async () => {
    let entered!: () => void, release!: () => void;
    const publishing = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const abort = new AbortController(); let count = 0;
    const reporter = new NativeObservationReporter({ queueId: native.handoff.queueId,
      enrollment: x.f.prepared.enrollment, serverId: pin.serverId, serverKeyId: pin.serverKeyId,
      serverPublicKeySpki: pin.serverPublicKeySpki }, {
      deliveries: peer.peer.journal, runs: { load: x.local.journal.load.bind(x.local.journal) }, clock: x.f.clock,
      assertAvailable: () => {}, bridge: { async publishNativeSnapshot(body, now) {
        count++; peer.peer.journal.appendNativeSnapshot(body, now); entered(); await pending; return "duplicate";
      } },
    });
    const reporting = reporter.report(abort.signal); await publishing;
    if (mode === "closed") reporter.close();
    if (mode === "aborted") abort.abort();
    if (mode !== "timeout") release();
    await assert.rejects(reporting, { message: "native_observation_reporter_unavailable" });
    release(); await new Promise<void>(resolve => setImmediate(resolve));
    await assert.rejects(reporter.report(currentSignal()), { message: "native_observation_reporter_unavailable" });
    assert.equal(count, 1); assert.deepEqual(x.local.calls, calls);
    assert.deepEqual(x.local.journal.load(x.registration.id), saved);
  });
});

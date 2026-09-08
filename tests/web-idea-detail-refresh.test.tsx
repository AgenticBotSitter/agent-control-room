import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createIdeaDetailRefresh } from "../src/web/v1/idea-detail-refresh";
import { BrowserRequestError } from "../src/web/v1/browser-client";
import type { IdeaDetail } from "../src/web/v1/idea-wire";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { IdeaDiscussion } from "../private-app/app/idea-workspace";

function detail(state?: "running" | "completed"): IdeaDetail {
  const fixture = buildIdeaLabFixtureV1();
  return { session: fixture.session, contributions: [], synthesis: null, decision: null,
    canDecide: false, canPromote: false, canCreate: false, canStop: !!state, canStart: !state,
    canSynthesize: false, execution: "authorization_required", observedAt: fixture.session.createdAt,
    run: state ? { runId: "idea-run:refresh", sessionId: fixture.session.sessionId, sessionDigest: fixture.session.sessionDigest,
      state, messagesUsed: 0, maxMessages: fixture.session.maxMessages, costUsd: 0, providerContacted: false,
      retryPermitted: false, updatedAt: fixture.session.createdAt, cancellationRequestedAt: null, attempts: [] } : null } as IdeaDetail;
}
test("uncertain start is observed through reads only, without overlapping reads or polling terminal runs", async () => {
  let count = 0, value = detail(), release: (() => void) | undefined, hidden = false;
  const accepted: IdeaDetail[] = [];
  const controller = createIdeaDetailRefresh({ read: async () => { count++; if (release) await new Promise<void>(resolve => { release = resolve; }); return value; },
    accept: result => accepted.push(result), failed: error => assert.fail(String(error)), hidden: () => hidden });
  await controller.read(); await controller.read(true); assert.equal(count, 1);
  controller.watchStart(); value = detail("running"); release = () => {};
  const pending = controller.read(true); await controller.read(true); assert.equal(count, 2);
  release!(); await pending; release = undefined;
  hidden = true; await controller.read(true); assert.equal(count, 2); hidden = false;
  value = detail("completed"); await controller.read(true); await controller.read(true);
  assert.equal(count, 3); assert.equal(accepted.at(-1)?.run?.state, "completed"); controller.stop();
});
test("pending decision keeps its retained rendered form despite late GET, read error and manual refresh", async () => {
  let shown = { ...detail("completed"), synthesis: buildIdeaLabFixtureV1().synthesis, canDecide: true };
  let calls = 0, reject = false, release!: () => void;
  let pending: Promise<void> | undefined;
  const controller = createIdeaDetailRefresh({ read: async () => { calls++; if (pending) await pending;
    if (reject) throw new BrowserRequestError("authentication_required"); return { ...shown, canDecide: false }; },
    accept: value => { shown = value as typeof shown; }, failed: () => {}, hidden: () => false });
  const before = renderToStaticMarkup(<IdeaDiscussion detail={shown} />);
  assert.match(before, /Save my decision/);
  pending = new Promise<void>(resolve => { release = resolve; });
  const reading = controller.read(); controller.hold(true); release(); await reading;
  await controller.read(); assert.equal(calls, 1);
  assert.equal(renderToStaticMarkup(<IdeaDiscussion detail={shown} />), before);
  controller.hold(false); pending = undefined; reject = true; await controller.read();
  assert.equal(renderToStaticMarkup(<IdeaDiscussion detail={shown} />), before);
  controller.stop();
});
test("automatic observations are finite and stop after authorization failure; explicit read can recover", async () => {
  let count = 0, deny = false;
  const controller = createIdeaDetailRefresh({ read: async () => { count++; if (deny) throw new BrowserRequestError("authentication_required"); return detail("running"); },
    accept: () => {}, failed: () => {}, hidden: () => false });
  await controller.read(); deny = true; await controller.read(true); await controller.read(true); assert.equal(count, 2);
  deny = false; await controller.read();
  for (let n = 0; n < 200; n++) await controller.read(true);
  assert.equal(count, 182); controller.stop(); await controller.read(); assert.equal(count, 182);
});

test("stopping aborts deferred reads and suppresses late success and failure callbacks", async () => {
  for (const rejectLate of [false, true]) {
    let signal!: AbortSignal, settle!: () => void, accepted = 0, failed = 0;
    const deferred = new Promise<void>(resolve => { settle = resolve; });
    const controller = createIdeaDetailRefresh({ read: async value => {
      signal = value; await deferred;
      if (rejectLate) throw new BrowserRequestError("unavailable");
      return detail("running");
    }, accept: () => { accepted++; }, failed: () => { failed++; }, hidden: () => false });
    const reading = controller.read();
    assert.equal(signal.aborted, false);
    controller.stop(); assert.equal(signal.aborted, true);
    settle(); await reading;
    assert.equal(accepted, 0); assert.equal(failed, 0);
  }
});

test("a completed hold cycle still discards the older outstanding read", async () => {
  let settle!: () => void, accepted = 0, failed = 0;
  const deferred = new Promise<void>(resolve => { settle = resolve; });
  const controller = createIdeaDetailRefresh({ read: async () => { await deferred; return detail("completed"); },
    accept: () => { accepted++; }, failed: () => { failed++; }, hidden: () => false });
  const reading = controller.read();
  controller.hold(true); controller.hold(false);
  settle(); await reading;
  assert.equal(accepted, 0); assert.equal(failed, 0);
  await controller.read(); assert.equal(accepted, 1);
  controller.stop();
});

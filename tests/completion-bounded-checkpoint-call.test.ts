import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedCheckpointCall, CheckpointCallError } from "../src/completion-gate/v1/bounded-checkpoint-call";

const uncertain = (error: unknown) => error instanceof CheckpointCallError && error.outcome === "uncertain";

test("pre-abort and invalid timeouts dispatch nothing", async () => {
  let calls = 0;
  for (const timeoutMs of [0, -1, Infinity, 30_001, 1.5, 10]) {
    const controller = new AbortController();
    if (timeoutMs === 10) controller.abort();
    await assert.rejects(boundedCheckpointCall({ signal: controller.signal, timeoutMs,
      dispatch: () => { calls++; return { cancel() {} }; },
    }), (error: unknown) => error instanceof CheckpointCallError && error.outcome === "not_dispatched");
  }
  assert.equal(calls, 0);
});

test("successful synchronous callback returns once and detaches abort", async () => {
  const controller = new AbortController();
  let cancels = 0;
  const value = await boundedCheckpointCall({ signal: controller.signal, timeoutMs: 1000,
    dispatch: (deadline, callback) => {
      assert.ok(deadline > Date.now());
      callback(null, "first"); callback(null, "second");
      return { cancel() { cancels++; } };
    },
  });
  controller.abort();
  assert.equal(value, "first"); assert.equal(cancels, 0);
});

test("abort during dispatch cancels returned handle and refuses late success", async () => {
  const controller = new AbortController();
  let cancels = 0;
  let calls = 0;
  await assert.rejects(boundedCheckpointCall({ signal: controller.signal, timeoutMs: 1000,
    dispatch: (_deadline, callback) => {
      calls++; controller.abort(); callback(null, "late");
      return { cancel() { cancels++; } };
    },
  }), uncertain);
  assert.equal(calls, 1); assert.equal(cancels, 1);
});

test("timeout rejects an ignored cancellation and late reply without retry", async () => {
  let reply: ((error: unknown, value?: string) => void) | undefined;
  let cancels = 0;
  let calls = 0;
  await assert.rejects(boundedCheckpointCall<string>({ signal: new AbortController().signal, timeoutMs: 10,
    dispatch: (_deadline, callback) => { calls++; reply = callback; return { cancel() { cancels++; } }; },
  }), uncertain);
  reply?.(null, "late");
  await Promise.resolve();
  assert.equal(cancels, 1); assert.equal(calls, 1);
});

test("dispatch failure and callback error are sanitized and never retried", async () => {
  for (const throws of [true, false]) {
    let calls = 0;
    await assert.rejects(boundedCheckpointCall({ signal: new AbortController().signal, timeoutMs: 1000,
      dispatch: (_deadline, callback) => {
        calls++;
        if (throws) throw new Error("sensitive transport detail");
        callback(new Error("sensitive transport detail"));
        return { cancel() { throw new Error("sensitive cancel detail"); } };
      },
    }), (error: unknown) => uncertain(error) && !(error as Error).message.includes("sensitive"));
    assert.equal(calls, 1);
  }
});

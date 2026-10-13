import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { drainingPool } from "./support/draining-pool";

// Synthetic connect/end scheduling over a real pg Pool, not a claim about the
// wire protocol. The PostgreSQL caller files exercise the real socket boundary.
function clientFor(pool: ReturnType<typeof drainingPool>["pool"]) {
  const client = new EventEmitter();
  pool.emit("connect", client as unknown as PoolClient);
  return client;
}

test("draining pool waits for every client end acknowledgement after pool.end", async () => {
  const drained = drainingPool({});
  const clients = Array.from({ length: 50 }, () => clientFor(drained.pool));
  let completed = false;
  const ending = drained.end().then(() => { completed = true; });
  try {
    await nextTurn();
    assert.equal(completed, false, "pool.end alone must not allow fixture shutdown");
    for (const client of clients.slice(0, -1)) client.emit("end");
    await nextTurn();
    assert.equal(completed, false, "the last client must acknowledge end too");
    clients.at(-1)!.emit("end");
    await ending;
    assert.equal(completed, true, "all acknowledgements allow fixture shutdown");
  } finally {
    for (const client of clients) client.emit("end");
    await ending;
  }
});

test("draining pool closes empty pools and clients that ended before shutdown", async () => {
  const drained = drainingPool({});
  clientFor(drained.pool).emit("end");
  await drained.end();
  await drainingPool({}).end();
});

test("draining pool shares shutdown between concurrent callers", async () => {
  const drained = drainingPool({});
  const client = clientFor(drained.pool);
  const endings = Array.from({ length: 25 }, () => drained.end());
  try {
    client.emit("end");
    await Promise.all(endings);
    await drained.end();
  } finally {
    client.emit("end");
    await Promise.allSettled(endings);
  }
});

test("draining pool refuses missing end acknowledgement within its bound", async () => {
  const drained = drainingPool({}, 10);
  const client = clientFor(drained.pool);
  // Eventually acknowledge so a disabled deadline is an assertion failure,
  // rather than a hung test, cancelled body or runner timeout.
  const release = setTimeout(() => client.emit("end"), 100);
  try {
    await assert.rejects(drained.end(), {
      message: "test pool drain timed out after 10ms waiting for client end acknowledgements",
    });
  } finally {
    clearTimeout(release);
    client.emit("end");
  }
});

// Reproduce the coordination adapter's direct pool.end(), then fixture end().
test("draining pool shares raw adapter and fixture shutdown and ends the native pool once", async t => {
  const nativeEnd = Pool.prototype.end;
  let calls = 0;
  t.mock.method(Pool.prototype, "end", function (this: Pool) {
    calls++;
    return (nativeEnd as (this: Pool) => Promise<void>).call(this);
  });
  const drained = drainingPool({});
  await drained.pool.end();
  await drained.end();
  await drained.pool.end();
  assert.equal(calls, 1, "adapter, fixture and retry must call native end exactly once");
});

test("draining pool keeps 50 mixed raw and fixture callers behind the last acknowledgement", async () => {
  const drained = drainingPool({});
  const client = clientFor(drained.pool);
  let completed = 0;
  const endings = Array.from({ length: 50 }, (_, index) =>
    (index % 2 ? drained.end() : drained.pool.end()).then(() => { completed++; }));
  for (const ending of endings) void ending.catch(() => {});
  try {
    await nextTurn();
    assert.equal(completed, 0, "neither raw nor fixture callers may pass the barrier early");
    client.emit("end");
    await Promise.all(endings);
    assert.equal(completed, 50, "all 50 callers must complete after acknowledgement");
    assert.equal(drained.pool.end(), drained.end(), "raw and fixture calls share one promise");
  } finally {
    client.emit("end");
    await Promise.allSettled(endings);
  }
});

test("draining pool preserves callback shutdown and waits for acknowledgement", async () => {
  const drained = drainingPool({});
  const client = clientFor(drained.pool);
  let completed = false;
  const callback = new Promise<void>((resolve, reject) => {
    const returned = drained.pool.end((error?: Error) => {
      if (error) reject(error);
      else { completed = true; resolve(); }
    });
    assert.equal(returned, undefined, "callback overload returns void like pg-pool");
  });
  try {
    await nextTurn();
    assert.equal(completed, false, "callback must wait for the socket acknowledgement");
    client.emit("end");
    await callback;
    await drained.end();
  } finally {
    client.emit("end");
    await callback.catch(() => {});
  }
});

test("draining pool retains a failed shutdown for raw, callback and fixture retries", async () => {
  const drained = drainingPool({}, 10);
  const client = clientFor(drained.pool);
  const expected = { message: "test pool drain timed out after 10ms waiting for client end acknowledgements" };
  const release = setTimeout(() => client.emit("end"), 100);
  try {
    const ending = drained.end();
    await assert.rejects(ending, expected);
    client.emit("end");
    await assert.rejects(drained.pool.end(), expected);
    await assert.rejects(drained.end(), expected);
    await assert.rejects(new Promise<void>((resolve, reject) => {
      drained.pool.end((error?: Error) => error ? reject(error) : resolve());
    }), expected);
    assert.equal(drained.pool.end(), ending, "failure stays visible on retry");
  } finally {
    clearTimeout(release);
    client.emit("end");
  }
});

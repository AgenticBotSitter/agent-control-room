import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import type { PoolClient } from "pg";
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

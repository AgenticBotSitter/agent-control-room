import assert from "node:assert/strict";
import test from "node:test";
import { managedNativeSessionFixture, currentSignal } from "./helpers/managed-native-session";
import type { DatabaseSession } from "../src/persistence/database";

test("cancellation or replacement at replay precommit rolls back written authentication rows without sending", async t => {
  for (const mode of ["cancel", "replace"] as const) await t.test(mode, async t => {
    const x = await managedNativeSessionFixture(); t.after(x.close);
    const c = await x.attach(), before = await x.protocol(), abort = new AbortController();
    const nextPeer = mode === "replace" ? x.makePeer() : undefined;
    let replacement: ReturnType<typeof x.manager.attach> | undefined;
    let connectionsWritten = false, replayWritten = false, injected = false;
    const transaction = x.authDb.transactionWithPreCommitCheck.bind(x.authDb);
    x.authDb.transactionWithPreCommitCheck = (work, check) => transaction(async tx => {
      const wrapped: DatabaseSession = { async query<T>(sql: string, params?: unknown[]) {
        const value = await tx.query<T>(sql, params);
        if (sql.includes("INSERT INTO node_protocol_connections")) connectionsWritten = true;
        if (sql.includes("INSERT INTO node_protocol_replay")) replayWritten = true;
        return value;
      } };
      return work(wrapped);
    }, () => {
      if (replayWritten && !injected) {
        injected = true;
        if (mode === "cancel") abort.abort();
        else replacement = x.manager.attach(x.registration.nodeId, nextPeer!.transport);
      }
      return check();
    });
    await assert.rejects(c.handle.hello(c.hello, abort.signal));
    assert.equal(connectionsWritten, true); assert.equal(replayWritten, true); assert.equal(injected, true);
    assert.deepEqual(await x.protocol(), before);
    assert.equal(c.peer.state.sends, 0); assert.equal(c.peer.state.closes, 1);
    assert.equal(c.peer.outgoing.length, 0); assert.equal((await x.counts()).runs.length, 0);
    if (replacement) {
      const handle = await replacement;
      assert.equal(nextPeer!.state.sends, 0);
      await assert.rejects(async () => c.handle.reconcile("{}", currentSignal()));
      await handle.close(); assert.equal(nextPeer!.state.closes, 1);
    }
  });
});

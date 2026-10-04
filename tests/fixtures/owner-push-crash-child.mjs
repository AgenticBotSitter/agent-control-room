// A dispatcher that is SIGKILLed at one chosen database boundary, for the
// owner-push crash lanes (R6C-04, R6C-05).
//
// It runs the REAL dispatcher, the REAL store and the REAL claim SQL against a
// real PostgreSQL cluster, as the production owner-web login, and stops exactly
// where the lane under test needs it stopped:
//
//   claim_committed   after the claim transaction has COMMITTED and before the
//                     claimed rows are returned, so no send is ever attempted.
//                     This is the boundary that strands a head at its final
//                     attempt.
//   provider_accepted after the push provider has durably recorded the event
//                     tag and before the 0174 ledger records the delivery, so
//                     the acceptance is real and the local record is not.
//
// Both boundaries end in a promise that never resolves, so the process parks
// rather than finishing: the parent SIGKILLs it, and nothing but the parent
// decides when. Every readiness signal goes to stdout as one bare token the
// parent waits for, and the process holds no timer that could end it early.
//
// Environment: CONTROL_ROOM_PUSH_CRASH_CONNECTION (JSON connection options),
// CONTROL_ROOM_PUSH_CRASH_TENANT, CONTROL_ROOM_PUSH_CRASH_MODE, and for
// provider_accepted CONTROL_ROOM_PUSH_CRASH_TAG_LOG (a durable file outside
// this process that every accepted tag is appended to).
import { appendFile } from "node:fs/promises";
import { Client } from "pg";
import { OwnerPushDispatcherV1 } from "../../src/web-push/v1/dispatcher.ts";
import { PostgresOwnerPushStoreV1 } from "../../src/web-push/v1/postgres-store.ts";

const options = JSON.parse(process.env.CONTROL_ROOM_PUSH_CRASH_CONNECTION);
const tenantId = process.env.CONTROL_ROOM_PUSH_CRASH_TENANT;
const mode = process.env.CONTROL_ROOM_PUSH_CRASH_MODE;
const tagLog = process.env.CONTROL_ROOM_PUSH_CRASH_TAG_LOG;
if (!options || !tenantId || (mode !== "claim_committed" && mode !== "provider_accepted"))
  throw new Error("owner_push_crash_child_input_invalid");
if (mode === "provider_accepted" && !tagLog) throw new Error("owner_push_crash_child_tag_log_required");

const signal = (token) => { process.stdout.write(`${token}\n`); };
// Never resolves. The child is stopped by a signal, never by its own logic.
//
// A pending timer is what holds the process open across that park: with nothing
// left on the event loop Node treats the top-level await as abandoned and exits
// with code 13 ("unsettled top-level await"), which would look to the parent
// like a child that died on its own rather than one that was killed.
const parked = new Promise(() => { setInterval(() => {}, 60_000); });

const oneShot = async (statement, params = []) => {
  const connection = new Client(options);
  await connection.connect();
  try {
    await connection.query("SET search_path=pg_catalog, public");
    return { rows: (await connection.query(statement, params)).rows };
  } finally { await connection.end(); }
};

const db = {
  query: oneShot,
  async transaction(callback) {
    const connection = new Client(options);
    await connection.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SET search_path=pg_catalog, public");
      const tx = { async query(statement, params = []) {
        return { rows: (await connection.query(statement, params)).rows };
      } };
      const value = await callback(tx);
      await connection.query("COMMIT");
      // The claim really is committed here. The boundary sits OUTSIDE the
      // transaction, so what the parent observes afterwards is a reservation
      // that outlived its dispatcher rather than one that was never committed.
      if (mode === "claim_committed") { signal("CLAIM_COMMITTED"); await parked; }
      return value;
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { await connection.end(); }
  },
  async transactionWithPreCommitCheck(callback) { return await this.transaction(callback); },
};

const channel = { kind: "web-push", async send(_subscription, payload) {
  // Durably, outside this process: the parent's count of acceptances has to
  // survive the kill, or the duplicate it is looking for would be invisible.
  await appendFile(tagLog, `${payload.tag}\n`, "utf8");
  if (mode === "provider_accepted") { signal("PROVIDER_ACCEPTED"); await parked; }
  return { statusCode: 201 };
} };

const dispatcher = new OwnerPushDispatcherV1({ db, tenantId,
  store: new PostgresOwnerPushStoreV1(db), channel });
signal(`DISPATCH_DONE:${JSON.stringify(await dispatcher.dispatch())}`);
await parked;
// Run package-5 denial probes only against the exact disposable PG17 cluster
// created by `mac:rehearsal up`. Each injected fault is restored afterward.
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { connectTarget } from "../../../deploy/postgres/evidence.mjs";
import { createPrivatePostgresDatabase } from "../../../src/web/v1/private-postgres";
import { verifyNativeQueueWorkerDatabase } from "../../../src/web/v1/private-database-preflight";

const [rootArg] = process.argv.slice(2);
if (!rootArg || !isAbsolute(rootArg) || process.argv.length !== 3) {
  process.stderr.write("usage: node --import tsx scripts/mac-local/rehearsal/negative-probes.ts ABSOLUTE_REHEARSAL_DIR\n");
  process.exit(2);
}
const root = resolve(rootArg);
const config = JSON.parse(await readFile(join(root, "protected/config/mac-local.json"), "utf8"));
const roleMap = JSON.parse(await readFile(join(root, "protected/config/database-roles.json"), "utf8"));
const workerConfig = roleMap?.queueWorker;
if (config?.database?.host !== "127.0.0.1" || config.database.database !== "control_room"
  || config.database.majorVersion !== 17 || !Number.isInteger(config.database.port)
  || workerConfig?.username !== "control_room_queue_worker" || workerConfig.host !== "127.0.0.1"
  || workerConfig.port !== config.database.port || workerConfig.database !== "control_room")
  throw new Error("rehearsal_database_scope_refused");

const target = `host=127.0.0.1 port=${config.database.port} dbname=control_room user=postgres`;
const admin = connectTarget(target);
await admin.connect();
try {
  const identity = (await admin.query<{ data_directory: string; version_num: number }>(
    "SELECT current_setting('data_directory') AS data_directory, current_setting('server_version_num')::int AS version_num")).rows[0];
  if (resolve(identity?.data_directory ?? "") !== resolve(root, "pg") || Math.floor((identity?.version_num ?? 0) / 10_000) !== 17)
    throw new Error("rehearsal_database_scope_refused");
} finally { await admin.end(); }

const workerPreflightPasses = async () => {
  const database = createPrivatePostgresDatabase(workerConfig);
  try {
    await verifyNativeQueueWorkerDatabase(database.client, workerConfig);
    return true;
  } catch { return false; }
  finally { await database.close(); }
};
if (!await workerPreflightPasses()) throw new Error("rehearsal_probe_baseline_unexpected_result");

const broadMembership = connectTarget(target);
await broadMembership.connect();
try {
  await broadMembership.query("GRANT control_room_application TO control_room_queue_worker");
  if (await workerPreflightPasses()) throw new Error("rehearsal_probe_extra_application_membership_not_refused");
} finally {
  await broadMembership.query("REVOKE control_room_application FROM control_room_queue_worker");
  await broadMembership.end();
}
if (!await workerPreflightPasses()) throw new Error("rehearsal_probe_membership_restore_unexpected_result");

const missingQueueGrant = connectTarget(target);
await missingQueueGrant.connect();
try {
  await missingQueueGrant.query("REVOKE SELECT ON control_room_queue.queue FROM control_room_native_queue_worker");
  if (await workerPreflightPasses()) throw new Error("rehearsal_probe_missing_queue_select_not_refused");
} finally {
  await missingQueueGrant.query("GRANT SELECT ON control_room_queue.queue TO control_room_native_queue_worker");
  await missingQueueGrant.end();
}
if (!await workerPreflightPasses()) throw new Error("rehearsal_probe_queue_grant_restore_unexpected_result");
process.stdout.write("PG17 queue-worker preflight and both least-privilege negative probes: PASS\n");

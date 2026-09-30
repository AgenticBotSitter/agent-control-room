// Why does delivery fail on this load-test install? Reads the coordinator's own
// state for the most recently failed queue job, through the coordinator login.
//
//   node --import tsx scripts/load/site-load-why.mts ROOT_DIR
//
// This is diagnostic only: it reads, it prints, it decides nothing. A failed
// queue row records just "native_task_delivery_unresolved", so the interesting
// question is which precondition the delivery locator rejected. It walks the same
// conditions `locateApproved*QueueDelivery` checks, one query at a time, and
// prints which one is false. No product code is called: this is the source of the
// refusal, not a reimplementation of it.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";

const root = process.argv[2];
if (!root) throw new Error("usage: site-load-why.mts ABSOLUTE_DIR");
const dbPort = 59610;

const admin = new Client({ host: "127.0.0.1", port: dbPort, database: "control_room", user: "postgres" });
await admin.connect();
const failed = (await admin.query(
  "SELECT data FROM control_room_queue.job WHERE state='failed' ORDER BY created_on DESC LIMIT 1")).rows[0];
if (!failed) { console.log("no failed queue job"); process.exit(0); }
const ref = failed.data;
await admin.end();

const roles = JSON.parse(await readFile(join(root, "protected/config/database-roles.json"), "utf8"));
const coordinator = new Client({ host: "127.0.0.1", port: dbPort, database: "control_room",
  user: roles.coordinator.username, password: roles.coordinator.password });
await coordinator.connect();
const tenant = ref.tenantId;
const show = async (label: string, sql: string, values: unknown[]): Promise<void> => {
  try { const rows = (await coordinator.query(sql, values)).rows; console.log(label.padEnd(34), JSON.stringify(rows)); }
  catch (error) {
    const failure = error as { code?: string; message?: string };
    console.log(label.padEnd(34), `QUERY FAILED ${failure.code}: ${(failure.message ?? "").slice(0, 120)}`);
  }
};

console.log(`failed queue job for ${ref.jobId} (attempt ${ref.attemptId})\n`);
await show("job", "SELECT state, payload->>'jobType' AS job_type FROM control_jobs WHERE tenant_id=$1 AND id=$2",
  [tenant, ref.jobId]);
await show("attempt", "SELECT state, node_id, worker_id FROM control_attempts WHERE tenant_id=$1 AND job_id=$2",
  [tenant, ref.jobId]);
await show("lease (newest)", `SELECT state, expires_at > now() AS fresh FROM control_leases
  WHERE tenant_id=$1 AND job_id=$2 ORDER BY acquired_at DESC LIMIT 1`, [tenant, ref.jobId]);
await show("plan schema", "SELECT plan->>'schema' AS schema FROM control_task_execution_plans WHERE tenant_id=$1 AND job_id=$2",
  [tenant, ref.jobId]);
await show("approval packets", "SELECT count(*) FROM control_native_approval_packets WHERE tenant_id=$1 AND job_id=$2",
  [tenant, ref.jobId]);
// The queue intent is the locator's other required precondition: it must exist
// and its packetDigest must match the one the locator recomputes. A missing
// intent is what makes a job undeliverable with every other fact in order.
await show("queue intent", "SELECT count(*) FROM control_native_task_queue WHERE tenant_id=$1 AND job_id=$2",
  [tenant, ref.jobId]);
await show("delivery preparations", "SELECT count(*) FROM control_native_delivery_preparations WHERE tenant_id=$1 AND job_id=$2",
  [tenant, ref.jobId]);
await show("delivery envelopes", "SELECT count(*) FROM control_native_delivery_envelopes WHERE tenant_id=$1 AND job_id=$2",
  [tenant, ref.jobId]);
await show("transmission intents", "SELECT count(*) FROM control_native_transmission_intents WHERE tenant_id=$1 AND job_id=$2",
  [tenant, ref.jobId]);
await show("transmission receipts", "SELECT count(*) FROM control_native_delivery_receipts WHERE tenant_id=$1 AND job_id=$2",
  [tenant, ref.jobId]);
await show("hermes approval", "SELECT count(*) FROM control_native_approval_packets WHERE tenant_id=$1 AND job_id=$2",
  [tenant, ref.jobId]);
await show("operations mode", "SELECT mode, reason FROM installation_operations_mode_revisions WHERE tenant_id=$1 ORDER BY revision DESC LIMIT 1",
  [tenant]);
await show("node state", "SELECT id, state FROM control_nodes WHERE tenant_id=$1 AND id = ANY($2::text[])",
  [tenant, ["mac-1.hermes", "mac-1.claude", "mac-1.codex"]]);
await show("node signals (freshest)", `SELECT node_id, signal_kind, expires_at > now() AS fresh
  FROM control_node_fleet_signals WHERE tenant_id=$1 AND signal_kind = ANY($2::text[])
  ORDER BY node_id, signal_kind, signal_sequence DESC LIMIT 9`,
  [tenant, ["telemetry", "capability"]]);
await show("project lifecycle", `SELECT h.lifecycle FROM control_manual_project_heads h
  WHERE h.tenant_id=$1 AND h.project_id=$2`, [tenant, ref.projectId]);
await show("effects", "SELECT count(*) FROM control_effect_intents WHERE tenant_id=$1 AND job_id=$2",
  [tenant, ref.jobId]);
await coordinator.end();

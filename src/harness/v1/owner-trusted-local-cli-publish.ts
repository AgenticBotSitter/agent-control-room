import { z } from "zod";
import type { DatabaseClient } from "../../persistence/database";
import { HarnessRunStoreV1 } from "./store";
import type { HarnessRunV1 } from "./types";
import type { HarnessRunState } from "./types";
import { sha256Digest } from "../../security";
import { controllerWorkerDeliverySchemaV1, controllerWorkerDeliveryReceiptSchemaV1 } from "./controller-worker-delivery";
import { publishDurableResultV1, type DurableResultBindingV1,
  type DurableResultPublicationConfigurationV1 } from "../../artifacts/v1/durable-result-publication";

const unavailable = (): never => { throw new Error("owner_trusted_local_cli_publish_unavailable"); };
const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const text = z.string().min(1).refine(value => Buffer.byteLength(value, "utf8") <= 65_536);

export type OwnerTrustedLocalCliPublishConfigurationV1 = Readonly<{
  db: DatabaseClient;
  /** Key for the ordinary Control Room run history (`HarnessRunStoreV1`).
   * Distinct from `publication.integrityKey`, which authenticates the
   * durable result itself. */
  runIntegrityKey: Uint8Array;
  publication: DurableResultPublicationConfigurationV1;
  /** Builds the one ordinary run record for this delivery. Each agent
   * supplies its own (`codexOwnerTrustedLocalRunRegistrationV1`,
   * `hermesLocalRunRegistrationV1`, ...); this module stays agnostic of
   * which harness it is publishing for. */
  registerRun(deliveryValue: unknown, createdAt: string): HarnessRunV1;
}>;

/** `ControllerWorkerDeliveryV1` carries no `workflowId` — it lives on the
 * job record, not the delivery packet, so it must be re-read here rather
 * than trusted from a caller-supplied value. */
async function workflowIdForJob(db: DatabaseClient, tenantId: string, jobId: string): Promise<string> {
  return db.transaction(async tx => {
    const row = (await tx.query<{ workflow_id: string }>(
      "SELECT workflow_id FROM control_jobs WHERE tenant_id=$1 AND id=$2", [tenantId, jobId])).rows[0];
    if (!row) unavailable();
    return id.parse(row.workflow_id);
  });
}

/**
 * Builds the `publish({delivery, receipt, text, signal})` closure the
 * generic owner-trusted local CLI bridge (`owner-trusted-local-cli-delivery.ts`)
 * needs. It registers the ordinary run record (idempotent — a retry after a
 * crash between registration and durable publish simply replays the same
 * record, per `HarnessRunStoreV1.create`'s own replay handling) and then
 * writes the CLI's completed text through the existing durable result and
 * pending-review path. It creates no second store, review path, or result
 * format: `publishDurableResultV1` and its `reviewSubmission` are the same
 * ones the private/Claude local paths already use.
 */
export function createOwnerTrustedLocalCliLifecycleV1(config: OwnerTrustedLocalCliPublishConfigurationV1) {
  if (!config || !config.db || !(config.runIntegrityKey instanceof Uint8Array) || config.runIntegrityKey.length !== 32
    || !config.publication || typeof config.registerRun !== "function") unavailable();
  const runs = new HarnessRunStoreV1(config.db, config.runIntegrityKey);
  async function record(input: Readonly<{ delivery: unknown; receipt: unknown; signal: AbortSignal }>, terminal: "succeeded" | "failed") {
    if (!input || !(input.signal instanceof AbortSignal) || input.signal.aborted) unavailable();
    const delivery = controllerWorkerDeliverySchemaV1.parse(input.delivery);
    const receipt = controllerWorkerDeliveryReceiptSchemaV1.parse(input.receipt);
    if (receipt.deliveryId !== delivery.deliveryId || receipt.deliveryDigest !== delivery.deliveryDigest) unavailable();
    const run = config.registerRun(delivery, receipt.receivedAt);
    if (run.id !== delivery.identity.runId || run.tenantId !== delivery.identity.tenantId
      || run.projectId !== delivery.identity.projectId || run.jobId !== delivery.identity.jobId
      || run.attemptId !== delivery.identity.attemptId || run.nodeId !== delivery.identity.nodeId) unavailable();
    if (input.signal.aborted) unavailable();
    // `create` is deliberately strict about changed projections. Reconstruct the
    // registration from an authenticated existing run on a retry, rather than
    // attempting to register its already-terminal projection a second time.
    const existing = await runs.get(run.tenantId, run.id);
    if (!existing) await runs.create(run);
    else {
      const initial: HarnessRunV1 = { ...existing, state: "discovered", cancelState: run.cancelState,
        updatedAt: existing.createdAt, lastObservedAt: existing.createdAt };
      delete initial.startedAt; delete initial.finishedAt; delete initial.safeReasonCode;
      if (sha256Digest(initial) !== sha256Digest(run)) unavailable();
    }
    for (const state of (terminal === "succeeded" ? ["starting", "running", "succeeded"] : ["failed"]) as HarnessRunState[]) {
      if (input.signal.aborted) unavailable();
      const snapshot = await runs.inspect(run.tenantId, run.id);
      if (!snapshot) unavailable();
      const prior = snapshot.events.find(event => event.payload.category === "lifecycle" && event.payload.state === state);
      if (prior) continue;
      if (snapshot.run.state === terminal) unavailable();
      const occurredAt = new Date(Math.max(Date.now(), Date.parse(snapshot.run.lastObservedAt))).toISOString();
      await runs.append({ schemaVersion: "control-room-harness-event/v1", tenantId: run.tenantId, runId: run.id,
        sequence: snapshot.events.length + 1, occurredAt, source: "adapter",
        sourceEventKeyDigest: sha256Digest({ runId: run.id, localCliOutcome: state }),
        payload: { category: "lifecycle", state,
          ...(state === "failed" ? { reasonCode: "local_cli_execution_failed" } : {}) } });
    }
    const current = await runs.get(run.tenantId, run.id);
    if (current?.state !== terminal) unavailable();
    return { delivery, receipt, run };
  }
  async function publish(input: Readonly<{ delivery: unknown; receipt: unknown; text: string; signal: AbortSignal }>): Promise<void> {
    const body = text.parse(input.text);
    const { delivery, receipt, run } = await record(input, "succeeded");

    const workflowId = await workflowIdForJob(config.db, delivery.identity.tenantId, delivery.identity.jobId);
    if (input.signal.aborted) unavailable();
    const binding: DurableResultBindingV1 = { tenantId: delivery.identity.tenantId, projectId: delivery.identity.projectId,
      jobId: delivery.identity.jobId, attemptId: delivery.identity.attemptId, runId: delivery.identity.runId,
      nodeId: delivery.identity.nodeId, workflowId, harness: run.harness, connectorProfileDigest: delivery.connectorProfileDigest,
      authorityDigest: delivery.authorityDigest, acceptanceProfileId: delivery.acceptanceProfileId,
      acceptanceProfileDigest: delivery.acceptanceProfileDigest };
    const bytes = new TextEncoder().encode(body);
    // A signal that aborts after this point no longer cancels anything: the
    // bridge has already committed to publishing this exact text, the same
    // way the reviewed durable publisher's own callers behave.
    await publishDurableResultV1(config.publication, { binding, bytes, receivedAt: receipt.receivedAt,
      assertAuthority: () => { if (input.signal.aborted) unavailable(); } });
  };
  return Object.freeze({ publish, recordFailure: (input: Readonly<{ delivery: unknown; receipt: unknown; signal: AbortSignal }>) => record(input, "failed").then(() => {}) });
}

export function createOwnerTrustedLocalCliPublishV1(config: OwnerTrustedLocalCliPublishConfigurationV1) {
  return createOwnerTrustedLocalCliLifecycleV1(config).publish;
}

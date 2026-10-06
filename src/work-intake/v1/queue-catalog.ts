import { z } from "zod";
import type { OwnerTrustedLocalModelPolicyV1 } from "../../harness/v1/owner-trusted-local-enablements";
import { captureTaskModelCatalogV1, resolveTaskModelV1, type ResolvedTaskModelV1,
  type TaskModelWorkerKindV1 } from "../../web/v1/task-model-selection";

import { modelIdentifierSchemaV1 } from "../../domain/v1/model-identifier";

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export const workBatchQueueModelIdSchemaV1 = modelIdentifierSchemaV1;
const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const modelPolicy = z.union([
  z.object({ models: z.array(workBatchQueueModelIdSchemaV1).min(1).max(32), defaultModel: workBatchQueueModelIdSchemaV1,
    efforts: z.array(effort).min(1).max(5), defaultEffort: effort,
    limitedModels: z.array(workBatchQueueModelIdSchemaV1).max(32).optional() }).strict(),
  z.object({ profiles: z.array(z.object({ name: workBatchQueueModelIdSchemaV1,
    provider: workBatchQueueModelIdSchemaV1, model: workBatchQueueModelIdSchemaV1 }).strict()).min(1).max(32),
    defaultProfile: workBatchQueueModelIdSchemaV1,
    efforts: z.tuple([z.literal("default")]), defaultEffort: z.literal("default") }).strict(),
]);
export type WorkBatchQueueWorkerV1 = Readonly<{ workerId: string; workerKind: TaskModelWorkerKindV1;
  nodeId: string; modelPolicy?: OwnerTrustedLocalModelPolicyV1 }>;
export type WorkBatchQueueCatalogV1 = readonly WorkBatchQueueWorkerV1[];
export type WorkBatchQueueSelectionV1 = Readonly<{ workerId: string; workerKind: TaskModelWorkerKindV1;
  nodeId: string; selectionKey: string; model: string; effort: string; provider: string | null; profile: string | null }>;
export type WorkBatchQueueSelectionAuthorityV1 = Readonly<{
  assertCurrent(selection: WorkBatchQueueSelectionV1): boolean;
}>;

export function captureWorkBatchQueueCatalogV1(value: readonly WorkBatchQueueWorkerV1[]): WorkBatchQueueCatalogV1 {
  const workers = z.array(z.object({ workerId: id, workerKind: z.enum(["codex", "claude-code", "hermes"]),
    nodeId: id, modelPolicy: modelPolicy.optional() }).strict()).max(64).parse(value).map(worker => {
      const policy = worker.modelPolicy ? Object.freeze("profiles" in worker.modelPolicy
        ? { ...worker.modelPolicy, profiles: Object.freeze(worker.modelPolicy.profiles.map(profile => Object.freeze({ ...profile }))),
          efforts: Object.freeze([...worker.modelPolicy.efforts]) }
        : { ...worker.modelPolicy, models: Object.freeze([...worker.modelPolicy.models]),
          efforts: Object.freeze([...worker.modelPolicy.efforts]),
          ...(worker.modelPolicy.limitedModels
            ? { limitedModels: Object.freeze([...worker.modelPolicy.limitedModels]) } : {}) }) : undefined;
      return Object.freeze({ workerId: worker.workerId, workerKind: worker.workerKind, nodeId: worker.nodeId,
        ...(policy ? { modelPolicy: policy } : {}) }) as WorkBatchQueueWorkerV1;
    });
  if (new Set(workers.map(worker => worker.workerId)).size !== workers.length
    || new Set(workers.map(worker => worker.nodeId)).size !== workers.length) throw new Error("work_batch_queue_catalog_invalid");
  for (const worker of workers) {
    if (!worker.modelPolicy) continue;
    const policy = worker.modelPolicy;
    if ("profiles" in policy) {
      if (worker.workerKind !== "hermes" || !policy.profiles.some(profile => profile.name === policy.defaultProfile)
        || new Set(policy.profiles.map(profile => profile.name)).size !== policy.profiles.length)
        throw new Error("work_batch_queue_catalog_invalid");
    } else if (worker.workerKind === "hermes" || !policy.models.includes(policy.defaultModel)
      || !policy.efforts.includes(policy.defaultEffort)
      || new Set(policy.models).size !== policy.models.length || new Set(policy.efforts).size !== policy.efforts.length
      || policy.limitedModels?.some(model => !policy.models.includes(model))) {
      throw new Error("work_batch_queue_catalog_invalid");
    }
  }
  return Object.freeze(workers);
}

export function resolveWorkBatchQueueWorkerV1(catalog: WorkBatchQueueCatalogV1,
  requested: { requestedWorkerId?: string; requestedWorkerKind?: string; requestedModelKey?: string;
    requestedEffort?: string }):
  Readonly<{ worker: WorkBatchQueueWorkerV1; model: ResolvedTaskModelV1 }> | undefined {
  // A role-only preference is not an assignee. Keep it visible for owner
  // follow-up, but do not allocate a queue position until an exact registered
  // worker id is present.
  if (!requested.requestedWorkerId) return undefined;
  const candidates = catalog.filter(worker => (!requested.requestedWorkerId || worker.workerId === requested.requestedWorkerId)
    && (!requested.requestedWorkerKind || worker.workerKind === requested.requestedWorkerKind));
  if (candidates.length !== 1) throw new Error("work_batch_queue_worker_unavailable");
  const worker = candidates[0]!;
  if (!worker.modelPolicy) throw new Error("work_batch_queue_model_unavailable");
  const models = captureTaskModelCatalogV1([{ kind: worker.workerKind, policy: worker.modelPolicy }]);
  return Object.freeze({ worker, model: resolveTaskModelV1(models, worker.workerKind,
    { ...(requested.requestedModelKey ? { model: requested.requestedModelKey } : {}),
      ...(requested.requestedEffort ? { effort: requested.requestedEffort } : {}) }) });
}

/** One host-generation validator shared by owner admission and the later
 * coordinator start check. It snapshots the protected catalog and consults
 * only the matching readiness record; construction starts no worker or queue. */
export function createWorkBatchQueueSelectionAuthorityV1(catalogValue: WorkBatchQueueCatalogV1,
  readiness: Readonly<{ isReady(workerId: string): boolean }>): WorkBatchQueueSelectionAuthorityV1 {
  const catalog = captureWorkBatchQueueCatalogV1(catalogValue);
  if (!readiness || typeof readiness.isReady !== "function") throw new Error("work_batch_queue_authority_invalid");
  const isReady = readiness.isReady.bind(readiness);
  return Object.freeze({ assertCurrent(selection: WorkBatchQueueSelectionV1): boolean {
    try {
      if (!isReady(selection.workerId)) return false;
      const resolved = resolveWorkBatchQueueWorkerV1(catalog, { requestedWorkerId: selection.workerId,
        requestedWorkerKind: selection.workerKind, requestedModelKey: selection.selectionKey });
      if (!resolved?.worker.modelPolicy) return false;
      const exactModel = resolveTaskModelV1(captureTaskModelCatalogV1([{
        kind: resolved.worker.workerKind, policy: resolved.worker.modelPolicy }]), resolved.worker.workerKind,
      { model: selection.selectionKey, effort: selection.effort });
      return Boolean(resolved.worker.workerId === selection.workerId
        && resolved.worker.workerKind === selection.workerKind && resolved.worker.nodeId === selection.nodeId
        && exactModel.selectionKey === selection.selectionKey && exactModel.model === selection.model
        && exactModel.effort === selection.effort && (exactModel.provider ?? null) === selection.provider
        && (exactModel.profile ?? null) === selection.profile);
    } catch { return false; }
  } });
}

import type { OwnerTrustedLocalModelPolicyV1, OwnerTrustedLocalWorkerKindV1 } from "../../harness/v1/owner-trusted-local-enablements";

export type TaskModelWorkerKindV1 = "codex" | "claude-code" | "hermes";
export type TaskModelCatalogV1 = readonly Readonly<{
  kind: TaskModelWorkerKindV1;
  policy: OwnerTrustedLocalModelPolicyV1;
}>[];
export type RequestedTaskModelV1 = Readonly<{ model?: string; effort?: string }>;
export type ResolvedTaskModelV1 = Readonly<{
  workerKind: TaskModelWorkerKindV1;
  selectionKey: string;
  model: string;
  effort: string;
  provider?: string;
  profile?: string;
  usesMoreClaudeLimit: boolean;
}>;

function fail(): never { throw new Error("task_model_selection_refused"); }

export function captureTaskModelCatalogV1(value: readonly Readonly<{
  kind: OwnerTrustedLocalWorkerKindV1; policy?: OwnerTrustedLocalModelPolicyV1;
}>[]): TaskModelCatalogV1 {
  const eligible = value.filter(item => item.kind !== "hermes-021");
  if (eligible.some(item => !["codex", "claude-code", "hermes"].includes(item.kind))
    || new Set(eligible.map(item => item.kind)).size !== eligible.length) fail();
  const items = eligible.filter(item => item.policy !== undefined).map(item => Object.freeze({
    kind: item.kind as TaskModelWorkerKindV1, policy: item.policy!,
  }));
  return Object.freeze(items);
}

export function resolveTaskModelV1(catalog: TaskModelCatalogV1, kind: TaskModelWorkerKindV1,
  requested: RequestedTaskModelV1): ResolvedTaskModelV1 {
  const item = catalog.find(value => value.kind === kind); if (!item) fail();
  const policy = item.policy;
  if ("profiles" in policy) {
    if (kind !== "hermes" || requested.effort !== undefined && requested.effort !== "default") fail();
    const key = requested.model ?? policy.defaultProfile;
    const profile = policy.profiles.find(value => value.name === key); if (!profile) fail();
    return Object.freeze({ workerKind: kind, selectionKey: key, model: profile.model,
      effort: "default", provider: profile.provider, profile: profile.name, usesMoreClaudeLimit: false });
  }
  if (kind === "hermes") fail();
  const model = requested.model ?? policy.defaultModel;
  const effort = requested.effort ?? policy.defaultEffort;
  if (!policy.models.includes(model) || !policy.efforts.some(value => value === effort)) fail();
  return Object.freeze({ workerKind: kind, selectionKey: model, model, effort,
    usesMoreClaudeLimit: kind === "claude-code" && (policy.limitedModels?.includes(model) ?? false) });
}

/** A draft has not selected its execution template yet. Refuse free text unless
 * at least one protected worker policy can resolve the exact supplied pair;
 * planning rechecks against the worker the owner actually selects. */
export function validateRequestedTaskModelV1(catalog: TaskModelCatalogV1,
  requested: RequestedTaskModelV1): void {
  if (requested.model === undefined && requested.effort === undefined) return;
  if (!catalog.some(item => { try { resolveTaskModelV1(catalog, item.kind, requested); return true; } catch { return false; } })) fail();
}

/** Revisions begin from the exact resolved source choice. Only fields present
 * in the new owner request replace it; omission can never silently select a
 * newer worker default. */
export function inheritTaskModelRequestV1(source: RequestedTaskModelV1,
  override: RequestedTaskModelV1): RequestedTaskModelV1 {
  return Object.freeze({ model: override.model ?? source.model, effort: override.effort ?? source.effort });
}

export function taskModelOptionsV1(catalog: TaskModelCatalogV1) {
  return catalog.map(item => {
    const policy = item.policy;
    return "profiles" in policy ? {
      workerKind: item.kind, choices: policy.profiles.map(profile => ({ key: profile.name,
        label: `${profile.name} (${profile.provider})`, model: profile.model, efforts: ["default" as const], limited: false })),
      defaultModel: policy.defaultProfile, defaultEffort: "default" as const,
    } : {
      workerKind: item.kind, choices: policy.models.map(model => ({ key: model, label: model, model,
        efforts: [...policy.efforts], limited: item.kind === "claude-code" && (policy.limitedModels?.includes(model) ?? false) })),
      defaultModel: policy.defaultModel, defaultEffort: policy.defaultEffort,
    };
  });
}

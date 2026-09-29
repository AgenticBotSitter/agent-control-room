import type { DatabaseClient } from "../../persistence/database";
import { resolveTaskModelV1, type ResolvedTaskModelV1, type TaskModelCatalogV1,
  type TaskModelWorkerKindV1 } from "./task-model-selection";

/** The only path from a stored `control_task_model_selections` row to an
 * executor argument list. The browser only ever supplies a key; the stored row
 * is re-resolved against the protected catalog here, so a row for another
 * worker, a row whose value no longer matches the catalog, and a row that is
 * missing or not yet materialized all refuse before any CLI is invoked. */
export type MacLocalSelectedTaskModelV1 = (kind: TaskModelWorkerKindV1, jobId: string) => Promise<ResolvedTaskModelV1>;

const unavailable = (): never => { throw new Error("mac_local_task_model_selection_unavailable"); };

export function createMacLocalSelectedTaskModelV1(input: Readonly<{ read: DatabaseClient;
  tenantId: string; catalog: TaskModelCatalogV1 }>): MacLocalSelectedTaskModelV1 {
  if (!input || typeof input.tenantId !== "string" || input.tenantId.length === 0
    || !input.read || typeof input.read.query !== "function" || !Array.isArray(input.catalog)) unavailable();
  const { read, tenantId, catalog } = input;
  return async (kind, jobId) => {
    if (typeof jobId !== "string" || jobId.length === 0) unavailable();
    const row = (await read.query<{ selection_key: string; model: string; effort: string;
      provider: string | null; profile: string | null; worker_kind: string }>(`SELECT selection_key,model,effort,provider,profile,worker_kind
        FROM control_task_model_selections WHERE tenant_id=$1 AND job_id=$2`, [tenantId, jobId])).rows[0];
    if (!row || row.worker_kind !== kind) unavailable();
    // The catalog's own refusal names a different error. Normalize it, so an
    // unusable row reads as the same refusal whether it was absent, foreign, or
    // no longer confirmed, and a caller cannot tell which check fired.
    let verified: ResolvedTaskModelV1;
    try { verified = resolveTaskModelV1(catalog, kind, { model: row.selection_key, effort: row.effort }); }
    catch { return unavailable(); }
    if (verified.model !== row.model || (verified.provider ?? null) !== row.provider || (verified.profile ?? null) !== row.profile)
      unavailable();
    return verified;
  };
}

/** The exact per-worker projections the three executors consume. Keeping them
 * beside the selection function means a test can drive the real stored-row to
 * real-argv path instead of a hand-copied stub. */
export function macLocalCodexModelSelectionV1(selected: MacLocalSelectedTaskModelV1) {
  return async (jobId: string) => { const value = await selected("codex", jobId);
    return { model: value.model, effort: value.effort }; };
}

export function macLocalClaudeModelSelectionV1(selected: MacLocalSelectedTaskModelV1) {
  return async (jobId: string) => { const value = await selected("claude-code", jobId);
    return { model: value.model, effort: value.effort, supportsEffort: true }; };
}

export function macLocalHermesModelSelectionV1(selected: MacLocalSelectedTaskModelV1) {
  return async (jobId: string): Promise<{ profile: string; provider: string; model: string }> => {
    const value = await selected("hermes", jobId);
    // A Hermes worker is selected by a named profile, so a resolved value with
    // no profile or provider is not a degraded case to paper over. Refuse rather
    // than invent one: a substituted profile runs a different local agent.
    const { profile, provider, model } = value;
    if (typeof profile !== "string" || typeof provider !== "string") return unavailable();
    return { profile, provider, model }; };
}

/** The one mapping from a Mac-local worker to the projection that worker
 * consumes. It is a function rather than three call sites so that "the Claude
 * worker gets the Claude projection" is a claim a test can falsify.
 *
 * The three result shapes are deliberately different, and the overloads below
 * pin each worker to its own shape. Swapping two workers therefore fails to
 * type-check rather than silently running a different model: the Claude
 * projection carries `supportsEffort`, the Hermes one carries a profile and a
 * provider, and the Codex one carries neither. */
export function macLocalWorkerModelSelectionV1(kind: "codex",
  selected: MacLocalSelectedTaskModelV1): (jobId: string) => Promise<{ model: string; effort: string }>;
export function macLocalWorkerModelSelectionV1(kind: "claude-code",
  selected: MacLocalSelectedTaskModelV1): (jobId: string) => Promise<{ model: string; effort: string; supportsEffort: true }>;
export function macLocalWorkerModelSelectionV1(kind: "hermes",
  selected: MacLocalSelectedTaskModelV1): (jobId: string) => Promise<{ profile: string; provider: string; model: string }>;
export function macLocalWorkerModelSelectionV1(kind: TaskModelWorkerKindV1,
  selected: MacLocalSelectedTaskModelV1): (jobId: string) => Promise<never> {
  if (kind === "codex") return macLocalCodexModelSelectionV1(selected) as never;
  if (kind === "claude-code") return macLocalClaudeModelSelectionV1(selected) as never;
  if (kind === "hermes") return macLocalHermesModelSelectionV1(selected) as never;
  return unavailable();
}

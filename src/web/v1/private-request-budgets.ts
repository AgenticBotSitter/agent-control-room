import { PROJECT_ORCHESTRATION_DESCRIPTION_LIMIT_V1 } from "./project-orchestration-wire";

// Bounded Node transport budgets. Larger route parsers share these constants
// so supported input cannot hit a smaller outer ceiling. Unknown routes keep
// the 8 KiB default. Passkeys retain their existing 20 KB inner parser budget.
export const privateRequestBudgets = Object.freeze({
  default: 8192,
  task: 32_768,
  recurring: 32_768,
  skill: 32_768,
  // Worst-case UTF-8 description plus the existing JSON envelope allowance.
  orchestration: PROJECT_ORCHESTRATION_DESCRIPTION_LIMIT_V1 * 4 + 64 * 1024,
  workBatch: 131_072,
  pipeline: 65_536,
  fleet: 16_384,
  improvement: 16_384,
  passkeyRegistration: 20_000,
});

export function privateRequestBodyLimit(path: string, method: string, local: boolean): number {
  if (method === "PUT") {
    if (/^\/api\/v1\/projects\/[^/]+\/recurring-rules\/[^/]+$/.test(path)) return privateRequestBudgets.recurring;
    if (/^\/api\/v1\/projects\/[^/]+\/skills\/[^/]+$/.test(path)) return privateRequestBudgets.skill;
  }
  if (method !== "POST") return privateRequestBudgets.default;
  if (/^\/api\/v1\/projects\/[^/]+\/tasks(?:\/|$)/.test(path)
    || local && path === "/api/v1/local-pilot/workspace") return privateRequestBudgets.task;
  if (/^\/api\/v1\/projects\/[^/]+\/recurring-rules(?:\/|$)/.test(path)) return privateRequestBudgets.recurring;
  if (/^\/api\/v1\/projects\/[^/]+\/skills(?:\/|$)/.test(path)) return privateRequestBudgets.skill;
  if (/^\/api\/v1\/projects\/[^/]+\/orchestration(?:-settings|-retry)?$/.test(path)
    || /^\/api\/v1\/projects\/[^/]+\/pipelines\/[^/]+\/suggestions\/[^/]+\/(?:use|dismiss)$/.test(path))
    return privateRequestBudgets.orchestration;
  if (/^\/api\/v1\/projects\/[^/]+\/pipelines(?:\/|$)/.test(path)) return privateRequestBudgets.workBatch;
  if (/^\/api\/v1\/projects\/[^/]+\/pipeline-(?:templates|runs)(?:\/|$)/.test(path)) return privateRequestBudgets.pipeline;
  if (/^\/api\/v1\/fleet\//.test(path)) return privateRequestBudgets.fleet;
  if (/^\/api\/v1\/projects\/[^/]+\/improvements$/.test(path)
    || /^\/api\/v1\/update-candidates\/[^/]+\/decision$/.test(path)) return privateRequestBudgets.improvement;
  if (local && (path === "/api/v1/passkeys/registration" || path === "/api/v1/passkeys/registration/options"))
    return privateRequestBudgets.passkeyRegistration;
  return privateRequestBudgets.default;
}

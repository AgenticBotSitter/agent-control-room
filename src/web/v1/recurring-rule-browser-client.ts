import { BrowserRequestError } from "./browser-client";

export type RecurringRuleViewV1 = Readonly<{ ruleId: string; projectId: string; state: "active" | "paused";
  schedule: string; cronExpression: string; timezone: string; task: Readonly<{ title: string; instructions: string;
    requiredCapability: string; acceptanceCriteria: string; acceptanceTests: string; skillRefs: readonly unknown[] }>;
  version: number; startsWork: false; grantsExecutionAuthority: false }>;
export type RecurringRulePageV1 = Readonly<{ projectId: string; rules: readonly RecurringRuleViewV1[];
  startsWork: false; grantsExecutionAuthority: false }>;

async function response<T>(request: Promise<Response>): Promise<T> {
  const value = await request;
  if (!value.ok) throw new BrowserRequestError(value.status === 401 ? "authentication_required"
    : value.status === 403 ? "access_denied" : value.status === 404 ? "not_found"
      : value.status === 409 ? "conflict" : value.status === 400 ? "invalid_request" : "unavailable");
  return value.json() as Promise<T>;
}

export function createRecurringRuleBrowserClientV1(transport: typeof fetch = fetch) {
  const base = (projectId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/recurring-rules`;
  const mutation = (method: string, url: string, body: unknown) => response<RecurringRuleViewV1>(transport(url, {
    method, redirect: "error", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  return Object.freeze({
    list: (projectId: string) => response<RecurringRulePageV1>(transport(base(projectId),
      { method: "GET", redirect: "error", cache: "no-store" })),
    create: (projectId: string, body: unknown) => mutation("POST", base(projectId), body),
    update: (projectId: string, ruleId: string, body: unknown) => mutation("PUT", `${base(projectId)}/${encodeURIComponent(ruleId)}`, body),
    pause: (projectId: string, ruleId: string, paused: boolean, expectedVersion: number) =>
      mutation("POST", `${base(projectId)}/${encodeURIComponent(ruleId)}/pause`, { paused, expectedVersion }),
  });
}

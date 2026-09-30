import { BrowserRequestError } from "./browser-client";

export type ReusableSkillViewV1 = Readonly<{ skillId: string; name: string; currentVersion: number;
  state: "active" | "retired"; instructions: string; contentDigest: string }>;
export type ReusableSkillPageV1 = Readonly<{ projectId: string; skills: readonly ReusableSkillViewV1[];
  startsWork: false; grantsExecutionAuthority: false }>;

async function response<T>(request: Promise<Response>): Promise<T> {
  const value = await request;
  if (!value.ok) throw new BrowserRequestError(value.status === 401 ? "authentication_required"
    : value.status === 403 ? "access_denied" : value.status === 404 ? "not_found"
      : value.status === 409 ? "conflict" : value.status === 400 ? "invalid_request" : "unavailable");
  return value.json() as Promise<T>;
}

export function createReusableSkillBrowserClientV1(transport: typeof fetch = fetch) {
  const base = (projectId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/skills`;
  return Object.freeze({
    list: (projectId: string) => response<ReusableSkillPageV1>(transport(base(projectId),
      { method: "GET", redirect: "error", cache: "no-store" })),
    create: (projectId: string, body: unknown) => response(transport(base(projectId), { method: "POST",
      redirect: "error", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })),
    update: (projectId: string, skillId: string, body: unknown) => response(transport(
      `${base(projectId)}/${encodeURIComponent(skillId)}`, { method: "PUT", redirect: "error", cache: "no-store",
        headers: { "content-type": "application/json" }, body: JSON.stringify(body) })),
  });
}

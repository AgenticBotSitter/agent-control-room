import { projectWorkspaceReadModelSchemaV1 } from "./schemas";
import type { ProjectWorkspaceReadModelV1 } from "./types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ProjectWorkspaceProtectedDataStateV1 =
  | { state: "loading" }
  | { state: "available"; model: ProjectWorkspaceReadModelV1 }
  | { state: "unavailable"; code: "authentication_required" | "project_read_forbidden" | "project_not_found" | "protected_source_unavailable" | "invalid_response" | "request_failed" };

const safeProjectId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("non-json protected project read");
}

async function browserDigestMatches(model: ProjectWorkspaceReadModelV1): Promise<boolean> {
  const { readDigest, ...material } = model;
  const bytes = new TextEncoder().encode(canonicalJson(material));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const actual = `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return actual === readDigest;
}

export async function fetchProjectWorkspaceReadModelV1(projectId: string, fetcher: FetchLike = fetch): Promise<ProjectWorkspaceProtectedDataStateV1> {
  if (!safeProjectId.test(projectId)) return { state: "unavailable", code: "invalid_response" };
  try {
    const response = await fetcher(`/api/v1/project-workspace/${encodeURIComponent(projectId)}`, { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) return { state: "unavailable", code: "authentication_required" };
    if (response.status === 403) return { state: "unavailable", code: "project_read_forbidden" };
    if (response.status === 404) return { state: "unavailable", code: "project_not_found" };
    if (!response.ok) return { state: "unavailable", code: "protected_source_unavailable" };
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype
      || Object.keys(body).length !== 1 || !Object.prototype.hasOwnProperty.call(body, "model")) {
      return { state: "unavailable", code: "invalid_response" };
    }
    try {
      const model = projectWorkspaceReadModelSchemaV1.parse((body as { model: unknown }).model) as ProjectWorkspaceReadModelV1;
      if (model.projectId !== projectId || !(await browserDigestMatches(model))) return { state: "unavailable", code: "invalid_response" };
      return { state: "available", model };
    } catch {
      return { state: "unavailable", code: "invalid_response" };
    }
  } catch {
    return { state: "unavailable", code: "request_failed" };
  }
}

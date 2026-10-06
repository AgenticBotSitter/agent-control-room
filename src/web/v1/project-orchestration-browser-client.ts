import { BrowserRequestError, type BrowserFailureCode } from "./browser-client";
import { readBrowserJson } from "./browser-json";
import { catalogProjectIdSchema } from "./project-wire";
import { projectOrchestrationDescribeResultSchemaV1, projectOrchestrationDescribeSchemaV1,
  projectOrchestrationRetrySchemaV1, projectOrchestrationSettingsDraftSchemaV1,
  projectOrchestrationSettingsSchemaV1, projectOrchestrationSuggestionPageSchemaV1,
  projectOrchestrationSuggestionPrefillSchemaV1 } from "./project-orchestration-wire";

const failure = (status: number): BrowserFailureCode => ({ 400: "invalid_request", 401: "authentication_required",
  403: "access_denied", 404: "not_found", 409: "conflict" } as Record<number, BrowserFailureCode>)[status] ?? "unavailable";

export const orchestrationErrorMessage: Record<BrowserFailureCode, string> = {
  authentication_required: "Sign in again to use the chief of staff.",
  access_denied: "Only this project’s owner can use or change the chief of staff.",
  invalid_request: "That description is too long or the chief-of-staff choice is not one of the offered options. Shorten it to under 16,000 characters, or choose a bot and model from the list.",
  conflict: "This project or batch changed elsewhere. Refresh before trying again.",
  not_found: "The chief-of-staff service is not connected for this project.",
  unavailable: "The chief-of-staff service could not be reached. No proposal or setting change is assumed.",
  uncertain: "The request may have reached the chief of staff. Retry only this exact request before changing it.",
};

export function createProjectOrchestrationBrowserClient(transport: typeof fetch = fetch,
  makeKey: () => string = () => `orchestrator:${crypto.randomUUID()}`) {
  let pendingDescription: { projectId: string; body: string; key: string } | undefined;
  async function call(path: string, method: "GET" | "POST", body?: string, key?: string) {
    try { return await transport(path, { method, credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(30_000), headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest",
        ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key ? { "idempotency-key": key } : {}) },
      ...(body === undefined ? {} : { body }) }); }
    catch { throw new BrowserRequestError(method === "POST" ? "uncertain" : "unavailable"); }
  }
  async function read(response: Response) {
    if (!response.ok) throw new BrowserRequestError(failure(response.status));
    try { return await readBrowserJson(response); } catch { throw new BrowserRequestError("unavailable"); }
  }
  async function commitDescription() {
    if (!pendingDescription) throw new BrowserRequestError("invalid_request");
    const current = pendingDescription;
    try {
      const result = projectOrchestrationDescribeResultSchemaV1.parse(await read(await call(
        `/api/v1/projects/${encodeURIComponent(current.projectId)}/orchestration`, "POST", current.body, current.key)));
      pendingDescription = undefined; return result;
    } catch (error) {
      if (!(error instanceof BrowserRequestError) || error.code !== "uncertain") pendingDescription = undefined;
      throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable");
    }
  }
  return Object.freeze({
    hasPendingDescription: () => !!pendingDescription,
    /** Release the retained request WITHOUT sending anything. The browser keeps no
     * authority either way: this only lets the owner start a NEW description after
     * a dropped response they do not want to retry. The original body and key are
     * discarded, so the next submit is a new request, not a second attempt at the
     * old one. */
    forgetPendingDescription: () => { pendingDescription = undefined; },
    async readSettings(projectId: string) {
      if (!catalogProjectIdSchema.safeParse(projectId).success) throw new BrowserRequestError("invalid_request");
      return projectOrchestrationSettingsSchemaV1.parse(await read(await call(
        `/api/v1/projects/${encodeURIComponent(projectId)}/orchestration-settings`, "GET")));
    },
    async saveSettings(projectId: string, draft: unknown) {
      if (!catalogProjectIdSchema.safeParse(projectId).success) throw new BrowserRequestError("invalid_request");
      const value = projectOrchestrationSettingsDraftSchemaV1.safeParse(draft);
      if (!value.success) throw new BrowserRequestError("invalid_request");
      return projectOrchestrationSettingsSchemaV1.parse(await read(await call(
        `/api/v1/projects/${encodeURIComponent(projectId)}/orchestration-settings`, "POST", JSON.stringify(value.data))));
    },
    async describe(projectId: string, description: string) {
      if (!catalogProjectIdSchema.safeParse(projectId).success) throw new BrowserRequestError("invalid_request");
      const value = projectOrchestrationDescribeSchemaV1.safeParse({ description });
      if (!value.success) throw new BrowserRequestError("invalid_request");
      const body = JSON.stringify(value.data);
      if (pendingDescription && (pendingDescription.projectId !== projectId || pendingDescription.body !== body))
        throw new BrowserRequestError("uncertain");
      pendingDescription ??= { projectId, body, key: makeKey() };
      return commitDescription();
    },
    retryDescription: commitDescription,
    /** Ask for one more run of a description that escalated.
     *
     * It sends the DESCRIPTION, not the retained request, because the grant is
     * keyed on (tenant, project, description) rather than on a request key -- and
     * that is the point: the browser mints a fresh key per press, so keying the
     * grant on one would make every press a different thing to retry. A new key is
     * minted for the call, because this is a different request from the describe it
     * follows. */
    async retryEscalated(projectId: string, description: string) {
      if (!catalogProjectIdSchema.safeParse(projectId).success) throw new BrowserRequestError("invalid_request");
      const value = projectOrchestrationDescribeSchemaV1.safeParse({ description });
      if (!value.success) throw new BrowserRequestError("invalid_request");
      return projectOrchestrationRetrySchemaV1.parse(await read(await call(
        `/api/v1/projects/${encodeURIComponent(projectId)}/orchestration-retry`, "POST",
        JSON.stringify(value.data), makeKey())));
    },
    async listSuggestions(projectId: string, batchId: string) {
      return projectOrchestrationSuggestionPageSchemaV1.parse(await read(await call(
        `/api/v1/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(batchId)}/suggestions`, "GET")));
    },
    async useSuggestion(projectId: string, batchId: string, suggestionId: string, expectedRevision: number) {
      return projectOrchestrationSuggestionPrefillSchemaV1.parse(await read(await call(
        `/api/v1/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(batchId)}/suggestions/${encodeURIComponent(suggestionId)}/use`,
        "POST", JSON.stringify({ expectedRevision }))));
    },
    async dismissSuggestion(projectId: string, batchId: string, suggestionId: string, expectedRevision: number) {
      const response = await call(
        `/api/v1/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(batchId)}/suggestions/${encodeURIComponent(suggestionId)}/dismiss`,
        "POST", JSON.stringify({ expectedRevision }));
      if (!response.ok) throw new BrowserRequestError(failure(response.status));
    },
  });
}
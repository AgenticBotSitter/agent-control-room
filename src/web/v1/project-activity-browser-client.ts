import { z } from "zod";
import { projectEventPageSchemaV1, projectEventSchemaV1 } from "../../project-events/v1/schemas";
import type { ProjectEventV1 } from "../../project-events/v1/types";
import { projectWorkspaceDigestSchemaV1 } from "../../project-workspace/v1/schemas";
import { BrowserRequestError } from "./browser-request-error";
import { readBrowserJson } from "./browser-json";
import { catalogProjectIdSchema } from "./project-wire";

const responseSchema = z.object({ page: projectEventPageSchemaV1, olderCursor: z.string().min(1).max(500).nullable() }).strict();
const streamHeadSchema = z.object({ mode: z.enum(["snapshot", "replay", "reset"]),
  nextCursor: z.string().min(1).max(500).nullable(), hasMore: z.boolean(), truncatedBefore: z.boolean(),
  pageDigest: projectWorkspaceDigestSchemaV1 }).strict();

function failure(status: number) {
  return new BrowserRequestError(status === 401 ? "authentication_required" : status === 403 ? "access_denied"
    : status === 404 ? "not_found" : status === 400 ? "invalid_request" : "unavailable");
}

export async function readProjectActivityPageV1(projectId: string, before?: string, transport: typeof fetch = fetch,
  signal?: AbortSignal) {
  try {
    if (!catalogProjectIdSchema.safeParse(projectId).success || before !== undefined && (before.length < 1 || before.length > 500))
      throw new BrowserRequestError("invalid_request");
    signal?.throwIfAborted();
    const query = new URLSearchParams({ limit: "50" }); if (before) query.set("before", before);
    const response = await transport(`/api/v1/projects/${encodeURIComponent(projectId)}/activity?${query}`, {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw failure(response.status);
    const value = responseSchema.parse(await readBrowserJson(response));
    if (value.page.projectId !== projectId || value.page.presentationOnly !== true || value.page.grantsApproval
      || value.page.grantsCommandAuthority || value.page.grantsExecutionAuthority
      || value.page.events.some(event => event.projectId !== projectId)
      || value.olderCursor !== null && !value.page.truncatedBefore) throw new Error();
    return value;
  } catch (error) {
    throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable");
  }
}

export function parseLiveProjectEventV1(value: string, projectId: string): ProjectEventV1 {
  const event = projectEventSchemaV1.parse(JSON.parse(value));
  if (event.projectId !== projectId || !event.presentationOnly || event.grantsApproval
    || event.grantsCommandAuthority || event.grantsExecutionAuthority) throw new Error("project_activity_scope_mismatch");
  return event;
}

export function parseProjectActivityStreamHeadV1(value: string) {
  return streamHeadSchema.parse(JSON.parse(value));
}

/** Exact-once presentation merge. A sequence collision with different signed
 * content is an integrity failure, never a last-write-wins update. */
export function mergeProjectActivityEventsV1(current: readonly ProjectEventV1[], incoming: readonly ProjectEventV1[],
  projectId: string): ProjectEventV1[] {
  const bySequence = new Map<number, ProjectEventV1>();
  for (const event of [...current, ...incoming]) {
    if (event.projectId !== projectId) throw new Error("project_activity_scope_mismatch");
    const prior = bySequence.get(event.sequence);
    if (prior && (prior.eventId !== event.eventId || prior.eventDigest !== event.eventDigest))
      throw new Error("project_activity_sequence_conflict");
    bySequence.set(event.sequence, event);
  }
  const merged = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
  for (let index = 1; index < merged.length; index++) {
    if (merged[index]!.sequence !== merged[index - 1]!.sequence + 1
      || merged[index]!.previousEventDigest !== merged[index - 1]!.eventDigest)
      throw new Error("project_activity_gap");
  }
  return merged;
}

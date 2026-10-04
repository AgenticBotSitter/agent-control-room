import { z } from "zod";
import { actionInboxItemSchemaV1 } from "../../operator-surfaces/v1/validators";

const actionInboxSourceSchema = z.object({
  observedAt: z.string().datetime(),
  items: z.array(actionInboxItemSchemaV1).max(500),
  truncated: z.boolean(),
}).strict();

export type ActionInboxSource = z.infer<typeof actionInboxSourceSchema>;
export type ActionInboxSourceState =
  | { state: "loading" }
  | { state: "available"; source: ActionInboxSource }
  | { state: "unavailable"; source?: ActionInboxSource; code: "authentication_required" | "access_denied" | "not_configured" | "invalid_response" | "request_failed" };

export async function readActionInboxSource(fetcher: typeof fetch = fetch): Promise<ActionInboxSourceState> {
  try {
    const response = await fetcher("/api/v1/needs-me/action-items", {
      method: "GET", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) return { state: "unavailable", code: "authentication_required" };
    if (response.status === 403) return { state: "unavailable", code: "access_denied" };
    // The route answers 404 only when this installation has no Action Inbox source
    // (mac-local-web-process / private-process: `options.actionInboxSource` unset,
    // as on a connector-only Mac host). That is a fact about the installation, not a
    // failed read, so callers must not turn it into a standing "could not check".
    if (response.status === 404) return { state: "unavailable", code: "not_configured" };
    if (!response.ok) return { state: "unavailable", code: "request_failed" };
    const parsed = actionInboxSourceSchema.safeParse(await response.json());
    return parsed.success ? { state: "available", source: parsed.data }
      : { state: "unavailable", code: "invalid_response" };
  } catch {
    return { state: "unavailable", code: "request_failed" };
  }
}

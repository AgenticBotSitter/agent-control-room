import { z } from "zod";
import {
  HERMES_SESSION_TOOLS_V1,
  type HermesSessionToolNameV1,
} from "./session-contract";
import type { HermesSessionToolPortV1 } from "./session-client";

const localServiceIdSchema = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const localSessionBindingSchema = z.object({
  /** A caller-owned label, not a hostname, path, credential, or shell command. */
  localServiceId: localServiceIdSchema,
}).strict();

export type HermesMacosLocalSessionBindingV1 = z.infer<typeof localSessionBindingSchema>;

/**
 * The small, Mac-owned seam between Control Room and a locally installed
 * Hermes Agent. The host implementation owns locating Hermes, its login and
 * its process. This contract intentionally has no endpoint, path, token or
 * model field, so none can leak from Control Room configuration into jobs or
 * browser responses.
 *
 * The supplied call is deliberately one attempt. A transport failure means
 * Control Room cannot know whether Hermes received a submit request; callers
 * must preserve that uncertainty rather than repeat the request.
 */
export interface HermesMacosLocalSessionPrivatePortV1 {
  invoke(input: Readonly<{
    localServiceId: string;
    tool: HermesSessionToolNameV1;
    params: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }>): Promise<unknown>;
}

function unavailable(): never {
  throw new Error("hermes_local_session_transport_unavailable");
}

/**
 * Makes the existing pinned Hermes session client use a local Mac Hermes
 * service. The returned port has exactly the same three operations as the
 * remote/session connector, which keeps task submission, status reads,
 * result publication and owner review on their existing shared paths.
 *
 * This is not a Hermes locator or a live qualification. Supplying the private
 * port is a host integration step, and a real invocation remains separately
 * owner-authorized and evidence-gated.
 */
export function createHermesMacosLocalSessionPortV1(
  bindingValue: unknown,
  privatePort: HermesMacosLocalSessionPrivatePortV1,
): HermesSessionToolPortV1 {
  const binding = Object.freeze(localSessionBindingSchema.parse(bindingValue));
  if (!privatePort || typeof privatePort.invoke !== "function") unavailable();
  const invoke = privatePort.invoke.bind(privatePort);
  return Object.freeze({
    async call(tool: HermesSessionToolNameV1, params: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
      if (!(HERMES_SESSION_TOOLS_V1 as readonly string[]).includes(tool) || signal?.aborted) unavailable();
      const copied = Object.freeze({ ...params });
      return invoke(Object.freeze({ localServiceId: binding.localServiceId, tool, params: copied, signal }));
    },
  });
}

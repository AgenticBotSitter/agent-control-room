import type { Duplex } from "node:stream";
import type { OwnerSigningProtocol } from "./bounded-owner-signature";
import type { OwnedOwnerSigningConnection } from "./owned-owner-signature";
import type { createPrivateOwnerAgentEndpoint } from "./private-owner-agent-endpoint";
import { ownOwnerSigningStream } from "./owner-signing-stream";

/** Unwired composition. openStream must synchronously return ownership of its
 * connection attempt, or clean up before throwing. No ambient agent fallback.
 * The selected protocol sees no bytes until post-connect identity revalidation.
 */
export function openPrivateOwnerAgentConnection(options: {
  endpoint: ReturnType<typeof createPrivateOwnerAgentEndpoint>;
  openStream(path: string): { stream: Duplex; connected: Promise<void> };
  createProtocol(): Duplex & OwnerSigningProtocol;
  signal: AbortSignal;
}): OwnedOwnerSigningConnection {
  const { endpoint, openStream, createProtocol, signal } = options;
  const controller = new AbortController();
  let owned: OwnedOwnerSigningConnection | undefined;
  const unavailable = () => new Error("owner_signature_unavailable");
  const stop = () => { controller.abort(); try { owned?.close(); } catch { /* ready/signing remain refused */ } };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const ready = (async () => {
    try {
      const checked = await endpoint.prepare(controller.signal);
      if (controller.signal.aborted) throw unavailable();
      const stream = openStream(endpoint.socketPath);
      owned = ownOwnerSigningStream({ ...stream, signal: controller.signal, createProtocol,
        connected: Promise.resolve(stream.connected).then(() => checked.recheck()) });
      if (controller.signal.aborted) { owned.close(); throw unavailable(); }
      return await owned.ready;
    } catch {
      stop(); signal.removeEventListener("abort", stop); throw unavailable();
    }
  })();
  void ready.catch(() => {});
  return Object.freeze({ ready, close() {
    controller.abort(); signal.removeEventListener("abort", stop); owned?.close();
  } });
}

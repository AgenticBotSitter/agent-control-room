import { createPublicKey } from "node:crypto";
import { createBoundedOwnerSignature, type OwnerSigningProtocol } from "./bounded-owner-signature";
import { assertSynchronousFence } from "../../security/synchronous-fence";

/** Trusted connector owns its acquisition immediately, before readiness resolves.
 * close must synchronously destroy that acquisition AND its eventual stream; it
 * must not merely abandon a promise. Throwing open must leave no owned resource.
 * This interface does not select sockets, discover keys or establish consent.
 */
export interface OwnedOwnerSigningConnection {
  ready: Promise<OwnerSigningProtocol>;
  close(): void;
}

export function createOwnedOwnerSignature(options: {
  open(signal: AbortSignal): OwnedOwnerSigningConnection;
  publicKeySpki: string;
  timeoutMs: number;
}) {
  const unavailable = (): never => { throw new Error("owner_signature_unavailable"); };
  const { publicKeySpki, timeoutMs, open } = options;
  try {
    if (createPublicKey({ key: Buffer.from(publicKeySpki, "base64url"), format: "der", type: "spki" }).asymmetricKeyType !== "ed25519"
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || typeof open !== "function") unavailable();
  } catch { unavailable(); }
  let attempted = false;
  return Object.freeze({ async sign(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    if (attempted) return unavailable(); attempted = true;
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 24576 || signal.aborted) return unavailable();
    const body = Uint8Array.from(bytes), controller = new AbortController();
    const end = performance.now() + timeoutMs;
    const stop = () => controller.abort();
    let close: (() => void) | undefined, closed = false, closeFailed = false;
    const closeOnce = () => {
      if (!closed && close) {
        closed = true;
        try { assertSynchronousFence(close, unavailable); } catch { closeFailed = true; }
      }
      if (closeFailed) unavailable();
    };
    let rejectStopped: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => { rejectStopped = () => reject(new Error("owner_signature_unavailable")); });
    // An abort can occur synchronously during open, before Promise.race exists.
    void stopped.catch(() => {});
    const onAbort = () => rejectStopped!();
    controller.signal.addEventListener("abort", onAbort, { once: true });
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, timeoutMs);
    const current = () => { if (signal.aborted || controller.signal.aborted || performance.now() >= end) unavailable(); };
    try {
      current();
      const connection = open(controller.signal);
      close = connection.close.bind(connection);
      const ready = Promise.resolve(connection.ready); void ready.catch(() => {});
      current();
      const protocol = await Promise.race([ready, stopped]);
      current();
      const remaining = Math.floor(end - performance.now());
      if (remaining < 1) return unavailable();
      const signer = createBoundedOwnerSignature({ protocol, close: closeOnce, publicKeySpki, timeoutMs: remaining });
      const signature = await Promise.race([signer.sign(body, controller.signal), stopped]);
      current(); return signature;
    } catch { return unavailable(); }
    finally {
      controller.abort(); clearTimeout(timer);
      signal.removeEventListener("abort", stop); controller.signal.removeEventListener("abort", onAbort);
      closeOnce();
    }
  } });
}
